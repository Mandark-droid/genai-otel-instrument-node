/**
 * Configuration contract, Node-only part: the variables read outside OTelConfig
 * by the Node entry (exporter protocol, collector check, resource identity).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import contract from '../../contract/config.json';
import { otlpProtocolFromEnv, skipCollectorCheck } from '../../src/auto-instrument';
import { setLogger } from '../../src/logger';
import { buildResource, resetGeneratedInstanceId } from '../../src/resource';

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
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => setLogger(quiet));
afterEach(() => setLogger(undefined));

/** Variables read outside OTelConfig that this phase implements. */
describe('variables read outside OTelConfig', () => {
  const find = (env: string): Variable => {
    const variable = variables.find((candidate) => candidate.env === env);
    if (!variable) throw new Error(`${env} is not in the contract`);
    return variable;
  };
  const RESOURCE_ENV = [
    'GENAI_SERVICE_INSTANCE_ID_MODE',
    'OTEL_EXPERIMENTAL_RESOURCE_DETECTORS',
    'OTEL_ENVIRONMENT',
    'OTEL_SERVICE_INSTANCE_ID',
    'OTEL_RESOURCE_ATTRIBUTES',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of RESOURCE_ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    resetGeneratedInstanceId();
  });
  afterEach(() => {
    for (const name of RESOURCE_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it.each(find('GENAI_SKIP_COLLECTOR_CHECK').cases.map((entry) => [JSON.stringify(entry.raw), entry] as const))(
    'GENAI_SKIP_COLLECTOR_CHECK raw %s',
    (_raw, entry) => {
      expect(skipCollectorCheck({ GENAI_SKIP_COLLECTOR_CHECK: entry.raw ?? undefined })).toBe(entry.parsed);
    },
  );

  it('GENAI_SKIP_COLLECTOR_CHECK default', () => {
    expect(skipCollectorCheck({})).toBe(find('GENAI_SKIP_COLLECTOR_CHECK').default);
  });

  it.each(find('OTEL_EXPORTER_OTLP_PROTOCOL').cases.map((entry) => [JSON.stringify(entry.raw), entry] as const))(
    'OTEL_EXPORTER_OTLP_PROTOCOL raw %s',
    (_raw, entry) => {
      expect(otlpProtocolFromEnv({ OTEL_EXPORTER_OTLP_PROTOCOL: entry.raw ?? undefined })).toBe(entry.parsed);
    },
  );

  it('OTEL_EXPORTER_OTLP_PROTOCOL default', () => {
    expect(otlpProtocolFromEnv({})).toBe(find('OTEL_EXPORTER_OTLP_PROTOCOL').default);
  });

  const instanceIdKinds = find('GENAI_SERVICE_INSTANCE_ID_MODE').readers.find((reader) => reader.scope === '<reader function>');
  it.each((instanceIdKinds?.cases ?? []).map((entry) => [JSON.stringify(entry.raw), entry] as const))(
    'GENAI_SERVICE_INSTANCE_ID_MODE raw %s -> kind of instance id',
    (_raw, entry) => {
      if (entry.raw !== null) process.env.GENAI_SERVICE_INSTANCE_ID_MODE = entry.raw;
      const id = String(buildResource('contract-service', '0.0.0-contract').attributes['service.instance.id']);
      expect({ '4': 'random_uuid4', '5': 'derived_uuid5' }[id[14] ?? '']).toBe(entry.parsed);
    },
  );

  it.each(find('OTEL_EXPERIMENTAL_RESOURCE_DETECTORS').cases.map((entry) => [JSON.stringify(entry.raw), entry] as const))(
    'OTEL_EXPERIMENTAL_RESOURCE_DETECTORS raw %s -> process detector enabled',
    (_raw, entry) => {
      process.env.OTEL_EXPERIMENTAL_RESOURCE_DETECTORS = entry.raw ?? '';
      const attributes = buildResource('contract-service', '0.0.0-contract').attributes;
      expect('process.command_args' in attributes).toBe(entry.parsed);
    },
  );

  it.each(find('OTEL_ENVIRONMENT').cases.map((entry) => [JSON.stringify(entry.raw), entry] as const))(
    'OTEL_ENVIRONMENT raw %s',
    (_raw, entry) => {
      process.env.OTEL_ENVIRONMENT = entry.raw ?? '';
      const attributes = buildResource('contract-service', '0.0.0-contract').attributes;
      // An empty value is read as unset by the statement that follows the read.
      expect(attributes['deployment.environment.name']).toBe(entry.parsed === '' ? undefined : entry.parsed);
      expect(attributes.environment).toBe(entry.parsed === '' ? undefined : entry.parsed);
    },
  );

  it.each(find('OTEL_SERVICE_INSTANCE_ID').cases.map((entry) => [JSON.stringify(entry.raw), entry] as const))(
    'OTEL_SERVICE_INSTANCE_ID raw %s',
    (_raw, entry) => {
      process.env.OTEL_SERVICE_INSTANCE_ID = entry.raw ?? '';
      const id = buildResource('contract-service', '0.0.0-contract').attributes['service.instance.id'];
      if (entry.parsed === '') expect(String(id)).toMatch(/^[0-9a-f-]{36}$/);
      else expect(id).toBe(entry.parsed);
    },
  );
});
