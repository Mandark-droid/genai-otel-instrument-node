/**
 * Configuration contract: every environment variable the Python library reads,
 * with the value it produced for each raw input (contract/config.json).
 *
 * Imports the runtime-agnostic core only, so it also runs in the browser-like
 * project. The variables only the Node entry reads are in
 * config-node.contract.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import contract from '../../contract/config.json';
import {
  CONFIG_FIELDS,
  ConfigError,
  CONTENT_CAPTURE_MODES,
  HARDENED_PROFILES,
  loadConfig,
  OTEL_GENAI_CAPTURE_MESSAGE_CONTENT,
  type OTelConfig,
} from '../../src/config';
import { setLogger } from '../../src/logger';

interface Case {
  raw: string | null;
  parsed?: unknown;
  error?: { type: string; message: string };
}
interface Reader {
  module: string;
  scope: string;
  expression: string;
  cases?: Case[];
}
interface Variable {
  env: string;
  type: string;
  default: unknown;
  extraction: string;
  otel_config_fields: string[];
  cases: Case[];
  readers: Reader[];
}

const variables = contract.variables as unknown as Variable[];
const camel = (snake: string): keyof OTelConfig =>
  snake.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase()) as keyof OTelConfig;

/** Contract JSON spells non-finite floats out; null means "unset" (undefined here). */
function fromContract(value: unknown): unknown {
  if (value === null) return undefined;
  if (typeof value === 'object' && value !== null && 'non_finite_float' in value) {
    const kind = (value as { non_finite_float: string }).non_finite_float;
    return kind === 'nan' ? Number.NaN : kind === 'inf' ? Infinity : -Infinity;
  }
  return value;
}

function expectSame(actual: unknown, expected: unknown): void {
  const want = fromContract(expected);
  if (typeof want === 'number' && Number.isNaN(want)) expect(Number.isNaN(actual as number)).toBe(true);
  else expect(actual).toEqual(want);
}

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => setLogger(quiet));
afterEach(() => setLogger(undefined));

const configVariables = variables.filter((variable) => variable.extraction === 'runtime:OTelConfig');
const knownEnv = new Set([...CONFIG_FIELDS.map((field) => field.env), OTEL_GENAI_CAPTURE_MESSAGE_CONTENT]);

describe('OTelConfig variables', () => {
  it('this SDK reads every environment variable an OTelConfig field reads', () => {
    const missing = configVariables.map((variable) => variable.env).filter((env) => !knownEnv.has(env));
    expect(missing).toEqual([]);
  });

  it('and declares none that the reference implementation does not have', () => {
    const reference = new Set(configVariables.map((variable) => variable.env));
    expect([...knownEnv].filter((env) => !reference.has(env))).toEqual([]);
  });

  describe.each(configVariables.map((variable) => [variable.env, variable] as const))('%s', (_env, variable) => {
    const field = camel(variable.otel_config_fields[0] ?? '');

    it('maps to a field of this SDK', () => {
      expect(variable.otel_config_fields).toHaveLength(1);
      expect(field in loadConfig({}, {})).toBe(true);
    });

    it('default', () => {
      expectSame(loadConfig({}, {})[field], variable.default);
    });

    it.each(variable.cases.map((entry) => [JSON.stringify(entry.raw), entry] as const))('raw %s', (_raw, entry) => {
      const env = { [variable.env]: entry.raw ?? undefined };
      if (entry.error) {
        // OTelConfig() raised; so does loadConfig(), naming the variable.
        expect(entry.error.type).toBe('ValueError');
        expect(() => loadConfig({}, env)).toThrow(ConfigError);
        expect(() => loadConfig({}, env)).toThrow(variable.env);
      } else {
        expectSame(loadConfig({}, env)[field], entry.parsed);
      }
    });
  });
});

describe('otel_config_defaults', () => {
  const defaults = contract.otel_config_defaults as Record<string, unknown>;
  const config = loadConfig({}, {}) as unknown as Record<string, unknown>;

  it.each(Object.keys(defaults))('%s', (name) => {
    const field = camel(name);
    expect(field in config).toBe(true);
    expectSame(config[field], defaults[name]);
  });

  it('this SDK has no configuration field the reference implementation lacks', () => {
    const reference = new Set(Object.keys(defaults).map((name) => camel(name) as string));
    expect(Object.keys(config).filter((field) => !reference.has(field))).toEqual([]);
  });
});

