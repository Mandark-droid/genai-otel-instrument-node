/**
 * Client libraries are patched when they are loaded, not loaded in order to be
 * patched: `instrument()` must not pay for libraries the application never uses.
 *
 * Packages are written to a temporary `node_modules` so that what gets
 * evaluated, and when, can be observed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadModuleCopies, watchedPackageCount } from '../../src/instrumentors/patch';

interface Loads {
  __lazyLoads?: string[];
}
const loads = (): string[] => (globalThis as Loads).__lazyLoads ?? [];

let root: string;
let before: string;
let argv1: string | undefined;
const disposers: (() => void)[] = [];

function writePackage(name: string, files: Record<string, string>, manifest: Record<string, unknown> = {}): void {
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js', ...manifest }));
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
}

const record = (tag: string): string => `globalThis.__lazyLoads = (globalThis.__lazyLoads || []).concat(${JSON.stringify(tag)});`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genai-otel-lazy-'));
  writeFileSync(join(root, 'app.cjs'), '');
  writeFileSync(join(root, 'app.mjs'), '');
  before = process.cwd();
  argv1 = process.argv[1];
  process.chdir(root);
  process.argv[1] = join(root, 'app.cjs');
  delete (globalThis as Loads).__lazyLoads;
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  process.chdir(before);
  process.argv[1] = argv1 as string;
  rmSync(root, { recursive: true, force: true });
});

/** `require` as the application at `root` would. */
const appRequire = (): NodeRequire => createRequire(join(root, 'app.cjs'));

describe('CommonJS: patched on load', () => {
  it('locating a package does not load its CommonJS build', async () => {
    writePackage('lazy-a', { 'index.js': `${record('lazy-a cjs')} module.exports = { kind: 'cjs' };` });
    const copies = loadModuleCopies('lazy-a');
    disposers.push(copies.whenLoaded(() => undefined));
    expect(copies.commonjs).toEqual([]);
    await copies.esm;
    expect(loads()).toEqual([]);
  });

  it('the listener is called with the module when the application requires it, by name', () => {
    writePackage('lazy-b', { 'index.js': `${record('lazy-b cjs')} module.exports = { kind: 'cjs' };` });
    const seen: unknown[] = [];
    disposers.push(loadModuleCopies('lazy-b').whenLoaded((module) => seen.push(module)));
    const loaded = appRequire()('lazy-b') as { kind: string };
    expect(loaded.kind).toBe('cjs');
    expect(seen).toEqual([loaded]);
    // A second require gives the cached module; the listener hears of it again, harmlessly.
    appRequire()('lazy-b');
    expect(seen.every((module) => module === loaded)).toBe(true);
    expect(loads()).toEqual(['lazy-b cjs']);
  });

  it('a CommonJS package imported from an ES module is heard of too', async () => {
    writePackage('lazy-c', { 'index.js': `${record('lazy-c cjs')} module.exports = { kind: 'cjs' };` });
    const seen: unknown[] = [];
    disposers.push(loadModuleCopies('lazy-c').whenLoaded((module) => seen.push(module)));
    writeFileSync(join(root, 'importer.mjs'), `import pkg from 'lazy-c'; export default pkg;`);
    const namespace = (await import(pathToFileURL(join(root, 'importer.mjs')).href)) as { default: { kind: string } };
    expect(namespace.default.kind).toBe('cjs');
    expect(seen).toEqual([namespace.default]);
  });

  it('a package the application loaded before is available at once', () => {
    writePackage('lazy-d', { 'index.js': `module.exports = { kind: 'cjs' };` });
    const loaded: unknown = appRequire()('lazy-d');
    const copies = loadModuleCopies('lazy-d');
    disposers.push(copies.whenLoaded(() => undefined));
    expect(copies.commonjs).toEqual([loaded]);
  });

  it('a subpath is watched as the application writes it', () => {
    writePackage('@scope/lazy-e', { 'index.js': 'module.exports = {};', 'sub.js': `module.exports = { kind: 'sub' };` });
    const seen: unknown[] = [];
    disposers.push(loadModuleCopies('@scope/lazy-e/sub.js').whenLoaded((module) => seen.push(module)));
    appRequire()('@scope/lazy-e');
    expect(seen).toEqual([]);
    const sub: unknown = appRequire()('@scope/lazy-e/sub.js');
    expect(seen).toEqual([sub]);
  });

  it('after the listener is removed nothing is heard, and other loads are untouched', () => {
    writePackage('lazy-f', { 'index.js': `module.exports = { kind: 'cjs' };` });
    const seen: unknown[] = [];
    const watching = watchedPackageCount();
    const dispose = loadModuleCopies('lazy-f').whenLoaded((module) => seen.push(module));
    expect(watchedPackageCount()).toBeGreaterThan(watching);
    dispose();
    dispose();
    expect(watchedPackageCount()).toBe(watching);
    appRequire()('lazy-f');
    expect(seen).toEqual([]);
    // The hook leaves every other require as it was.
    expect((appRequire()('node:path') as { sep: string }).sep).toBe(join('a', 'b')[1]);
  });

  it('a listener that throws does not break the application\'s require', () => {
    writePackage('lazy-g', { 'index.js': `module.exports = { kind: 'cjs' };` });
    disposers.push(
      loadModuleCopies('lazy-g').whenLoaded(() => {
        throw new Error('patching failed');
      }),
    );
    expect((appRequire()('lazy-g') as { kind: string }).kind).toBe('cjs');
  });

  it('a package that throws while loading throws to the application as it would have, and is not our business', () => {
    writePackage('lazy-h', { 'index.js': 'throw new Error("cannot run here");' });
    const seen: unknown[] = [];
    disposers.push(loadModuleCopies('lazy-h').whenLoaded((module) => seen.push(module)));
    expect(() => appRequire()('lazy-h')).toThrow('cannot run here');
    expect(seen).toEqual([]);
  });
});

describe('ES modules', () => {
  it('an ES-module application: the ES-module build is imported and offered; the CommonJS build is not loaded', async () => {
    writePackage('lazy-i', { 'index.js': `${record('lazy-i cjs')} module.exports = { kind: 'cjs' };`, 'index.mjs': `${record('lazy-i esm')} export const kind = 'esm';` });
    process.argv[1] = join(root, 'app.mjs');
    const copies = loadModuleCopies('lazy-i');
    disposers.push(copies.whenLoaded(() => undefined));
    const esm = (await copies.esm) as { kind: string }[];
    expect(esm.map((module) => module.kind)).toEqual(['esm']);
    expect(loads()).toEqual(['lazy-i esm']);
  });

  it('a CommonJS application: the ES-module build is not imported', async () => {
    writePackage('lazy-j', { 'index.js': `${record('lazy-j cjs')} module.exports = { kind: 'cjs' };`, 'index.mjs': `${record('lazy-j esm')} export const kind = 'esm';` });
    const copies = loadModuleCopies('lazy-j');
    disposers.push(copies.whenLoaded(() => undefined));
    expect(await copies.esm).toEqual([]);
    expect(loads()).toEqual([]);
  });

  it('a package that is not installed yields nothing and watches nothing', async () => {
    const watching = watchedPackageCount();
    const copies = loadModuleCopies('@traceverse/definitely-not-installed');
    disposers.push(copies.whenLoaded(() => undefined));
    expect(copies.commonjs).toEqual([]);
    expect(await copies.esm).toEqual([]);
    expect(watchedPackageCount()).toBe(watching);
  });
});
