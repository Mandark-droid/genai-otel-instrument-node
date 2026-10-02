import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportedClass, loadModuleCopies, unwrapMethod, wrapMethod } from '../../src/instrumentors/patch';
import { setLogger } from '../../src/logger';

afterEach(() => setLogger(undefined));

describe('wrapMethod / unwrapMethod', () => {
  class Resource {
    create(value: number): number {
      return value + 1;
    }
  }
  const original = Resource.prototype.create;

  afterEach(() => {
    unwrapMethod(Resource.prototype, 'create');
  });

  it('replaces the method and restores it', () => {
    const wrapped = wrapMethod(Resource.prototype, 'create', (inner) => function (this: unknown, value: number) {
      return (inner as (v: number) => number).call(this, value) * 10;
    } as never);
    expect(wrapped).toBe(true);
    expect(new Resource().create(1)).toBe(20);
    unwrapMethod(Resource.prototype, 'create');
    expect(Resource.prototype.create).toBe(original);
    expect(new Resource().create(1)).toBe(2);
  });

  it('never stacks: a method that is already wrapped is left alone', () => {
    const first = vi.fn((inner: (...args: never[]) => unknown) => inner);
    const second = vi.fn((inner: (...args: never[]) => unknown) => inner);
    // The wrapper must be a new function for the marker to distinguish it.
    expect(wrapMethod(Resource.prototype, 'create', (inner) => function (this: unknown, ...args: never[]) {
      first(inner);
      return inner.apply(this, args);
    })).toBe(true);
    expect(wrapMethod(Resource.prototype, 'create', second)).toBe(false);
    expect(second).not.toHaveBeenCalled();
  });

  it('ignores what is not there', () => {
    expect(wrapMethod(Resource.prototype, 'missing', (inner) => inner)).toBe(false);
    expect(wrapMethod(undefined, 'create', (inner) => inner)).toBe(false);
    expect(wrapMethod(null, 'create', (inner) => inner)).toBe(false);
    expect(() => unwrapMethod(undefined, 'create')).not.toThrow();
    expect(() => unwrapMethod(Resource.prototype, 'missing')).not.toThrow();
    // Unwrapping a method that was never wrapped changes nothing.
    unwrapMethod(Resource.prototype, 'create');
    expect(Resource.prototype.create).toBe(original);
  });
});

describe('exportedClass', () => {
  class Client {}

  it('finds the class in an ES-module namespace, a CommonJS export function, or takes the class itself', () => {
    expect(exportedClass({ OpenAI: Client }, 'OpenAI')).toBe(Client);
    expect(exportedClass({ default: Client }, 'OpenAI')).toBe(Client);
    // The CommonJS builds export a function that carries the named exports.
    const commonjs = Object.assign(function entry() {}, { OpenAI: Client });
    expect(exportedClass(commonjs, 'OpenAI')).toBe(Client);
    expect(exportedClass(Client, 'OpenAI')).toBe(Client);
  });

  it('is undefined for what cannot hold a class', () => {
    expect(exportedClass(undefined, 'OpenAI')).toBeUndefined();
    expect(exportedClass(null, 'OpenAI')).toBeUndefined();
    expect(exportedClass('openai', 'OpenAI')).toBeUndefined();
    expect(exportedClass({ OpenAI: 'not a class' }, 'OpenAI')).toBeUndefined();
  });
});

describe('loadModuleCopies', () => {
  it('finds both builds of an installed SDK, as separate module objects', async () => {
    const copies = loadModuleCopies('openai');
    expect(copies.commonjs).toHaveLength(1);
    const esm = await copies.esm;
    expect(esm).toHaveLength(1);
    const commonjsClass = exportedClass(copies.commonjs[0], 'OpenAI');
    const esmClass = exportedClass(esm[0], 'OpenAI');
    expect(typeof commonjsClass).toBe('function');
    expect(typeof esmClass).toBe('function');
    expect(commonjsClass).not.toBe(esmClass);
  });

  it('a package that is not installed yields nothing, quietly', async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    setLogger(log);
    const copies = loadModuleCopies('@traceverse/definitely-not-installed');
    expect(copies.commonjs).toEqual([]);
    await expect(copies.esm).resolves.toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalled();
  });

  it('a package with no ES-module build yields only the CommonJS one', async () => {
    const copies = loadModuleCopies('@opentelemetry/api');
    expect(copies.commonjs).toHaveLength(1);
    await expect(copies.esm).resolves.toEqual([]);
  });
});

describe('a package subpath', () => {
  it('yields the CommonJS file and, through the exports map, the ES-module one', async () => {
    const copies = loadModuleCopies('@modelcontextprotocol/sdk/client/index.js');
    expect(copies.commonjs.length).toBeGreaterThanOrEqual(1);
    const esm = await copies.esm;
    expect(esm.length).toBeGreaterThanOrEqual(1);
    const commonjsClients = copies.commonjs.map((module) => (module as { Client?: unknown }).Client);
    const esmClient = (esm[0] as { Client?: unknown }).Client;
    expect(typeof esmClient).toBe('function');
    // A different class object: patching one build would leave the other untraced.
    expect(commonjsClients).not.toContain(esmClient);
  });
});

