/**
 * Internal logger.
 *
 * Mirrors what an application sees from the Python library with logging left
 * unconfigured: warnings and errors reach stderr, info and debug do not. The
 * threshold follows `GENAI_OTEL_LOG_LEVEL`, then the standard `OTEL_LOG_LEVEL`;
 * a host application can also route everything into its own logger with
 * `setLogger()`.
 */
import { ambientEnv, type Env } from './env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const ORDER: Record<LogLevel | 'none', number> = { debug: 10, info: 20, warn: 30, error: 40, none: 100 };
const PREFIX = '[genai-otel-instrument]';

/**
 * `GENAI_OTEL_LOG_LEVEL` (the Python library's variable; Python level names,
 * an unrecognised name meaning INFO as it does there), else the standard
 * `OTEL_LOG_LEVEL`, else warnings and errors only.
 */
export function logThreshold(env: Env = ambientEnv()): number {
  const own = env.GENAI_OTEL_LOG_LEVEL;
  if (own) {
    const level = own.toUpperCase();
    if (level === 'DEBUG') return ORDER.debug;
    if (level === 'WARNING' || level === 'WARN') return ORDER.warn;
    if (level === 'ERROR' || level === 'CRITICAL' || level === 'FATAL') return ORDER.error;
    return ORDER.info;
  }
  const raw = (env.OTEL_LOG_LEVEL ?? '').trim().toLowerCase();
  if (raw === 'debug' || raw === 'verbose' || raw === 'all') return ORDER.debug;
  if (raw === 'info') return ORDER.info;
  if (raw === 'error') return ORDER.error;
  if (raw === 'none') return ORDER.none;
  return ORDER.warn;
}

const thresholdFromEnv = (): number => logThreshold();

const consoleLogger: Logger = {
  debug: (message, ...args) => {
    if (thresholdFromEnv() <= ORDER.debug) console.debug(PREFIX, message, ...args);
  },
  info: (message, ...args) => {
    if (thresholdFromEnv() <= ORDER.info) console.info(PREFIX, message, ...args);
  },
  warn: (message, ...args) => {
    if (thresholdFromEnv() <= ORDER.warn) console.warn(PREFIX, message, ...args);
  },
  error: (message, ...args) => {
    if (thresholdFromEnv() <= ORDER.error) console.error(PREFIX, message, ...args);
  },
};

let active: Logger = consoleLogger;

/** Route this library's log lines into the host application's logger. */
export function setLogger(logger: Logger | undefined): void {
  active = logger ?? consoleLogger;
}

export const logger: Logger = {
  debug: (message, ...args) => active.debug(message, ...args),
  info: (message, ...args) => active.info(message, ...args),
  warn: (message, ...args) => active.warn(message, ...args),
  error: (message, ...args) => active.error(message, ...args),
};
