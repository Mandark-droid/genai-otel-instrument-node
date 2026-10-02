import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OTLP_ENDPOINT,
  instrument,
  instrumentorsReady,
  uninstrument,
  warnIfDefaultCollectorUnreachable,
} from '../../src/auto-instrument';
import { loadConfig } from '../../src/config';
import { registerInstrumentor, type Instrumentor } from '../../src/instrumentors/registry';
import { setLogger } from '../../src/logger';
import { closedPort } from '../helpers/otlp-receiver';

function quietLogger() {
  const spies = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  setLogger(spies);
  return spies;
}

/** True when something is already listening on the default OTLP/HTTP port of this machine. */
function defaultPortInUse(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true));
    probe.listen(4318, 'localhost', () => probe.close(() => resolve(false)));
  });
}

describe('warnIfDefaultCollectorUnreachable', () => {
  afterEach(() => setLogger(undefined));

  it('says nothing when the check is switched off', async () => {
    const log = quietLogger();
    const config = loadConfig({}, {});
    expect(await warnIfDefaultCollectorUnreachable(config, { GENAI_SKIP_COLLECTOR_CHECK: 'true' })).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('says nothing when the endpoint was configured', async () => {
    const log = quietLogger();
    const config = loadConfig({ endpoint: 'http://collector.internal:4318' }, {});
    expect(await warnIfDefaultCollectorUnreachable(config, {})).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('on the default endpoint, warns exactly when nothing is listening there', async () => {
    const log = quietLogger();
    const listening = await defaultPortInUse();
    const config = loadConfig({}, {});
    expect(config.endpoint).toBe(DEFAULT_OTLP_ENDPOINT);
    const warned = await warnIfDefaultCollectorUnreachable(config, {});
    expect(warned).toBe(!listening);
    expect(log.warn.mock.calls.length).toBe(listening ? 0 : 1);
    if (!listening) expect(String(log.warn.mock.calls[0]?.[0])).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
  });
});

describe('process hooks', () => {
  let endpoint: string;

  beforeEach(async () => {
    process.env.GENAI_SKIP_COLLECTOR_CHECK = 'true';
    endpoint = `http://127.0.0.1:${await closedPort()}`;
    quietLogger();
  });

  afterEach(async () => {
    await uninstrument(0.2);
    delete process.env.GENAI_SKIP_COLLECTOR_CHECK;
    setLogger(undefined);
  });

  it('registers a beforeExit flush and removes it on uninstrument', async () => {
    const before = process.listenerCount('beforeExit');
    instrument({ endpoint, enabledInstrumentors: [] });
    expect(process.listenerCount('beforeExit')).toBe(before + 1);
    await uninstrument(0.2);
    expect(process.listenerCount('beforeExit')).toBe(before);
  });

  it('installs a SIGTERM handler only when asked, and removes it again', async () => {
    const before = process.listenerCount('SIGTERM');
    instrument({ endpoint, enabledInstrumentors: [] });
    expect(process.listenerCount('SIGTERM')).toBe(before);
    await uninstrument(0.2);

    instrument({ endpoint, enabledInstrumentors: [], flushOnSigterm: true, sigtermFlushTimeout: 0.2 });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    await uninstrument(0.2);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('on SIGTERM: flushes, then hands over to another listener rather than swallowing the signal', async () => {
    const other = vi.fn();
    process.on('SIGTERM', other);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      instrument({ endpoint, enabledInstrumentors: [], flushOnSigterm: true, sigtermFlushTimeout: 0.2 });
      process.emit('SIGTERM', 'SIGTERM');
      await vi.waitFor(() => expect(other).toHaveBeenCalledTimes(1));
      // Another listener owns the shutdown; this one must not re-raise underneath it.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(kill).not.toHaveBeenCalled();
    } finally {
      process.removeListener('SIGTERM', other);
      kill.mockRestore();
    }
  });

  it('on SIGTERM with no other listener: flushes, then re-raises so the exit status stays conventional', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const existing = process.listeners('SIGTERM');
    for (const listener of existing) process.removeListener('SIGTERM', listener);
    try {
      instrument({ endpoint, enabledInstrumentors: [], flushOnSigterm: true, sigtermFlushTimeout: 0.2 });
      process.emit('SIGTERM', 'SIGTERM');
      await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM'));
    } finally {
      kill.mockRestore();
      for (const listener of existing) process.on('SIGTERM', listener);
    }
  });
});

describe('instrumentors', () => {
  let endpoint: string;

  beforeEach(async () => {
    process.env.GENAI_SKIP_COLLECTOR_CHECK = 'true';
    endpoint = `http://127.0.0.1:${await closedPort()}`;
  });

  afterEach(async () => {
    await uninstrument(0.2);
    delete process.env.GENAI_SKIP_COLLECTOR_CHECK;
    setLogger(undefined);
  });

  it('starts a registered instrumentor with the config, awaits its patching, and removes it on teardown', async () => {
    quietLogger();
    let patched = false;
    const fake: Instrumentor = {
      instrument: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        patched = true;
      }),
      uninstrument: vi.fn(),
    };
    registerInstrumentor('fake-lib', () => fake);

    instrument({ endpoint, serviceName: 'svc', enabledInstrumentors: ['fake-lib'] });
    expect(fake.instrument).toHaveBeenCalledTimes(1);
    expect((fake.instrument as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ serviceName: 'svc' });
    expect(patched).toBe(false);
    await instrumentorsReady();
    expect(patched).toBe(true);

    await uninstrument(0.2);
    expect(fake.uninstrument).toHaveBeenCalledTimes(1);
  });

  it('an instrumentor that throws is logged and does not stop the others', async () => {
    const log = quietLogger();
    const good: Instrumentor = { instrument: vi.fn(), uninstrument: vi.fn() };
    registerInstrumentor('bad-lib', () => ({
      instrument: () => {
        throw new Error('cannot patch');
      },
      uninstrument: vi.fn(),
    }));
    registerInstrumentor('good-lib', () => good);

    expect(instrument({ endpoint, enabledInstrumentors: ['bad-lib', 'good-lib'] })).toBeDefined();
    expect(good.instrument).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls.some(([message]) => String(message).includes('bad-lib'))).toBe(true);
  });

  it('an instrumentor whose asynchronous patching rejects is logged; ready still resolves', async () => {
    const log = quietLogger();
    registerInstrumentor('late-bad-lib', () => ({
      instrument: () => Promise.reject(new Error('esm import failed')),
      uninstrument: vi.fn(),
    }));
    instrument({ endpoint, enabledInstrumentors: ['late-bad-lib'] });
    await expect(instrumentorsReady()).resolves.toBeUndefined();
    expect(log.error.mock.calls.some(([message]) => String(message).includes('late-bad-lib'))).toBe(true);
  });

  it('with failOnError an instrumentor that throws fails instrument() and leaves nothing registered', async () => {
    quietLogger();
    registerInstrumentor('bad-lib-2', () => ({
      instrument: () => {
        throw new Error('cannot patch');
      },
      uninstrument: vi.fn(),
    }));
    const before = process.listenerCount('beforeExit');
    expect(() => instrument({ endpoint, enabledInstrumentors: ['bad-lib-2'], failOnError: true })).toThrow('cannot patch');
    await vi.waitFor(() => expect(process.listenerCount('beforeExit')).toBe(before));
  });

  it('instrumentorsReady resolves when nothing is instrumented', async () => {
    await expect(instrumentorsReady()).resolves.toBeUndefined();
  });
});
