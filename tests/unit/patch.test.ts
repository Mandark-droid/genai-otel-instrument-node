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
