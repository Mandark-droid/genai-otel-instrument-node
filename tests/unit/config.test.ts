import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  CONFIG_FIELDS,
  DEFAULT_INSTRUMENTORS,
  loadConfig,
  pyFloat,
  pyInt,
} from '../../src/config';
import { setLogger } from '../../src/logger';

const load = (env: Record<string, string> = {}, overrides = {}) => loadConfig(overrides, env);

afterEach(() => setLogger(undefined));

describe('python-compatible number parsing', () => {
  it.each([
    ['1.0', 1],
    ['  0.25 ', 0.25],
    ['1e3', 1000],
    ['+2', 2],
    ['-0.5', -0.5],
    ['.5', 0.5],
    ['5.', 5],
    ['1_000.5', 1000.5],
    ['inf', Infinity],
    ['-Infinity', -Infinity],
  ])('pyFloat(%j) = %j', (raw, expected) => {
    expect(pyFloat(raw)).toBe(expected);
  });

  it('pyFloat("nan") is NaN, as float("nan") is', () => {
    expect(Number.isNaN(pyFloat('NaN'))).toBe(true);
  });

  it.each(['abc', '', '  ', '0x10', '1,5', '1.2.3', '_1', '1__0', 'e5', '.'])(
    'pyFloat(%j) raises like float() does',
    (raw) => {
      expect(() => pyFloat(raw)).toThrow(/could not convert string to float/);
    },
  );

  it.each([
    ['5', 5],
    [' 60 ', 60],
    ['+7', 7],
    ['-3', -3],
    ['007', 7],
    ['1_000', 1000],
  ])('pyInt(%j) = %j', (raw, expected) => {
    expect(pyInt(raw)).toBe(expected);
  });

  it.each(['5.0', 'abc', '', '1e3', '0x10', '1__0'])('pyInt(%j) raises like int() does', (raw) => {
    expect(() => pyInt(raw)).toThrow(/invalid literal for int\(\)/);
  });
});

describe('loadConfig defaults (genai_otel/config.py at v1.30.0)', () => {
  const config = load();

  it('service and exporter', () => {
    expect(config.serviceName).toBe('genai-app');
    expect(config.endpoint).toBe('http://localhost:4318');
    expect(config.exporterTimeout).toBe(60);
    expect(config.headers).toBeUndefined();
    expect(config.samplingRate).toBe(1.0);
    expect(config.semconvStabilityOptIn).toBe('gen_ai/dup');
  });

  it('feature flags', () => {
    expect(config.enableGpuMetrics).toBe(true);
    expect(config.enableCostTracking).toBe(true);
    expect(config.enableMcpInstrumentation).toBe(true);
    expect(config.enableHttpInstrumentation).toBe(false);
    expect(config.failOnError).toBe(false);
    expect(config.enableCo2Tracking).toBe(false);
    expect(config.enableContentCapture).toBe(false);
    expect(config.captureEmbeddingVectors).toBe(false);
    expect(config.enableConcurrencyMetrics).toBe(true);
    expect(config.allowExternalEgress).toBe(true);
    expect(config.airGapped).toBe(false);
    expect(config.flushOnSigterm).toBe(false);
  });

  it('numbers and strings', () => {
    expect(config.carbonIntensity).toBe(475.0);
    expect(config.powerCostPerKwh).toBe(0.12);
    expect(config.gpuCollectionInterval).toBe(5);
    expect(config.sigtermFlushTimeout).toBe(5.0);
    expect(config.contentMaxLength).toBe(200);
    expect(config.metricsProfile).toBe('standard');
    expect(config.profile).toBe('');
    expect(config.co2TrackingMode).toBe('machine');
    expect(config.codecarbonLogLevel).toBe('error');
    expect(config.co2OfflineMode).toBe(true);
    expect(config.mediaCaptureMode).toBe('off');
    expect(config.mediaStore).toBe('none');
    expect(config.mediaStoreBucket).toBe('genai-otel-media');
    expect(config.mediaStorePrefix).toBe('traces/{date}/{trace_id}/');
    expect(config.mediaMaxBytes).toBe(10 * 1024 * 1024);
    expect(config.mediaAllowedModalities).toBe('image,audio,video,document');
    expect(config.piiMode).toBe('detect');
  });

  it('unset optional strings are undefined, never empty', () => {
    expect(config.customPricingJson).toBeUndefined();
    expect(config.co2CountryIsoCode).toBeUndefined();
    expect(config.co2Region).toBeUndefined();
    expect(config.co2CloudProvider).toBeUndefined();
    expect(config.co2CloudRegion).toBeUndefined();
    expect(config.toxicityPerspectiveApiKey).toBeUndefined();
    expect(config.mediaStoreEndpoint).toBeUndefined();
    expect(config.mediaRedactor).toBeUndefined();
  });

  it('evaluation thresholds', () => {
    expect(config.enablePiiDetection).toBe(false);
    expect(config.piiThreshold).toBe(0.5);
    expect(config.toxicityThreshold).toBe(0.7);
    expect(config.biasThreshold).toBe(0.4);
    expect(config.promptInjectionThreshold).toBe(0.5);
    expect(config.restrictedTopicsThreshold).toBe(0.7);
    expect(config.hallucinationThreshold).toBe(0.6);
  });

  it('enabled instrumentors default to the reference list, as a copy', () => {
    expect(config.enabledInstrumentors).toEqual(DEFAULT_INSTRUMENTORS);
    expect(config.enabledInstrumentors).not.toBe(DEFAULT_INSTRUMENTORS);
    expect(DEFAULT_INSTRUMENTORS.slice(0, 4)).toEqual(['openai', 'openrouter', 'cometapi', 'anthropic']);
    expect(DEFAULT_INSTRUMENTORS).toContain('typesafe');
    expect(DEFAULT_INSTRUMENTORS).not.toContain('mcp');
    expect(DEFAULT_INSTRUMENTORS).not.toContain('hyperbolic');
  });
});

