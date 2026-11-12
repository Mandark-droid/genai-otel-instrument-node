import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FIELDS,
  DEFAULT_EVALUATION_QUEUE_SIZE,
  DEFAULT_EVALUATION_SHUTDOWN_TIMEOUT,
  EVALUATION_MODE_BACKGROUND,
  loadConfig,
  parseConfigField,
  type ConfigField,
} from '../../src/config';
import { setLogger } from '../../src/logger';

/** Coercion of explicit options and of numbers in the environment, as `OTelConfig.__post_init__` does. */

const warnings: string[] = [];
const quiet = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message: string) => {
    warnings.push(message);
  },
  error: () => undefined,
};

afterEach(() => {
  warnings.length = 0;
  setLogger(undefined);
});

describe('explicit option coercion', () => {
  it('reads Python-style booleans and numbers for the evaluation queue size', () => {
    expect(loadConfig({ evaluationQueueSize: true as unknown as number }, {}).evaluationQueueSize).toBe(1);
    expect(loadConfig({ evaluationQueueSize: 7.9 }, {}).evaluationQueueSize).toBe(7);
    expect(loadConfig({ evaluationQueueSize: Number.POSITIVE_INFINITY }, {}).evaluationQueueSize).toBe(
      DEFAULT_EVALUATION_QUEUE_SIZE,
    );
    expect(loadConfig({ evaluationQueueSize: {} as unknown as number }, {}).evaluationQueueSize).toBe(
      DEFAULT_EVALUATION_QUEUE_SIZE,
    );
  });

  it('turns a missing or empty evaluation mode into the default without a warning', () => {
    setLogger(quiet);
    expect(loadConfig({ evaluationMode: undefined }, {}).evaluationMode).toBe(EVALUATION_MODE_BACKGROUND);
    expect(loadConfig({ evaluationMode: null as unknown as string }, {}).evaluationMode).toBe(EVALUATION_MODE_BACKGROUND);
    expect(warnings).toEqual([]);
  });

  it('reads booleans as 1 and 0 seconds for the evaluation shutdown timeout', () => {
    expect(loadConfig({ evaluationShutdownTimeout: true as unknown as number }, {}).evaluationShutdownTimeout).toBe(1);
    expect(loadConfig({ evaluationShutdownTimeout: false as unknown as number }, {}).evaluationShutdownTimeout).toBe(0);
    expect(loadConfig({ evaluationShutdownTimeout: 'soon' as unknown as number }, {}).evaluationShutdownTimeout).toBe(
      DEFAULT_EVALUATION_SHUTDOWN_TIMEOUT,
    );
  });

  it('accepts only whole positive counts for toxicity threads', () => {
    expect(loadConfig({ toxicityTorchThreads: '3' as unknown as number }, {}).toxicityTorchThreads).toBe(3);
    expect(loadConfig({ toxicityTorchThreads: 'many' as unknown as number }, {}).toxicityTorchThreads).toBeUndefined();
    expect(loadConfig({ toxicityTorchThreads: true as unknown as number }, {}).toxicityTorchThreads).toBeUndefined();
    expect(loadConfig({ toxicityTorchThreads: 0 }, {}).toxicityTorchThreads).toBeUndefined();
  });
});

describe('numbers from the environment', () => {
  const orDefault = CONFIG_FIELDS.filter((f) => f.kind === 'int_or_default' || f.kind === 'float_or_default');

  it('has fields that fall back to their default', () => {
    expect(orDefault.length).toBeGreaterThan(0);
  });

  it.each(orDefault.map((f) => [f.env, f] as const))('%s: garbage warns and means the default', (_env, field) => {
    setLogger(quiet);
    const fallback = parseConfigField(field, {});
    expect(parseConfigField(field, { [field.env]: 'not-a-number' })).toBe(fallback);
    expect(warnings.some((w) => w.includes(field.env))).toBe(true);
  });

  it('a field with no default falls back to zero', () => {
    const base = orDefault[0] as ConfigField;
    const field = { ...base, default: undefined } as ConfigField;
    expect(parseConfigField(field, { [field.env]: '  ' })).toBe(0);
  });

  it('a non-Error thrown by a parser is still reported with the variable name', () => {
    const intField = CONFIG_FIELDS.find((f) => f.kind === 'int') as ConfigField;
    expect(intField).toBeDefined();
    expect(() => parseConfigField(intField, { [intField.env]: 'twelve' })).toThrow(intField.env);
  });
});
