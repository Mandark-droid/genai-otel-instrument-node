import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLogger } from '../../src/logger';
import {
  buildResource,
  DISTRO_NAME,
  hostIpAddresses,
  redactCommandArgs,
  resetGeneratedInstanceId,
  uuidV5,
} from '../../src/resource';

const ENV_KEYS = [
  'OTEL_SERVICE_INSTANCE_ID',
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_ENVIRONMENT',
  'OTEL_EXPERIMENTAL_RESOURCE_DETECTORS',
  'GENAI_SERVICE_INSTANCE_ID_MODE',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('buildResource', () => {
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
    setLogger(undefined);
  });

  it('carries the three identity attributes', () => {
    const attrs = buildResource('svc', '0.1.0').attributes;
    expect(attrs['telemetry.sdk.language']).toBe('nodejs');
    expect(attrs['telemetry.distro.name']).toBe('genai-otel-instrument-node');
    expect(attrs['telemetry.distro.version']).toBe('0.1.0');
    expect(DISTRO_NAME).toBe('genai-otel-instrument-node');
  });

  it('carries service.name and the superseded telemetry.auto.* spellings, as resource.py does', () => {
    const attrs = buildResource('my-service', '1.2.3').attributes;
    expect(attrs['service.name']).toBe('my-service');
    expect(attrs['telemetry.auto.name']).toBe('genai-otel-instrument-node');
    expect(attrs['telemetry.auto.version']).toBe('1.2.3');
    expect(attrs['telemetry.sdk.name']).toBe('opentelemetry');
  });

  it('generates a random v4 service.instance.id, stable for the life of the process', () => {
    const first = buildResource('svc', '0.1.0').attributes['service.instance.id'];
    const second = buildResource('svc', '0.1.0').attributes['service.instance.id'];
    expect(String(first)).toMatch(UUID);
    expect(String(first)[14]).toBe('4');
    expect(second).toBe(first);
  });

  it('OTEL_SERVICE_INSTANCE_ID wins', () => {
    process.env.OTEL_SERVICE_INSTANCE_ID = 'pod-7';
    expect(buildResource('svc', '0.1.0').attributes['service.instance.id']).toBe('pod-7');
  });

  it('an instance id in OTEL_RESOURCE_ATTRIBUTES is left alone, url-decoded', () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'team=a,service.instance.id=node%2F1';
    const attrs = buildResource('svc', '0.1.0').attributes;
    expect(attrs['service.instance.id']).toBe('node/1');
    expect(attrs.team).toBe('a');
  });

  it('service.name from the config beats OTEL_RESOURCE_ATTRIBUTES', () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.name=from-attrs';
    expect(buildResource('from-config', '0.1.0').attributes['service.name']).toBe('from-config');
  });

  it('derived mode gives a v5 id that survives a restart and depends on the service name', () => {
    process.env.GENAI_SERVICE_INSTANCE_ID_MODE = 'derived';
    const a = String(buildResource('svc', '0.1.0').attributes['service.instance.id']);
    resetGeneratedInstanceId();
    const b = String(buildResource('svc', '0.1.0').attributes['service.instance.id']);
    const other = String(buildResource('other', '0.1.0').attributes['service.instance.id']);
    expect(a).toMatch(UUID);
    expect(a[14]).toBe('5');
    expect(b).toBe(a);
    expect(other).not.toBe(a);
  });

  it('an unknown instance-id mode warns and falls back to random', () => {
    const warn = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    process.env.GENAI_SERVICE_INSTANCE_ID_MODE = 'sticky';
    const id = String(buildResource('svc', '0.1.0').attributes['service.instance.id']);
    expect(id[14]).toBe('4');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('OTEL_ENVIRONMENT sets deployment.environment.name and the legacy environment key', () => {
    process.env.OTEL_ENVIRONMENT = 'prod';
    const attrs = buildResource('svc', '0.1.0').attributes;
    expect(attrs['deployment.environment.name']).toBe('prod');
    expect(attrs.environment).toBe('prod');
  });

  it('without OTEL_ENVIRONMENT neither environment key is present', () => {
    const attrs = buildResource('svc', '0.1.0').attributes;
    expect('deployment.environment.name' in attrs).toBe(false);
    expect('environment' in attrs).toBe(false);
  });

  it('runs the host, os and process detectors by default', () => {
    const attrs = buildResource('svc', '0.1.0').attributes;
    expect(typeof attrs['host.name']).toBe('string');
    expect(typeof attrs['os.type']).toBe('string');
    expect(typeof attrs['process.pid']).toBe('number');
    expect(Array.isArray(attrs['process.command_args'])).toBe(true);
    expect(attrs['process.command_line']).toBe((attrs['process.command_args'] as string[]).join(' '));
    expect(process.env.OTEL_EXPERIMENTAL_RESOURCE_DETECTORS).toBe('host,os,process');
  });

  it('a hardened profile leaves the process detector, and so the command line, out', () => {
    const attrs = buildResource('svc', '0.1.0', 'BFSI').attributes;
    expect(process.env.OTEL_EXPERIMENTAL_RESOURCE_DETECTORS).toBe('host,os');
    expect('process.command_args' in attrs).toBe(false);
    expect('process.command_line' in attrs).toBe(false);
    expect(typeof attrs['host.name']).toBe('string');
  });

  it('an operator-chosen detector list is respected', () => {
    process.env.OTEL_EXPERIMENTAL_RESOURCE_DETECTORS = 'os';
    const attrs = buildResource('svc', '0.1.0').attributes;
    expect('host.name' in attrs).toBe(false);
    expect('process.pid' in attrs).toBe(false);
    expect(typeof attrs['os.type']).toBe('string');
  });

  it('host.ip, when present, lists no loopback address', () => {
    const ips = buildResource('svc', '0.1.0').attributes['host.ip'] as string[] | undefined;
    for (const ip of ips ?? []) {
      expect(ip.startsWith('127.')).toBe(false);
      expect(ip).not.toBe('::1');
    }
    expect(hostIpAddresses()).toEqual(ips ?? []);
  });
});