describe('loadConfig parsing follows the Python expressions exactly', () => {
  it('booleans are `value.lower() == "true"` with no stripping', () => {
    expect(load({ GENAI_ENABLE_GPU_METRICS: 'TRUE' }).enableGpuMetrics).toBe(true);
    expect(load({ GENAI_ENABLE_GPU_METRICS: 'yes' }).enableGpuMetrics).toBe(false);
    expect(load({ GENAI_ENABLE_GPU_METRICS: '1' }).enableGpuMetrics).toBe(false);
    expect(load({ GENAI_ENABLE_GPU_METRICS: ' true' }).enableGpuMetrics).toBe(false);
    expect(load({ GENAI_ENABLE_GPU_METRICS: '' }).enableGpuMetrics).toBe(false);
    expect(load({ GENAI_FAIL_ON_ERROR: 'True' }).failOnError).toBe(true);
  });

  it('the two booleans Python strips are stripped', () => {
    expect(load({ GENAI_CAPTURE_EMBEDDING_VECTORS: ' true ' }).captureEmbeddingVectors).toBe(true);
    expect(load({ GENAI_ENABLE_CONTENT_CAPTURE: ' TRUE ' }).enableContentCapture).toBe(true);
  });

  it('a set-but-empty string stays empty rather than falling back to the default', () => {
    expect(load({ OTEL_SERVICE_NAME: '' }).serviceName).toBe('');
    expect(load({ OTEL_EXPORTER_OTLP_ENDPOINT: '' }).endpoint).toBe('');
    expect(load({ GENAI_CUSTOM_PRICING_JSON: '' }).customPricingJson).toBe('');
  });

  it('profile and metrics profile are lowercased; other strings are verbatim', () => {
    expect(load({ GENAI_PROFILE: 'BFSI' }).profile).toBe('bfsi');
    expect(load({ GENAI_METRICS_PROFILE: 'Full' }).metricsProfile).toBe('full');
    expect(load({ GENAI_PII_MODE: 'Redact' }).piiMode).toBe('Redact');
  });

  it('GENAI_ENABLED_INSTRUMENTORS is split on commas and stripped; empty means the default list', () => {
    expect(load({ GENAI_ENABLED_INSTRUMENTORS: 'openai, anthropic ,x' }).enabledInstrumentors).toEqual([
      'openai',
      'anthropic',
      'x',
    ]);
    expect(load({ GENAI_ENABLED_INSTRUMENTORS: 'openai,,' }).enabledInstrumentors).toEqual(['openai', '', '']);
    expect(load({ GENAI_ENABLED_INSTRUMENTORS: '' }).enabledInstrumentors).toEqual(DEFAULT_INSTRUMENTORS);
  });

  it('OTEL_EXPORTER_OTLP_TIMEOUT falls back to 60 with a warning on garbage', () => {
    const warn = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    expect(load({ OTEL_EXPORTER_OTLP_TIMEOUT: '15' }).exporterTimeout).toBe(15);
    expect(warn).not.toHaveBeenCalled();
    expect(load({ OTEL_EXPORTER_OTLP_TIMEOUT: '1.5' }).exporterTimeout).toBe(60);
    expect(load({ OTEL_EXPORTER_OTLP_TIMEOUT: 'abc' }).exporterTimeout).toBe(60);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('OTEL_EXPORTER_OTLP_TIMEOUT');
  });

  it('a garbage float or int raises, naming the variable (Python raises ValueError)', () => {
    expect(() => load({ GENAI_SAMPLING_RATE: 'abc' })).toThrow(ConfigError);
    expect(() => load({ GENAI_SAMPLING_RATE: 'abc' })).toThrow(/GENAI_SAMPLING_RATE/);
    expect(() => load({ GENAI_GPU_COLLECTION_INTERVAL: '5.5' })).toThrow(/GENAI_GPU_COLLECTION_INTERVAL/);
    expect(() => load({ GENAI_CONTENT_MAX_LENGTH: 'many' })).toThrow(ConfigError);
    expect(() => load({ GENAI_CARBON_INTENSITY: '' })).toThrow(ConfigError);
  });

  it('numbers parse with Python tolerance', () => {
    expect(load({ GENAI_SAMPLING_RATE: ' 0.1 ' }).samplingRate).toBe(0.1);
    expect(load({ GENAI_CONTENT_MAX_LENGTH: '0' }).contentMaxLength).toBe(0);
    expect(load({ GENAI_OTEL_MEDIA_MAX_BYTES: '1_024' }).mediaMaxBytes).toBe(1024);
  });
});