describe('two owners on one method', () => {
  const make = (tag: string, log: string[]) => (original: (...args: never[]) => unknown) =>
    function (this: unknown, ...args: unknown[]) {
      log.push(tag);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };

  it('each owner wraps once; removal in any order leaves the original', () => {
    const log: string[] = [];
    const original = (): string => 'value';
    const holder = { method: original };
    expect(wrapMethod(holder, 'method', make('a', log), 'a')).toBe(true);
    expect(wrapMethod(holder, 'method', make('b', log), 'b')).toBe(true);
    expect(wrapMethod(holder, 'method', make('a2', log), 'a')).toBe(false);
    expect(holder.method()).toBe('value');
    expect(log).toEqual(['b', 'a']);

    // The buried one first: it cannot be cut out, so it is retired...
    unwrapMethod(holder, 'method', 'a');
    // ...and the owner may wrap again.
    expect(wrapMethod(holder, 'method', make('a3', log), 'a')).toBe(true);
    unwrapMethod(holder, 'method', 'a');
    unwrapMethod(holder, 'method', 'b');
    expect(holder.method).toBe(original);
  });

  it('removing an owner that never wrapped changes nothing', () => {
    const holder = { method: (): number => 1 };
    wrapMethod(holder, 'method', make('a', []), 'a');
    const wrapped = holder.method;
    unwrapMethod(holder, 'method', 'nobody');
    expect(holder.method).toBe(wrapped);
  });
});

describe('loadModuleCopies: a library that cannot run on this runtime', () => {
  it('does not import the ES-module build when the CommonJS build threw while loading', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'genai-otel-broken-'));
    const dir = join(root, 'node_modules', 'broken-on-this-runtime');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'broken-on-this-runtime', version: '1.0.0', main: 'index.js' }));
    // What a library built for a newer runtime does: fail on a global that is not there.
    writeFileSync(join(dir, 'index.js'), 'module.exports = NotDefinedOnThisRuntime;');
    writeFileSync(join(dir, 'index.mjs'), 'globalThis.__brokenEsmEvaluated = true; export default NotDefinedOnThisRuntime;');
    const before = process.cwd();
    process.chdir(root);
    try {
      const copies = loadModuleCopies('broken-on-this-runtime');
      expect(copies.commonjs).toEqual([]);
      expect(await copies.esm).toEqual([]);
      expect((globalThis as { __brokenEsmEvaluated?: boolean }).__brokenEsmEvaluated).toBeUndefined();
    } finally {
      process.chdir(before);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('loadModuleCopies: a library that must be loaded once', () => {
  // Some libraries (llamaindex) refuse to be loaded as CommonJS and as an ES
  // module in one process. For those, only the copy the application uses is loaded.
  async function withPackage(run: (root: string) => Promise<void>): Promise<void> {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'genai-otel-single-'));
    const dir = join(root, 'node_modules', 'load-me-once');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'load-me-once', version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), 'globalThis.__onceLoads = (globalThis.__onceLoads || []).concat("cjs"); module.exports = { kind: "cjs" };');
    writeFileSync(join(dir, 'index.mjs'), 'globalThis.__onceLoads = (globalThis.__onceLoads || []).concat("esm"); export const kind = "esm";');
    writeFileSync(join(root, 'app.cjs'), '');
    writeFileSync(join(root, 'app.mjs'), '');
    const before = process.cwd();
    const argv1 = process.argv[1];
    process.chdir(root);
    try {
      delete (globalThis as { __onceLoads?: string[] }).__onceLoads;
      await run(root);
    } finally {
      process.argv[1] = argv1 as string;
      process.chdir(before);
      rmSync(root, { recursive: true, force: true });
    }
  }
  const loads = (): string[] | undefined => (globalThis as { __onceLoads?: string[] }).__onceLoads;

  it('a CommonJS application: the CommonJS copy only', async () => {
    await withPackage(async (root) => {
      const { join } = await import('node:path');
      process.argv[1] = join(root, 'app.cjs');
      const copies = loadModuleCopies('load-me-once', { single: true });
      expect(copies.commonjs).toHaveLength(1);
      expect(await copies.esm).toEqual([]);
      expect(loads()).toEqual(['cjs']);
    });
  });

  it('an ES-module application: the ES-module copy only', async () => {
    await withPackage(async (root) => {
      const { join } = await import('node:path');
      process.argv[1] = join(root, 'app.mjs');
      const copies = loadModuleCopies('load-me-once', { single: true });
      expect(copies.commonjs).toEqual([]);
      expect(await copies.esm).toHaveLength(1);
      expect(loads()).toEqual(['esm']);
    });
  });

  it('without the option both copies are loaded, as for every other library', async () => {
    await withPackage(async (root) => {
      const { join } = await import('node:path');
      process.argv[1] = join(root, 'app.cjs');
      const copies = loadModuleCopies('load-me-once');
      await copies.esm;
      expect(loads()?.sort()).toEqual(['cjs', 'esm']);
    });
  });
});

describe('loadModuleCopies: a type-module package with a .cjs CommonJS build', () => {
  it('imports the ES-module build once and does not import the .cjs file as a second ES-module copy', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'genai-otel-dual-'));
    const dir = join(root, 'node_modules', 'dual-type-module');
    mkdirSync(join(dir, 'dist', 'cjs'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'dual-type-module',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { import: { default: './dist/index.js' }, require: { default: './dist/cjs/index.cjs' } } },
      }),
    );
    writeFileSync(join(dir, 'dist', 'cjs', 'index.cjs'), 'globalThis.__dualLoads = (globalThis.__dualLoads || 0) + 1; module.exports = { kind: "cjs" };');
    writeFileSync(join(dir, 'dist', 'index.js'), 'export const kind = "esm";');
    const before = process.cwd();
    process.chdir(root);
    try {
      const copies = loadModuleCopies('dual-type-module');
      expect(copies.commonjs).toHaveLength(1);
      const esm = (await copies.esm) as { kind?: string }[];
      expect(esm.map((module) => module.kind)).toEqual(['esm']);
    } finally {
      process.chdir(before);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