describe('profile and content-capture interactions', () => {
  const interactions = contract.interactions as { env: Record<string, string | null>; resolved: Record<string, boolean> }[];

  it.each(interactions.map((entry, index) => [index, JSON.stringify(entry.env), entry] as const))(
    '#%i %s',
    (_index, _label, entry) => {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(entry.env)) if (value !== null) env[name] = value;
      const config = loadConfig({}, env) as unknown as Record<string, unknown>;
      for (const [name, expected] of Object.entries(entry.resolved)) expect(config[camel(name)], name).toBe(expected);
    },
  );

  it('content capture modes and hardening profiles are the same sets', () => {
    expect(CONTENT_CAPTURE_MODES).toEqual(contract.content_capture_modes);
    expect([...HARDENED_PROFILES].sort()).toEqual(contract.hardening_profiles);
  });
});

/**
 * Every other variable in the contract, with the reason this SDK does not read
 * it yet. A variable that appears in a future contract and is in neither list
 * fails this test, so a bump of the pinned tag cannot add one unnoticed.
 */
const NOT_READ: Record<string, string> = {
  CREWAI_DISABLE_TELEMETRY: 'CrewAI is Python-only',
  CREWAI_TELEMETRY_OPT_OUT: 'CrewAI is Python-only',
  ENVIRONMENT: 'read only by the legacy config.setup_tracing(), which instrument() does not use',
  GENAI_DETOXIFY_MODEL_PATH: 'Detoxify is a Python ML backend; toxicity is measured by a scorer the application supplies',
  GENAI_TOXICITY_DETOXIFY_PATH: 'Detoxify is a Python ML backend; toxicity is measured by a scorer the application supplies',
  HAYSTACK_AUTO_TRACE_ENABLED: 'Haystack is Python-only',
  HF_HUB_OFFLINE: 'Hugging Face model downloads are a Python ML backend concern; no model is downloaded here',
  OTEL_METRICS_EXEMPLAR_FILTER: 'the OpenTelemetry JS SDK records no exemplars, so there is nothing to switch off',
  OTEL_PROPAGATORS:
    'Python skips installing its propagator when this is set, because the Python SDK already built one from it at ' +
    'import; the OpenTelemetry JS API builds none, so instrument() always installs trace context (plus session baggage)',
  OTEL_PYTHON_REQUESTS_EXCLUDED_URLS:'Python `requests` instrumentation only',
  TRACEVERDE_TELEMETRY: 'anonymous usage reporting is not ported: this SDK makes no call home',
  TRACEVERDE_TELEMETRY_URL: 'anonymous usage reporting is not ported: this SDK makes no call home',
  TRANSFORMERS_OFFLINE: 'Hugging Face model downloads are a Python ML backend concern; no model is downloaded here',
  TYPESAFE_DEFAULT_MODEL: 'TypeSafe instrumentor, phase 2',
};
const READ_OUTSIDE_CONFIG = [
  'GENAI_ENABLE_OLLAMA_SERVER_METRICS',
  'GENAI_OLLAMA_MAX_VRAM_GB',
  'GENAI_OLLAMA_METRICS_INTERVAL',
  'OLLAMA_BASE_URL',
  'GENAI_MCP_HASH_SALT',
  'GENAI_OTEL_LOG_LEVEL',
  'GENAI_OTEL_RESOURCE_HOST_IP',
  'GENAI_SERVICE_INSTANCE_ID_MODE',
  'GENAI_SKIP_COLLECTOR_CHECK',
  'OTEL_ENVIRONMENT',
  'OTEL_EXPERIMENTAL_RESOURCE_DETECTORS',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_SERVICE_INSTANCE_ID',
];

describe('coverage of the contract', () => {
  it('every variable is implemented or listed with the reason it is not', () => {
    const accounted = new Set([...knownEnv, ...READ_OUTSIDE_CONFIG, ...Object.keys(NOT_READ)]);
    expect(variables.map((variable) => variable.env).filter((env) => !accounted.has(env))).toEqual([]);
  });

  it('the not-read list names only variables that exist in the contract', () => {
    const all = new Set(variables.map((variable) => variable.env));
    expect(Object.keys(NOT_READ).filter((env) => !all.has(env))).toEqual([]);
  });
});
