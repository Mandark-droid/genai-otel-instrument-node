/**
 * Resource attributes describing the host, the process and the service instance.
 *
 * Port of `genai_otel/resource.py`. Two rules carry over unchanged:
 *
 * 1. Every attribute name comes from the OpenTelemetry registry, and the control
 *    surface is the standard `OTEL_*` variables.
 * 2. An operator's explicit value always wins: anything supplied through
 *    `OTEL_RESOURCE_ATTRIBUTES` or a detector is left alone.
 *
 * What differs is identity, deliberately: `telemetry.sdk.language` is `nodejs`
 * and `telemetry.distro.name` is `genai-otel-instrument-node`, so a backend can
 * tell which SDK produced a span - and by nothing else.
 *
 * What is on by default is what separates traffic and nothing more: `host.name`,
 * `host.id`, `host.arch`, `os.*` and `service.instance.id`. The `process` detector
 * (executable path and full command line) and `host.ip` (every interface address)
 * describe the developer's workstation on every span a sample app sends, so both
 * are opt-in, as in the Python library since 1.46: `OTEL_EXPERIMENTAL_RESOURCE_DETECTORS`
 * naming `process`, and `GENAI_OTEL_RESOURCE_HOST_IP=true`.
 */
import './node-env';
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import {
  defaultResource,
  envDetector,
  hostDetector,
  osDetector,
  processDetector,
  resourceFromAttributes,
  type Resource,
  type ResourceDetector,
} from '@opentelemetry/resources';
import type { Attributes, AttributeValue } from '@opentelemetry/api';
import { logger } from './logger';

// Registry names, spelled out rather than imported from an incubating semconv
// module - a rename there should be a deliberate change here.
export const DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';
export const HOST_ID = 'host.id';
export const HOST_IP = 'host.ip';
export const PROCESS_COMMAND_ARGS = 'process.command_args';
export const PROCESS_COMMAND_LINE = 'process.command_line';
export const SERVICE_INSTANCE_ID = 'service.instance.id';
export const SERVICE_NAME = 'service.name';
export const TELEMETRY_SDK_LANGUAGE = 'telemetry.sdk.language';
export const TELEMETRY_DISTRO_NAME = 'telemetry.distro.name';
export const TELEMETRY_DISTRO_VERSION = 'telemetry.distro.version';

// Superseded spellings, still emitted for the reason the Python library gives:
// dropping a key silently breaks whatever is already reading it.
export const LEGACY_ENVIRONMENT = 'environment';
export const LEGACY_DISTRO_NAME = 'telemetry.auto.name';
export const LEGACY_DISTRO_VERSION = 'telemetry.auto.version';

export const SDK_LANGUAGE = 'nodejs';
export const DISTRO_NAME = 'genai-otel-instrument-node';

// `process` is not on by default: it reports the executable path and the full
// command line - on a laptop running a sample app, a description of that
// person's machine on every span. An operator who wants it names it in
// OTEL_EXPERIMENTAL_RESOURCE_DETECTORS. The hardened profiles never had it.
const DEFAULT_DETECTORS = 'host,os';
const HARDENED_DETECTORS = 'host,os';

/** `host.ip` lists every non-loopback interface (VPN, docker, Wi-Fi), so it is filled only on request. */
export const HOST_IP_ENV = 'GENAI_OTEL_RESOURCE_HOST_IP';
const HARDENED_PROFILES = new Set(['strict', 'bfsi', 'bank']);

/** semconv's namespace for a `service.instance.id` derived from an inherent stable id. */
const INSTANCE_ID_NAMESPACE = '4d63009a-8d0f-11ee-aad7-4c796ed8e320';

const PLACEHOLDER = '***REDACTED***';

const SECRET_WORDS = '(?:pass(?:word|wd)?|secret|tokens?|api[-_]?keys?|keys?|auth|credentials?|creds?)';
/** A flag whose value is a credential; anchored so that `--monkey` is not read as `--key`. */
const SECRET_FLAG = new RegExp(`(?:^|[-_.])${SECRET_WORDS}$`, 'i');
/** The same, inside a single `name=value` argument. */
const INLINE_SECRET = new RegExp(`(^|[\\s,;])((?:[\\p{L}\\p{N}_.-]*[-_.])?${SECRET_WORDS})=[^\\s,;]+`, 'giu');
/** `scheme://user:password@host`. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi;

const DETECTORS: Record<string, ResourceDetector> = {
  host: hostDetector,
  os: osDetector,
  process: processDetector,
};

function isThenable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

let generatedInstanceId: string | undefined;
let machineId: { value: string | undefined } | undefined;

/** `_host_ip_requested()`: GENAI_OTEL_RESOURCE_HOST_IP is 1, true, yes or on. */
export function hostIpRequested(): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[HOST_IP_ENV] ?? '').trim().toLowerCase());
}

