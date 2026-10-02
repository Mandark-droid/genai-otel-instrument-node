import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger, logThreshold, setLogger } from '../../src/logger';
// The Node entry is what hands the logger the process environment.
import '../../src/node-env';

afterEach(() => {
  setLogger(undefined);
  delete process.env.GENAI_OTEL_LOG_LEVEL;
  delete process.env.OTEL_LOG_LEVEL;
  vi.restoreAllMocks();
});

describe('logger', () => {
  it('by default lets warnings and errors through and nothing below', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[genai-otel-instrument]', 'w');
    expect(error).toHaveBeenCalledWith('[genai-otel-instrument]', 'e');
  });

  it('GENAI_OTEL_LOG_LEVEL=DEBUG lets everything through', () => {
    process.env.GENAI_OTEL_LOG_LEVEL = 'debug';
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logger.debug('d');
    logger.info('i');
    expect(debug).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ GENAI_OTEL_LOG_LEVEL: 'DEBUG' }, 10],
    [{ GENAI_OTEL_LOG_LEVEL: 'info' }, 20],
    [{ GENAI_OTEL_LOG_LEVEL: 'WARNING' }, 30],
    [{ GENAI_OTEL_LOG_LEVEL: 'ERROR' }, 40],
    [{ GENAI_OTEL_LOG_LEVEL: 'CRITICAL' }, 40],
    // getattr(logging, "VALUE", logging.INFO): an unknown name is INFO.
    [{ GENAI_OTEL_LOG_LEVEL: 'value' }, 20],
    [{ GENAI_OTEL_LOG_LEVEL: '' }, 30],
    [{ GENAI_OTEL_LOG_LEVEL: 'ERROR', OTEL_LOG_LEVEL: 'debug' }, 40],
    [{ OTEL_LOG_LEVEL: 'debug' }, 10],
    [{ OTEL_LOG_LEVEL: 'INFO' }, 20],
    [{ OTEL_LOG_LEVEL: 'error' }, 40],
    [{ OTEL_LOG_LEVEL: 'none' }, 100],
    [{ OTEL_LOG_LEVEL: 'bogus' }, 30],
    [{}, 30],
  ])('threshold for %j is %i', (env, expected) => {
    expect(logThreshold(env)).toBe(expected);
  });

  it('setLogger routes every level to the host logger', () => {
    const host = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    setLogger(host);
    logger.debug('d', 1);
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(host.debug).toHaveBeenCalledWith('d', 1);
    expect(host.info).toHaveBeenCalledWith('i');
    expect(host.warn).toHaveBeenCalledWith('w');
    expect(host.error).toHaveBeenCalledWith('e');
  });
});
