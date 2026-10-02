/**
 * Privacy helpers for MCP instrumentation. A port of
 * `genai_otel/mcp_semconv/privacy.py`.
 *
 * Two rules: user identifiers are hashed before they reach a span, and
 * request and response bodies are not recorded at all.
 *
 * The hash is always salted - an unsalted SHA-256 of a phone number can be
 * reversed by enumeration. Set `GENAI_MCP_HASH_SALT` to a stable secret if
 * hashes must correlate across processes; otherwise a random per-process salt
 * is used and said so once: hashes then join up within the process and
 * deliberately do not survive a restart.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ambientEnv } from '../env';
import { logger } from '../logger';

export const HASH_SALT_ENV = 'GENAI_MCP_HASH_SALT';
/** 16 hex characters: 64 bits. */
export const DEFAULT_HASH_LENGTH = 16;

let ephemeralSalt: string | undefined;
let warned = false;

function resolveSalt(): string {
  const configured = ambientEnv()[HASH_SALT_ENV];
  if (configured) return configured;
  ephemeralSalt ??= randomBytes(16).toString('hex');
  if (!warned) {
    warned = true;
    logger.warn(
      `${HASH_SALT_ENV} is not set - using an ephemeral per-process salt for identifier hashing. ` +
        `Hashes will not correlate across processes or restarts. Set ${HASH_SALT_ENV} to a stable secret if cross-process correlation is required.`,
    );
  }
  return ephemeralSalt;
}

/** Forget the per-process salt. For tests. */
export function resetSaltCache(): void {
  ephemeralSalt = undefined;
  warned = false;
}

/** `sha256:` plus the first `length` hex characters of the salted digest; undefined for an empty value. */
export function hashIdentifier(value: unknown, salt?: string, length: number = DEFAULT_HASH_LENGTH): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const digest = createHash('sha256')
    .update((salt ?? resolveSalt()) + text, 'utf8')
    .digest('hex');
  return `sha256:${digest.slice(0, length)}`;
}

const USER_FIELDS = ['userId', 'user_id', 'phone', 'phoneNumber', 'email', 'customerId'];

/** A copy of `payload` with the named user-identifier fields hashed; everything else passes through. */
export function hashUserFields(payload: Record<string, unknown>, fields: readonly string[] = USER_FIELDS, salt?: string): Record<string, unknown> {
  const wanted = new Set(fields);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const hashed = wanted.has(key) ? hashIdentifier(value, salt) : undefined;
    result[key] = hashed ?? value;
  }
  return result;
}
