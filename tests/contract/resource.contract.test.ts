/**
 * Resource contract: the attribute set `genai_otel.resource.build_resource()`
 * produces (contract/semconv.json, section `resource`).
 *
 * The three identity attributes differ from the Python values on purpose - they
 * are how a backend tells the SDKs apart. Everything else is the same set.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import contract from '../../contract/semconv.json';
import { buildResource, DISTRO_NAME, redactCommandArgs, resetGeneratedInstanceId, uuidV5 } from '../../src/resource';

const resource = contract.resource;
const ENV_KEYS = [
  'OTEL_SERVICE_INSTANCE_ID',
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_ENVIRONMENT',
  'OTEL_EXPERIMENTAL_RESOURCE_DETECTORS',
  'GENAI_SERVICE_INSTANCE_ID_MODE',
];

/** The Python values, with this SDK's identity substituted. */
function expectedFixed(fixed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fixed };
  out['telemetry.sdk.language'] = 'nodejs';
  out['telemetry.distro.name'] = `${resource.distro_name}-node`;
  out['telemetry.auto.name'] = `${resource.distro_name}-node`;
  return out;
}

/** `host.ip` exists only on a host with a non-loopback interface. */
const withoutHostIp = (keys: string[]): string[] => keys.filter((key) => key !== 'host.ip').sort();

describe('resource contract', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    resetGeneratedInstanceId();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('distro name is the reference name with the language suffix', () => {
    expect(DISTRO_NAME).toBe(`${resource.distro_name}-node`);
  });

  it.each([
    ['default', {}, '', resource.default],
    ['with_otel_environment', { OTEL_ENVIRONMENT: 'prod' }, '', resource.with_otel_environment],
    ['hardened_profile', {}, 'bank', resource.hardened_profile],
  ] as const)('%s: same keys, same fixed values', (_name, env, profile, expected) => {
    Object.assign(process.env, env);
    const attributes = buildResource('contract-service', '0.0.0-contract', profile).attributes;
    expect(withoutHostIp(Object.keys(attributes))).toEqual(withoutHostIp(expected.keys));
    for (const [key, value] of Object.entries(expectedFixed(expected.fixed_values))) {
      expect(attributes[key], key).toBe(value);
    }
  });

  it('with OTEL_SERVICE_INSTANCE_ID: same keys', () => {
    process.env.OTEL_SERVICE_INSTANCE_ID = 'pod-7';
    const attributes = buildResource('contract-service', '0.0.0-contract').attributes;
    expect(withoutHostIp(Object.keys(attributes))).toEqual(withoutHostIp(resource.with_otel_service_instance_id));
    expect(attributes['service.instance.id']).toBe('pod-7');
  });

  it('default and hardened detector lists', () => {
    buildResource('contract-service', '0.0.0-contract');
    expect(process.env.OTEL_EXPERIMENTAL_RESOURCE_DETECTORS).toBe(resource.default_detectors);
    delete process.env.OTEL_EXPERIMENTAL_RESOURCE_DETECTORS;
    for (const profile of resource.hardened_profiles) {
      buildResource('contract-service', '0.0.0-contract', profile);
      expect(process.env.OTEL_EXPERIMENTAL_RESOURCE_DETECTORS, profile).toBe(resource.hardened_detectors);
      delete process.env.OTEL_EXPERIMENTAL_RESOURCE_DETECTORS;
    }
  });

  it('superseded resource keys are emitted next to their replacements', () => {
    process.env.OTEL_ENVIRONMENT = 'prod';
    const attributes = buildResource('contract-service', '0.0.0-contract').attributes;
    for (const [old, current] of Object.entries(resource.superseded)) {
      expect(attributes[old], old).toBe(attributes[current]);
      expect(attributes[old], old).toBeDefined();
    }
  });

  it('service.instance.id: uuid version per mode, derived mode stable, same namespace', () => {
    const facts = resource.service_instance_id;
    const random = String(buildResource('contract-service', '0.0.0-contract').attributes['service.instance.id']);
    expect(Number(random[14])).toBe(facts.random_mode_uuid_version);

    process.env.GENAI_SERVICE_INSTANCE_ID_MODE = 'derived';
    const first = String(buildResource('contract-service', '0.0.0-contract').attributes['service.instance.id']);
    const second = String(buildResource('contract-service', '0.0.0-contract').attributes['service.instance.id']);
    expect(Number(first[14])).toBe(facts.derived_mode_uuid_version);
    expect(first === second).toBe(facts.derived_mode_is_stable);
    // The namespace is observable only through the ids it produces.
    expect(uuidV5(facts.derived_namespace, 'host|svc|a b')).toBe('62f87d14-a634-5592-829c-5920fd2a8774');
  });

  it.each(resource.command_args_redaction_vectors.map((vector) => [JSON.stringify(vector.argv), vector] as const))(
    'redacts %s',
    (_label, vector) => {
      expect(redactCommandArgs(vector.argv)).toEqual(vector.redacted);
    },
  );

  it('uses the same placeholder', () => {
    expect(redactCommandArgs(['--password=x'])).toEqual([`--password=${resource.redaction_placeholder}`]);
  });
});