function machineIdNow(): string | undefined {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    timeout: 2000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  switch (process.platform) {
    case 'linux':
      for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          return readFileSync(path, 'utf8').trim() || undefined;
        } catch {
          // try the next location
        }
      }
      return undefined;
    case 'win32': {
      const windir = process.env.windir ?? process.env.WINDIR ?? 'C:\\Windows';
      // A 32-bit process on 64-bit Windows reads the 64-bit registry view through sysnative.
      const reg =
        process.arch === 'ia32' && 'PROCESSOR_ARCHITEW6432' in process.env
          ? `${windir}\\sysnative\\reg.exe`
          : `${windir}\\System32\\reg.exe`;
      const out = execFileSync(reg, ['QUERY', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], options);
      const parts = out.split('REG_SZ');
      return parts.length === 2 ? parts[1]?.trim() || undefined : undefined;
    }
    case 'darwin': {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], options);
      const line = out.split('\n').find((candidate) => candidate.includes('IOPlatformUUID'));
      const parts = line?.split('" = "');
      return parts?.length === 2 ? parts[1]?.slice(0, -1) || undefined : undefined;
    }
    case 'freebsd':
      try {
        return readFileSync('/etc/hostid', 'utf8').trim() || undefined;
      } catch {
        return execFileSync('kenv', ['-q', 'smbios.system.uuid'], options).trim() || undefined;
      }
    default:
      return undefined;
  }
}

/**
 * `host.id`, read the way the SDK's host detector reads it, but synchronously and
 * once per process, so the resource stays fully known at startup and no span
 * waits on it before export. Best-effort: undefined where it cannot be read.
 */
export function hostMachineId(): string | undefined {
  if (machineId === undefined) {
    try {
      machineId = { value: machineIdNow() };
    } catch (error) {
      logger.debug(`host.id detection failed: ${String(error)}`);
      machineId = { value: undefined };
    }
  }
  return machineId.value;
}

/** Test hook: forget the per-process random instance id. */
export function resetGeneratedInstanceId(): void {
  generatedInstanceId = undefined;
}

function ipv4Bytes(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : undefined;
}

function ipv6Bytes(address: string): number[] | undefined {
  const [head = '', tail] = address.split('::');
  if (address.split('::').length > 2) return undefined;
  const parse = (text: string): number[] | undefined => {
    if (text === '') return [];
    const out: number[] = [];
    for (const group of text.split(':')) {
      const v4 = group.includes('.') ? ipv4Bytes(group) : undefined;
      if (v4) {
        out.push(...v4);
      } else if (/^[0-9a-f]{1,4}$/i.test(group)) {
        const value = Number.parseInt(group, 16);
        out.push(value >> 8, value & 0xff);
      } else {
        return undefined;
      }
    }
    return out;
  };
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  if (!left || !right) return undefined;
  if (tail === undefined) return left.length === 16 ? left : undefined;
  const fill = 16 - left.length - right.length;
  return fill >= 0 ? [...left, ...new Array<number>(fill).fill(0), ...right] : undefined;
}

interface ParsedAddress {
  text: string;
  version: 4 | 6;
  bytes: number[];
  linkLocal: boolean;
  isPrivate: boolean;
}

function inV4(bytes: number[], a: number, b: number | undefined, prefix: number): boolean {
  if (bytes[0] !== a) return false;
  if (prefix <= 8) return true;
  if (b === undefined) return true;
  const second = bytes[1] ?? 0;
  const mask = prefix >= 16 ? 0xff : (0xff << (16 - prefix)) & 0xff;
  return (second & mask) === (b & mask);
}

/** Enough of Python's `ipaddress` classification to order addresses the same way. */
function classify(text: string, version: 4 | 6, bytes: number[]): ParsedAddress {
  let linkLocal: boolean;
  let isPrivate: boolean;
  if (version === 4) {
    linkLocal = inV4(bytes, 169, 254, 16);
    isPrivate =
      linkLocal ||
      inV4(bytes, 10, undefined, 8) ||
      inV4(bytes, 172, 16, 12) ||
      inV4(bytes, 192, 168, 16) ||
      inV4(bytes, 127, undefined, 8) ||
      inV4(bytes, 0, undefined, 8) ||
      inV4(bytes, 198, 18, 15) ||
      (bytes[0] ?? 0) >= 240;
  } else {
    const first = bytes[0] ?? 0;
    const second = bytes[1] ?? 0;
    linkLocal = first === 0xfe && (second & 0xc0) === 0x80;
    isPrivate = linkLocal || (first & 0xfe) === 0xfc;
  }
  return { text, version, bytes, linkLocal, isPrivate };
}