describe('content capture resolution', () => {
  const VAR = 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';

  it.each([
    ['NO_CONTENT', false],
    ['SPAN_ONLY', true],
    ['EVENT_ONLY', false],
    ['SPAN_AND_EVENT', true],
    ['span_only', true],
    ['  span_and_event  ', true],
  ])('%s -> %s', (mode, expected) => {
    expect(load({ [VAR]: mode }).enableContentCapture).toBe(expected);
  });

  it('the standard variable wins over GENAI_ENABLE_CONTENT_CAPTURE', () => {
    expect(load({ [VAR]: 'NO_CONTENT', GENAI_ENABLE_CONTENT_CAPTURE: 'true' }).enableContentCapture).toBe(false);
    expect(load({ [VAR]: 'SPAN_ONLY', GENAI_ENABLE_CONTENT_CAPTURE: 'false' }).enableContentCapture).toBe(true);
  });

  it('an unrecognised mode warns and means NO capture, even when our own variable says true', () => {
    const warn = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    expect(load({ [VAR]: 'everything', GENAI_ENABLE_CONTENT_CAPTURE: 'true' }).enableContentCapture).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a blank standard variable reads through to our own', () => {
    expect(load({ [VAR]: '   ', GENAI_ENABLE_CONTENT_CAPTURE: 'true' }).enableContentCapture).toBe(true);
  });
});

describe('hardening profiles', () => {
  it.each(['strict', 'bfsi', 'bank', 'BANK'])('%s forces egress off and air-gap on', (profile) => {
    const config = load({
      GENAI_PROFILE: profile,
      GENAI_ALLOW_EXTERNAL_EGRESS: 'true',
      GENAI_AIR_GAPPED: 'false',
      GENAI_CO2_OFFLINE_MODE: 'false',
      GENAI_TOXICITY_USE_PERSPECTIVE_API: 'true',
    });
    expect(config.allowExternalEgress).toBe(false);
    expect(config.airGapped).toBe(true);
    expect(config.co2OfflineMode).toBe(true);
    expect(config.toxicityUsePerspectiveApi).toBe(false);
    expect(config.enableContentCapture).toBe(true);
  });

  it('content capture pinned off under either spelling survives the profile', () => {
    expect(load({ GENAI_PROFILE: 'bfsi', GENAI_ENABLE_CONTENT_CAPTURE: 'false' }).enableContentCapture).toBe(false);
    expect(
      load({ GENAI_PROFILE: 'bfsi', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'NO_CONTENT' })
        .enableContentCapture,
    ).toBe(false);
  });

  it('an unknown profile changes nothing', () => {
    const config = load({ GENAI_PROFILE: 'relaxed' });
    expect(config.allowExternalEgress).toBe(true);
    expect(config.airGapped).toBe(false);
    expect(config.enableContentCapture).toBe(false);
  });

  it('the profile also applies when given as an override', () => {
    expect(load({}, { profile: 'bank' }).airGapped).toBe(true);
  });
});

describe('overrides', () => {
  it('explicit options beat the environment', () => {
    const config = load(
      { OTEL_SERVICE_NAME: 'from-env', GENAI_ENABLE_COST_TRACKING: 'true' },
      { serviceName: 'from-code', enableCostTracking: false, headers: { a: 'b' } },
    );
    expect(config.serviceName).toBe('from-code');
    expect(config.enableCostTracking).toBe(false);
    expect(config.headers).toEqual({ a: 'b' });
  });

  it('an override spares the environment variable from being parsed at all', () => {
    expect(load({ GENAI_SAMPLING_RATE: 'abc' }, { samplingRate: 0.5 }).samplingRate).toBe(0.5);
  });

  it('undefined overrides are ignored', () => {
    expect(load({ OTEL_SERVICE_NAME: 'svc' }, { serviceName: undefined }).serviceName).toBe('svc');
  });

  it('reads process.env by default', () => {
    const before = process.env.OTEL_SERVICE_NAME;
    process.env.OTEL_SERVICE_NAME = 'from-process-env';
    try {
      expect(loadConfig().serviceName).toBe('from-process-env');
    } finally {
      if (before === undefined) delete process.env.OTEL_SERVICE_NAME;
      else process.env.OTEL_SERVICE_NAME = before;
    }
  });
});

describe('CONFIG_FIELDS table', () => {
  it('every environment variable is declared once', () => {
    const names = CONFIG_FIELDS.map((field) => field.env);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('GENAI_ENABLE_COST_TRACKING');
    expect(names).toContain('OTEL_SEMCONV_STABILITY_OPT_IN');
  });
});