describe('redactCommandArgs', () => {
  it('blanks the value of --flag=value and of --flag value', () => {
    expect(redactCommandArgs(['app', '--password=hunter2', '--api-key', 'sk-123', '--port', '80'])).toEqual([
      'app',
      '--password=***REDACTED***',
      '--api-key',
      '***REDACTED***',
      '--port',
      '80',
    ]);
  });

  it('does not eat a following long flag', () => {
    expect(redactCommandArgs(['--password', '--verbose'])).toEqual(['--password', '--verbose']);
  });

  it('does not read --monkey as --key', () => {
    expect(redactCommandArgs(['--monkey', 'banana', '--db-key', 'k'])).toEqual([
      '--monkey',
      'banana',
      '--db-key',
      '***REDACTED***',
    ]);
  });

  it('redacts inline name=value pairs and URL credentials in positional arguments', () => {
    expect(redactCommandArgs(['token=abc', 'DB_PASSWORD=x,other=1', 'postgres://user:pw@host/db'])).toEqual([
      'token=***REDACTED***',
      'DB_PASSWORD=***REDACTED***,other=1',
      'postgres://user:***REDACTED***@host/db',
    ]);
  });

  it('leaves ordinary arguments alone', () => {
    expect(redactCommandArgs(['node', 'server.js', '--port=8080', 'monkey=1'])).toEqual([
      'node',
      'server.js',
      '--port=8080',
      'monkey=1',
    ]);
  });
});

describe('uuidV5', () => {
  it("matches Python's uuid.uuid5 for the semconv instance-id namespace", () => {
    // uuid.uuid5(uuid.UUID('4d63009a-8d0f-11ee-aad7-4c796ed8e320'), 'host|svc|a b')
    expect(uuidV5('4d63009a-8d0f-11ee-aad7-4c796ed8e320', 'host|svc|a b')).toBe('62f87d14-a634-5592-829c-5920fd2a8774');
  });
});