function compareAddresses(a: ParsedAddress, b: ParsedAddress): number {
  // Routable before private, private before link-local; then stable by family and value.
  if (a.linkLocal !== b.linkLocal) return a.linkLocal ? 1 : -1;
  if (a.isPrivate !== b.isPrivate) return a.isPrivate ? 1 : -1;
  if (a.version !== b.version) return a.version - b.version;
  for (let i = 0; i < Math.max(a.bytes.length, b.bytes.length); i += 1) {
    const diff = (a.bytes[i] ?? 0) - (b.bytes[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Non-loopback IP addresses of this host, in a stable order.
 *
 * No detector emits `host.ip`. semconv requires loopback interfaces to be
 * excluded. Best-effort: a host with no usable interface yields no addresses
 * rather than an error, since this must never keep an application from starting.
 */
export function hostIpAddresses(): string[] {
  let interfaces: ReturnType<typeof networkInterfaces>;
  try {
    interfaces = networkInterfaces();
  } catch (error) {
    logger.debug(`host.ip detection failed: ${String(error)}`);
    return [];
  }
  const seen = new Set<string>();
  const parsed: ParsedAddress[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      // Strip any IPv6 scope id ("fe80::1%eth0").
      const candidate = (entry.address.split('%', 1)[0] ?? '').toLowerCase();
      const v4 = ipv4Bytes(candidate);
      const bytes = v4 ?? ipv6Bytes(candidate);
      if (!bytes) continue;
      if (bytes.every((byte) => byte === 0)) continue;
      const key = bytes.join('.');
      if (seen.has(key)) continue;
      seen.add(key);
      parsed.push(classify(candidate, v4 ? 4 : 6, bytes));
    }
  }
  return parsed.sort(compareAddresses).map((address) => address.text);
}

function isSecretFlag(argument: string): boolean {
  return SECRET_FLAG.test(argument.replace(/^-+/, ''));
}

function redactInline(argument: string): string {
  return argument
    .replace(INLINE_SECRET, (_match, lead: string, name: string) => `${lead}${name}=${PLACEHOLDER}`)
    .replace(URL_CREDENTIALS, (_match, prefix: string) => `${prefix}:${PLACEHOLDER}@`);
}

/**
 * Blank out credential values in an argument vector.
 *
 * Handles `--password=hunter2` and `--password hunter2`. A following argument
 * that itself looks like a long flag is left alone, so `--password --verbose`
 * does not lose the second flag. This has to happen here rather than
 * downstream: once the array is flattened, a value no longer sits next to the
 * flag it belonged to.
 */
export function redactCommandArgs(args: readonly string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;

  for (const argument of args) {
    if (redactNext) {
      redactNext = false;
      // A long flag here means no value was passed for the secret flag.
      if (!argument.startsWith('--')) {
        redacted.push(PLACEHOLDER);
        continue;
      }
    }

    if (argument.startsWith('-')) {
      const separator = argument.indexOf('=');
      if (separator !== -1) {
        const name = argument.slice(0, separator);
        if (isSecretFlag(name)) {
          redacted.push(`${name}=${PLACEHOLDER}`);
          continue;
        }
      } else if (isSecretFlag(argument)) {
        redactNext = true;
        redacted.push(argument);
        continue;
      }
    }

    redacted.push(redactInline(argument));
  }
  return redacted;
}

/** The startup argument vector, as the SDK's process detector reports it. */
export function processArgv(): string[] {
  return [process.argv0, ...process.execArgv, ...process.argv.slice(1)];
}

function enabledDetectorNames(): Set<string> {
  const raw = process.env.OTEL_EXPERIMENTAL_RESOURCE_DETECTORS ?? '';
  return new Set(raw.split(',').map((name) => name.trim()));
}

/** An instance id the operator set, as distinct from one a detector or this module invented. */
function operatorSuppliedInstanceId(): string | undefined {
  const configured = process.env.OTEL_SERVICE_INSTANCE_ID;
  if (configured) return configured;
  for (const item of (process.env.OTEL_RESOURCE_ATTRIBUTES ?? '').split(',')) {
    const separator = item.indexOf('=');
    if (separator === -1) continue;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (key === SERVICE_INSTANCE_ID && value) {
      // Values in OTEL_RESOURCE_ATTRIBUTES are URL-encoded per the specification.
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return undefined;
}

function randomInstanceId(): string {
  if (generatedInstanceId === undefined) generatedInstanceId = randomUUID();
  return generatedInstanceId;
}

/** RFC 4122 version 5 (SHA-1, namespaced) UUID. */
export function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1').update(namespaceBytes).update(Buffer.from(name, 'utf8')).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A v5 UUID over host name, service name and the normalised argument list.
 *
 * Survives a restart, which a random id does not. The trade-off is why it is
 * not the default: instances that differ in no argument collapse to one id.
 */
function derivedInstanceId(serviceName: string): string {
  const args = redactCommandArgs(processArgv()).sort().join(' ');
  return uuidV5(INSTANCE_ID_NAMESPACE, [hostname(), serviceName, args].join('|'));
}

function instanceId(serviceName: string): string {
  const mode = (process.env.GENAI_SERVICE_INSTANCE_ID_MODE ?? 'random').trim().toLowerCase();
  if (mode === 'derived') return derivedInstanceId(serviceName);
  if (mode !== 'random' && mode !== '') {
    logger.warn(
      `Unknown GENAI_SERVICE_INSTANCE_ID_MODE '${mode}'; using 'random'. Valid values are 'random' and 'derived'.`,
    );
  }
  return randomInstanceId();
}

/** Build the resource shared by the tracer and meter providers. */
export function buildResource(serviceName: string, distroVersion: string, profile = ''): Resource {
  const defaultDetectors = HARDENED_PROFILES.has(profile.trim().toLowerCase()) ? HARDENED_DETECTORS : DEFAULT_DETECTORS;
  if (process.env.OTEL_EXPERIMENTAL_RESOURCE_DETECTORS === undefined) {
    process.env.OTEL_EXPERIMENTAL_RESOURCE_DETECTORS = defaultDetectors;
  }

  const attributes: Attributes = {
    [SERVICE_NAME]: serviceName,
    [TELEMETRY_SDK_LANGUAGE]: SDK_LANGUAGE,
    [TELEMETRY_DISTRO_NAME]: DISTRO_NAME,
    [TELEMETRY_DISTRO_VERSION]: distroVersion,
    [LEGACY_DISTRO_NAME]: DISTRO_NAME,
    [LEGACY_DISTRO_VERSION]: distroVersion,
  };

  const configuredInstanceId = process.env.OTEL_SERVICE_INSTANCE_ID;
  if (configuredInstanceId) attributes[SERVICE_INSTANCE_ID] = configuredInstanceId;

  const environment = process.env.OTEL_ENVIRONMENT;
  if (environment) {
    attributes[DEPLOYMENT_ENVIRONMENT_NAME] = environment;
    attributes[LEGACY_ENVIRONMENT] = environment;
  }

  // SDK defaults, then OTEL_RESOURCE_ATTRIBUTES, then the named detectors, then
  // what this library states itself - the same precedence as Resource.create().
  const names = enabledDetectorNames();
  const detectors: ResourceDetector[] = [envDetector];
  for (const [name, detector] of Object.entries(DETECTORS)) {
    if (names.has(name)) detectors.push(detector);
  }
  const detected: Attributes = {};
  for (const detector of detectors) {
    try {
      for (const [key, value] of Object.entries(detector.detect().attributes ?? {})) {
        // Only what is known now. The one attribute the SDK resolves later is
        // `host.id`, read synchronously below instead.
        if (value === undefined || isThenable(value)) continue;
        detected[key] = value as AttributeValue;
      }
    } catch (error) {
      logger.debug(`resource detection failed: ${String(error)}`);
    }
  }

  if (names.has('host') && detected[HOST_ID] === undefined) {
    const id = hostMachineId();
    if (id) detected[HOST_ID] = id;
  }

  if (names.has('process')) {
    // The attribute set of the reference implementation: the parent pid is
    // there, the OS user name (`process.owner`) is not.
    delete detected['process.owner'];
    detected['process.parent_pid'] = process.ppid;
  }

  // Credential values are stripped from the detected argument vector, and the
  // joined command line is built from the stripped version so the two cannot
  // disagree.
  const detectedArgs = detected[PROCESS_COMMAND_ARGS];
  if (Array.isArray(detectedArgs) && detectedArgs.length > 0) {
    const safeArgs = redactCommandArgs(detectedArgs.map((item) => String(item)));
    detected[PROCESS_COMMAND_ARGS] = safeArgs;
    detected[PROCESS_COMMAND_LINE] = safeArgs.join(' ');
  }

  // Fill in only what neither a detector nor OTEL_RESOURCE_ATTRIBUTES gave us.
  const fallbacks: Attributes = {};
  if (hostIpRequested() && !detected[HOST_IP]) {
    const addresses = hostIpAddresses();
    if (addresses.length > 0) fallbacks[HOST_IP] = addresses;
  }

  if (!operatorSuppliedInstanceId()) attributes[SERVICE_INSTANCE_ID] = instanceId(serviceName);

  const resource = defaultResource()
    .merge(resourceFromAttributes(fallbacks))
    .merge(resourceFromAttributes(detected))
    .merge(resourceFromAttributes(attributes));
  return resource;
}
