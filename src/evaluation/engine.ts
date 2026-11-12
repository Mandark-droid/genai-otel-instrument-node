/**
 * Evaluation of spans: the detectors run over a span's prompt and response,
 * and what they find goes onto the span as `evaluation.*` attributes and into
 * the `genai.evaluation.*` metrics. Port of `evaluation/span_processor.py` and
 * of the evaluation hooks of `instrumentors/base.py`.
 *
 * In the reference a finished span cannot be written, so its instrumentors run
 * the detectors themselves before ending a span and a span processor repeats
 * the work for spans of other instrumentation. Here the SDK calls `onEnding`
 * while a span is still writable, so one processor does it for every span. An
 * instrumented call hands over the texts it saw (`rememberTexts`) - the whole
 * prompt and the response, whether or not content capture is on; they are read
 * and not recorded.
 *
 * Blocking. `block_on_detection` and PII `block` mode do two different things,
 * as in the reference: on an instrumented call the prompt is checked BEFORE
 * the provider is called and the call throws `PolicyViolationError`; on any
 * other span the processor can only annotate what already happened.
 */
import { metrics, SpanStatusCode, type AttributeValue, type Counter, type Histogram } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { OTelConfig } from '../config';
import { logger } from '../logger';
import { createCounter, createHistogram } from '../metrics';
import { stateSlot } from '../state';
import {
  BiasDetector,
  HallucinationDetector,
  PIIDetector,
  PromptInjectionDetector,
  RestrictedTopicsDetector,
  ToxicityDetector,
  type BiasConfig,
  type HallucinationConfig,
  type PIIConfig,
  type PIIMode,
  type PromptInjectionConfig,
  type RestrictedTopicsConfig,
  type ToxicityConfig,
  type ToxicityDetectionResult,
  type ToxicityScorer,
} from './detectors';

export const EVALUATION_METER_NAME = 'genai_otel.evaluation.span_processor';

/**
 * Thrown to stop a model request before it is sent: a detector configured to
 * block flagged the prompt. Not an instrumentation failure - a decision the
 * application asked for, so it reaches the caller.
 */
export class PolicyViolationError extends Error {
  readonly policy: string | undefined;
  readonly details: Record<string, unknown>;

  constructor(message: string, options: { policy?: string; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'PolicyViolationError';
    this.policy = options.policy;
    this.details = options.details ?? {};
  }
}

export interface EvaluationConfigs {
  pii?: Partial<PIIConfig>;
  toxicity?: Partial<ToxicityConfig>;
  bias?: Partial<BiasConfig>;
  promptInjection?: Partial<PromptInjectionConfig>;
  restrictedTopics?: Partial<RestrictedTopicsConfig>;
  hallucination?: Partial<HallucinationConfig>;
}

/** The detector configurations `instrument()` builds from its own, or undefined when no detector is enabled. */
export function evaluationConfigsFrom(config: OTelConfig): EvaluationConfigs | undefined {
  const configs: EvaluationConfigs = {};
  if (config.enablePiiDetection) {
    configs.pii = {
      enabled: true,
      mode: config.piiMode as PIIMode,
      threshold: config.piiThreshold,
      gdprMode: config.piiGdprMode,
      hipaaMode: config.piiHipaaMode,
      pciDssMode: config.piiPciDssMode,
      customPatterns: config.piiCustomPatterns as PIIConfig['customPatterns'],
      airGapped: config.airGapped,
      contentMaxLength: config.contentMaxLength,
      cacheSize: config.evaluationCacheSize,
    };
  }
  if (config.enableToxicityDetection) {
    configs.toxicity = {
      enabled: true,
      threshold: config.toxicityThreshold,
      usePerspectiveApi: config.toxicityUsePerspectiveApi,
      perspectiveApiKey: config.toxicityPerspectiveApiKey ?? null,
      blockOnDetection: config.toxicityBlockOnDetection,
      allowExternalEgress: config.allowExternalEgress,
      airGapped: config.airGapped,
      cacheSize: config.evaluationCacheSize,
      quantize: config.toxicityQuantize,
      torchThreads: config.toxicityTorchThreads ?? null,
    };
  }
  // Every detector keeps a bounded cache of its results (GENAI_EVALUATION_CACHE_SIZE; 0 turns it off).
  const cacheSize = config.evaluationCacheSize;
  if (config.enableBiasDetection) {
    configs.bias = { enabled: true, threshold: config.biasThreshold, blockOnDetection: config.biasBlockOnDetection, cacheSize };
  }
  if (config.enablePromptInjectionDetection) {
    configs.promptInjection = {
      enabled: true,
      threshold: config.promptInjectionThreshold,
      blockOnDetection: config.promptInjectionBlockOnDetection,
      cacheSize,
    };
  }
  if (config.enableRestrictedTopics) {
    configs.restrictedTopics = {
      enabled: true,
      threshold: config.restrictedTopicsThreshold,
      blockOnDetection: config.restrictedTopicsBlockOnDetection,
      cacheSize,
    };
  }
  if (config.enableHallucinationDetection) configs.hallucination = { enabled: true, threshold: config.hallucinationThreshold, cacheSize };
  return Object.keys(configs).length > 0 ? configs : undefined;
}

// --- what the application supplies -------------------------------------------

const scorerSlot = (): { scorer?: ToxicityScorer; timeoutSeconds?: number } => stateSlot('evaluation.toxicity-scorer', () => ({}));

/** How long a span waits for a scorer that answers with a promise. */
const DEFAULT_SCORER_TIMEOUT_SECONDS = 5;

/** The time a span waits for a toxicity score: as set with `setToxicityScorer`, else 5 s. */
export function toxicityWaitSeconds(): number {
  return scorerSlot().timeoutSeconds ?? DEFAULT_SCORER_TIMEOUT_SECONDS;
}

/**
 * Give the toxicity detector something to measure with: a function returning
 * a score from 0 to 1 per category. Call it before `instrument()`. Without
 * one, toxicity is not measured and nothing about it is written.
 */
export function setToxicityScorer(scorer: ToxicityScorer | undefined, options: { timeoutSeconds?: number } = {}): void {
  const slot = scorerSlot();
  slot.scorer = scorer;
  slot.timeoutSeconds = options.timeoutSeconds;
}

// --- the texts of an instrumented call ---------------------------------------

interface Texts {
  prompt?: string;
  response?: string;
  /** Toxicity as measured ahead of the span's end; a location that is present was attempted. */
  toxicity?: Partial<Record<'prompt' | 'response', ToxicityDetectionResult | undefined>>;
}

const textsSlot = (): WeakMap<object, Texts> => stateSlot('evaluation.texts', () => new WeakMap<object, Texts>());

/** Hand the texts of a call to the evaluation of its span. They are not recorded anywhere. */
export function rememberTexts(span: object, texts: Texts): void {
  const map = textsSlot();
  map.set(span, { ...map.get(span), ...texts });
}

/** The prompt of a request, for evaluation: every message's text, then a plain `prompt`. */
export function promptForEvaluation(params: Record<string, unknown>): string | undefined {
  const messages = params.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const parts: string[] = [];
    for (const message of messages) {
      const content = typeof message === 'object' && message !== null ? (message as { content?: unknown }).content : undefined;
      if (typeof content === 'string') parts.push(content);
      else if (Array.isArray(content)) {
        for (const block of content) {
          const text = typeof block === 'object' && block !== null ? (block as { text?: unknown }).text : undefined;
          if (typeof text === 'string') parts.push(text);
        }
      }
    }
    const joined = parts.filter((part) => part).join('\n');
    if (joined) return joined;
  }
  return typeof params.prompt === 'string' ? params.prompt : undefined;
}

/** The text of a chat or completion result, where it has the OpenAI shape. */
export function responseForEvaluation(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const choices = (result as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown } | null;
  if (typeof first !== 'object' || first === null) return undefined;
  if (first.message !== undefined) return typeof first.message?.content === 'string' ? first.message.content : undefined;
  return typeof first.text === 'string' ? first.text : undefined;
}

// --- reading a span of other instrumentation ---------------------------------

type Attributes = Record<string, unknown>;

const PROMPT_KEYS = ['gen_ai.prompt', 'gen_ai.prompt.0.content', 'gen_ai.request.prompt', 'gen_ai.request.first_message', 'llm.prompts', 'gen_ai.content.prompt'];
const RESPONSE_KEYS = ['gen_ai.response', 'gen_ai.completion', 'gen_ai.response.0.content', 'llm.responses', 'gen_ai.content.completion', 'gen_ai.response.message.content'];
const CONTEXT_KEYS = ['gen_ai.context', 'gen_ai.retrieval.documents', 'gen_ai.rag.context'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `{content}` or `[{content}, ...]` or `["text", ...]`: the first content. `undefined` when the shape is none of these. */
function contentOf(parsed: unknown): string | undefined {
  if (isRecord(parsed) && 'content' in parsed) return String(parsed.content);
  if (Array.isArray(parsed) && parsed.length > 0) {
    const first: unknown = parsed[0];
    if (isRecord(first) && 'content' in first) return String(first.content);
    if (typeof first === 'string') return first;
  }
  return undefined;
}

function messageContent(message: unknown): { content?: unknown; role?: unknown } {
  if (!isRecord(message)) return {};
  const inner = isRecord(message.message) ? message.message : {};
  return { content: inner.content || message.content, role: inner.role || message.role };
}

function promptFromEvents(span: ReadableSpan): string | undefined {
  const parts: string[] = [];
  for (const event of span.events ?? []) {
    if (!event.name.startsWith('gen_ai.prompt')) continue;
    const content = event.attributes?.['gen_ai.prompt.content'];
    if (content) parts.push(String(content));
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function promptFromAttributes(attributes: Attributes): string | undefined {
  for (const key of PROMPT_KEYS) {
    if (!(key in attributes)) continue;
    const value = attributes[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
      try {
        const content = contentOf(JSON.parse(value));
        if (content !== undefined) return content;
      } catch {
        // Not JSON: a Python-style dict string, as this library's own `first_message` is.
        const match = /['"]content['"]:\s*(['"])([\s\S]*)/.exec(value);
        if (!match) return value;
        const quote = match[1] as string;
        const rest = match[2] as string;
        const end = rest.lastIndexOf(quote);
        return end >= 0 ? rest.slice(0, end) : rest;
      }
    } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
      return value[0];
    }
  }
  if ('llm.input_messages' in attributes) {
    try {
      const raw = attributes['llm.input_messages'];
      const messages: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(messages) && messages.length > 0) {
        // The last user message; else the first message.
        for (const message of [...messages].reverse()) {
          const { content, role } = messageContent(message);
          if (content && String(role ?? '').toLowerCase() === 'user') return String(content);
        }
        const first: unknown = messages[0];
        if (typeof first === 'string') return first;
        const { content } = messageContent(first);
        if (content) return String(content);
      }
    } catch (error) {
      logger.debug(`Failed to parse llm.input_messages: ${String(error)}`);
    }
  }
  const input = attributes['input.value'];
  if (typeof input === 'string' && input) {
    try {
      const parsed: unknown = JSON.parse(input);
      if (isRecord(parsed) || (Array.isArray(parsed) && parsed.length > 0)) return contentOf(parsed);
      return input;
    } catch {
      return input;
    }
  }
  return undefined;
}

function responseFromAttributes(attributes: Attributes): string | undefined {
  for (const key of RESPONSE_KEYS) {
    if (!(key in attributes)) continue;
    const value = attributes[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') return value[0];
  }
  if ('llm.output_messages' in attributes) {
    try {
      const raw = attributes['llm.output_messages'];
      const messages: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(messages) && messages.length > 0) {
        const first: unknown = messages[0];
        if (typeof first === 'string') return first;
        const { content } = messageContent(first);
        if (content) return String(content);
      }
    } catch (error) {
      logger.debug(`Failed to parse llm.output_messages: ${String(error)}`);
    }
  }
  const output = attributes['output.value'];
  return output ? String(output) : undefined;
}

// --- the engine ----------------------------------------------------------------

/** What the engine writes to. A span before it has ended. */
interface Writable {
  setAttribute(key: string, value: AttributeValue): unknown;
  setStatus(status: { code: SpanStatusCode; message?: string }): unknown;
}

type Location = 'prompt' | 'response';

interface Instruments {
  counter(name: Parameters<typeof createCounter>[1]): Counter;
  histogram(name: Parameters<typeof createHistogram>[1]): Histogram;
}

function instruments(): Instruments {
  // Looked up on use: the engine is built before the meter provider is registered.
  const meter = { get: (): ReturnType<typeof metrics.getMeter> => metrics.getMeter(EVALUATION_METER_NAME) };
  const counters = new Map<string, Counter>();
  const histograms = new Map<string, Histogram>();
  return {
    // Created on first use: a detector that never fires leaves no empty series behind.
    counter(name) {
      let counter = counters.get(name);
      if (!counter) counters.set(name, (counter = createCounter(meter.get(), name)));
      return counter;
    },
    histogram(name) {
      let histogram = histograms.get(name);
      if (!histogram) histograms.set(name, (histogram = createHistogram(meter.get(), name)));
      return histogram;
    },
  };
}

export class EvaluationEngine {
  readonly pii: PIIDetector | undefined;
  readonly toxicity: ToxicityDetector | undefined;
  readonly bias: BiasDetector | undefined;
  readonly promptInjection: PromptInjectionDetector | undefined;
  readonly restrictedTopics: RestrictedTopicsDetector | undefined;
  readonly hallucination: HallucinationDetector | undefined;
  /** The policies that stop a request before it is sent. */
  readonly blockingPolicies: ReadonlySet<string>;
  private readonly metrics = instruments();
  private readonly scorerTimeoutMs: number;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    configs: EvaluationConfigs,
    options: {
      toxicityScorer?: ToxicityScorer;
      scorerTimeoutSeconds?: number;
      /** Used when neither `toxicityScorer` nor `setToxicityScorer()` gave one: the judge of GENAI_TOXICITY_JUDGE_URL. */
      fallbackToxicityScorer?: ToxicityScorer;
    } = {},
  ) {
    this.scorerTimeoutMs = Math.max(1, (options.scorerTimeoutSeconds ?? scorerSlot().timeoutSeconds ?? DEFAULT_SCORER_TIMEOUT_SECONDS) * 1000);
    if (configs.pii?.enabled) this.pii = new PIIDetector(configs.pii);
    if (configs.toxicity?.enabled) {
      const scorer = options.toxicityScorer ?? scorerSlot().scorer ?? options.fallbackToxicityScorer;
      this.toxicity = new ToxicityDetector(configs.toxicity, scorer);
      if (!this.toxicity.isAvailable()) {
        logger.warn(
          'Toxicity detection is enabled but nothing measures it: set GENAI_TOXICITY_JUDGE_URL or supply a scorer with setToxicityScorer(). ' +
            'Until then no toxicity attribute or metric is written.',
        );
      }
    }
    if (configs.bias?.enabled) this.bias = new BiasDetector(configs.bias);
    if (configs.promptInjection?.enabled) this.promptInjection = new PromptInjectionDetector(configs.promptInjection);
    if (configs.restrictedTopics?.enabled) this.restrictedTopics = new RestrictedTopicsDetector(configs.restrictedTopics);
    if (configs.hallucination?.enabled) this.hallucination = new HallucinationDetector(configs.hallucination);

    const blocking = new Set<string>();
    if (this.pii?.config.mode === 'block') blocking.add('pii');
    if (this.toxicity?.config.blockOnDetection) blocking.add('toxicity');
    if (this.bias?.config.blockOnDetection) blocking.add('bias');
    if (this.promptInjection?.config.blockOnDetection) blocking.add('prompt_injection');
    if (this.restrictedTopics?.config.blockOnDetection) blocking.add('restricted_topics');
    this.blockingPolicies = blocking;
    if (blocking.size > 0) logger.info(`Pre-call BLOCK policy active for: ${[...blocking].sort().join(', ')}`);
  }

  get blockingActive(): boolean {
    return this.blockingPolicies.size > 0;
  }

  /**
   * Check a prompt against the blocking policies before the provider is
   * called. Throws `PolicyViolationError` when one triggers; the span says
   * which. A detector that fails does not block.
   */
  enforcePreCall(span: Writable, prompt: string | undefined): void {
    if (!this.blockingActive || !prompt) return;
    const checks: [string, (() => boolean) | undefined][] = [
      ['pii', this.pii && ((): boolean => (this.pii as PIIDetector).detect(prompt).hasPii)],
      ['toxicity', this.toxicity && ((): boolean => (this.toxicity as ToxicityDetector).measure(prompt)?.isToxic === true)],
      ['prompt_injection', this.promptInjection && ((): boolean => (this.promptInjection as PromptInjectionDetector).detect(prompt).isInjection)],
      ['restricted_topics', this.restrictedTopics && ((): boolean => (this.restrictedTopics as RestrictedTopicsDetector).detect(prompt).hasRestrictedTopic)],
      ['bias', this.bias && ((): boolean => (this.bias as BiasDetector).detect(prompt).hasBias)],
    ];
    const triggered: string[] = [];
    for (const [name, check] of checks) {
      if (!this.blockingPolicies.has(name) || !check) continue;
      let flagged = false;
      try {
        flagged = check();
      } catch (error) {
        logger.warn(`Pre-call ${name} policy check failed: ${String(error)}`);
        continue;
      }
      if (!flagged) continue;
      setQuietly(span, `evaluation.${name}.prompt.blocked`, true);
      triggered.push(name);
    }
    if (triggered.length === 0) return;
    setQuietly(span, 'evaluation.blocked', true);
    setQuietly(span, 'evaluation.blocked_reasons', triggered);
    throw new PolicyViolationError(`Request blocked by evaluation policy: ${triggered.join(', ')}`, {
      policy: triggered[0],
      details: { reasons: triggered },
    });
  }

  /**
   * Measure, ahead of a span's end, what cannot be measured while it ends: a
   * toxicity scorer that answers with a promise. Returns a promise to wait for
   * before ending the span, or `undefined` when there is nothing to wait for.
   * The promise never rejects and is bounded by the scorer timeout.
   */
  prepare(span: object): Promise<void> | undefined {
    const detector = this.toxicity;
    const texts = textsSlot().get(span);
    if (!detector?.isAvailable() || !texts) return undefined;
    const measured: NonNullable<Texts['toxicity']> = {};
    const waiting: Promise<void>[] = [];
    for (const location of ['prompt', 'response'] as const) {
      const text = texts[location];
      if (!text) continue;
      const outcome = detector.score(text);
      if (outcome instanceof Promise) {
        waiting.push(
          outcome.then((result) => {
            measured[location] = result;
          }),
        );
      } else {
        measured[location] = outcome;
      }
    }
    if (waiting.length === 0) {
      texts.toxicity = measured;
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.warn(`Toxicity scorer did not answer within ${this.scorerTimeoutMs} ms; the span ends without it`);
        resolve();
      }, this.scorerTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    const settled = Promise.race([Promise.all(waiting).then(() => undefined), timeout]).then(() => {
      if (timer !== undefined) clearTimeout(timer);
      // What answered in time counts; what did not is absent, and stays attempted.
      texts.toxicity = { ...measured };
      for (const location of ['prompt', 'response'] as const) if (texts[location] && !(location in texts.toxicity)) texts.toxicity[location] = undefined;
    });
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return settled;
  }

  /** Settles when no span is waiting for a scorer any more. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** Run every enabled detector and write what it found. Never throws. */
  evaluate(span: Writable, prompt: string | undefined, response: string | undefined, attributes: Attributes = {}): void {
    // Whether any detector wrote a result: `evaluation.completed` says something was evaluated (section 12).
    let results = 0;
    const set = (key: string, value: AttributeValue): void => {
      results += 1;
      setQuietly(span, key, value);
    };
    const guard = (name: string, check: () => void): void => {
      try {
        check();
      } catch (error) {
        logger.error(`Error checking ${name}: ${String(error)}`);
        set(`evaluation.${name}.error`, String(error));
      }
    };
    if (this.pii) guard('pii', () => this.checkPii(span, set, prompt, response));
    if (this.toxicity) guard('toxicity', () => this.checkToxicity(span, set, prompt, response));
    if (this.bias) guard('bias', () => this.checkBias(span, set, prompt, response));
    if (this.promptInjection) guard('prompt_injection', () => this.checkPromptInjection(span, set, prompt));
    if (this.restrictedTopics) guard('restricted_topics', () => this.checkRestrictedTopics(span, set, prompt, response));
    if (this.hallucination) guard('hallucination', () => this.checkHallucination(set, prompt, response, attributes));
    if (results > 0) set('evaluation.completed', true);
  }

  private each(prompt: string | undefined, response: string | undefined, check: (text: string, location: Location, blockedWord: string) => void): void {
    if (prompt) check(prompt, 'prompt', 'Request');
    if (response) check(response, 'response', 'Response');
  }

  private checkPii(span: Writable, set: Setter, prompt: string | undefined, response: string | undefined): void {
    const detector = this.pii as PIIDetector;
    this.each(prompt, response, (text, location, word) => {
      const result = detector.detect(text);
      const prefix = `evaluation.pii.${location}`;
      if (!result.hasPii) return set(`${prefix}.detected`, false);
      set(`${prefix}.detected`, true);
      set(`${prefix}.entity_count`, result.entities.length);
      set(`${prefix}.entity_types`, Object.keys(result.entityCounts));
      set(`${prefix}.score`, result.score);
      this.metrics.counter('genai.evaluation.pii.detections').add(1, { location, mode: detector.config.mode });
      for (const [type, count] of Object.entries(result.entityCounts)) {
        set(`${prefix}.${type.toLowerCase()}_count`, count);
        this.metrics.counter('genai.evaluation.pii.entities').add(count, { entity_type: type, location });
      }
      if (result.blocked) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `${word} blocked due to PII detection` });
        set(`${prefix}.blocked`, true);
        this.metrics.counter('genai.evaluation.pii.blocked').add(1, { location });
      }
      if (result.redactedText) set(`${prefix}.redacted`, result.redactedText);
    });
  }

  private checkToxicity(span: Writable, set: Setter, prompt: string | undefined, response: string | undefined): void {
    const detector = this.toxicity as ToxicityDetector;
    this.each(prompt, response, (text, location, word) => {
      // Nothing measured it: nothing is said about it. Not even "false".
      const ahead = textsSlot().get(span)?.toxicity;
      const result = ahead && location in ahead ? ahead[location] : detector.measure(text);
      if (!result) return;
      const prefix = `evaluation.toxicity.${location}`;
      if (!result.isToxic) return set(`${prefix}.detected`, false);
      set(`${prefix}.detected`, true);
      set(`${prefix}.max_score`, result.maxScore);
      set(`${prefix}.categories`, result.toxicCategories);
      for (const [category, score] of Object.entries(result.scores)) set(`${prefix}.${category}_score`, score);
      this.metrics.counter('genai.evaluation.toxicity.detections').add(1, { location });
      this.metrics.histogram('genai.evaluation.toxicity.score').record(result.maxScore, { location });
      for (const category of result.toxicCategories) this.metrics.counter('genai.evaluation.toxicity.categories').add(1, { category, location });
      if (result.blocked) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `${word} blocked due to toxic content` });
        set(`${prefix}.blocked`, true);
        this.metrics.counter('genai.evaluation.toxicity.blocked').add(1, { location });
      }
    });
  }

  private checkBias(span: Writable, set: Setter, prompt: string | undefined, response: string | undefined): void {
    const detector = this.bias as BiasDetector;
    this.each(prompt, response, (text, location, word) => {
      const result = detector.detect(text);
      const prefix = `evaluation.bias.${location}`;
      if (!result.hasBias) return set(`${prefix}.detected`, false);
      set(`${prefix}.detected`, true);
      set(`${prefix}.max_score`, result.maxScore);
      set(`${prefix}.detected_biases`, result.detectedBiases);
      for (const [type, score] of Object.entries(result.biasScores)) if (score > 0) set(`${prefix}.${type}_score`, score);
      for (const [type, patterns] of Object.entries(result.patternsMatched)) set(`${prefix}.${type}_patterns`, patterns.slice(0, 5));
      this.metrics.counter('genai.evaluation.bias.detections').add(1, { location });
      this.metrics.histogram('genai.evaluation.bias.score').record(result.maxScore, { location });
      for (const type of result.detectedBiases) this.metrics.counter('genai.evaluation.bias.types').add(1, { bias_type: type, location });
      if (detector.config.blockOnDetection) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `${word} blocked due to bias detection` });
        set(`${prefix}.blocked`, true);
        this.metrics.counter('genai.evaluation.bias.blocked').add(1, { location });
      }
    });
  }

  private checkPromptInjection(span: Writable, set: Setter, prompt: string | undefined): void {
    if (!prompt) return;
    const result = (this.promptInjection as PromptInjectionDetector).detect(prompt);
    const prefix = 'evaluation.prompt_injection';
    if (!result.isInjection) return set(`${prefix}.detected`, false);
    set(`${prefix}.detected`, true);
    set(`${prefix}.score`, result.injectionScore);
    set(`${prefix}.types`, result.injectionTypes);
    for (const [type, patterns] of Object.entries(result.patternsMatched)) set(`${prefix}.${type}_patterns`, patterns.slice(0, 5));
    this.metrics.counter('genai.evaluation.prompt_injection.detections').add(1, { location: 'prompt' });
    this.metrics.histogram('genai.evaluation.prompt_injection.score').record(result.injectionScore, { location: 'prompt' });
    for (const type of result.injectionTypes) this.metrics.counter('genai.evaluation.prompt_injection.types').add(1, { injection_type: type });
    if (result.blocked) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Request blocked due to prompt injection attempt' });
      set(`${prefix}.blocked`, true);
      this.metrics.counter('genai.evaluation.prompt_injection.blocked').add(1, {});
    }
  }

  private checkRestrictedTopics(span: Writable, set: Setter, prompt: string | undefined, response: string | undefined): void {
    const detector = this.restrictedTopics as RestrictedTopicsDetector;
    this.each(prompt, response, (text, location, word) => {
      const result = detector.detect(text);
      const prefix = `evaluation.restricted_topics.${location}`;
      if (!result.hasRestrictedTopic) return set(`${prefix}.detected`, false);
      set(`${prefix}.detected`, true);
      set(`${prefix}.max_score`, result.maxScore);
      set(`${prefix}.topics`, result.detectedTopics);
      for (const [topic, score] of Object.entries(result.topicScores)) if (score > 0) set(`${prefix}.${topic}_score`, score);
      this.metrics.counter('genai.evaluation.restricted_topics.detections').add(1, { location });
      this.metrics.histogram('genai.evaluation.restricted_topics.score').record(result.maxScore, { location });
      for (const topic of result.detectedTopics) this.metrics.counter('genai.evaluation.restricted_topics.types').add(1, { topic, location });
      if (result.blocked) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `${word} blocked due to restricted topic` });
        set(`${prefix}.blocked`, true);
        this.metrics.counter('genai.evaluation.restricted_topics.blocked').add(1, { location });
      }
    });
  }

  private checkHallucination(set: Setter, prompt: string | undefined, response: string | undefined, attributes: Attributes): void {
    if (!response) return;
    // The prompt is the context; retrieved documents on the span are added to it.
    let context = prompt;
    for (const key of CONTEXT_KEYS) {
      if (!(key in attributes)) continue;
      const value = attributes[key];
      if (typeof value === 'string') {
        context = context ? `${context}\n${value}` : value;
        break;
      }
    }
    const result = (this.hallucination as HallucinationDetector).detect(response, context);
    const prefix = 'evaluation.hallucination.response';
    set(`${prefix}.detected`, result.hasHallucination);
    set(`${prefix}.score`, result.hallucinationScore);
    set(`${prefix}.citations`, result.citationCount);
    set(`${prefix}.hedge_words`, result.hedgeWordsCount);
    set(`${prefix}.claims`, result.factualClaimCount);
    if (!result.hasHallucination) return;
    set(`${prefix}.indicators`, result.hallucinationIndicators);
    if (result.unsupportedClaims.length > 0) set(`${prefix}.unsupported_claims`, result.unsupportedClaims.slice(0, 3));
    this.metrics.counter('genai.evaluation.hallucination.detections').add(1, { location: 'response' });
    this.metrics.histogram('genai.evaluation.hallucination.score').record(result.hallucinationScore, { location: 'response' });
    for (const indicator of result.hallucinationIndicators) this.metrics.counter('genai.evaluation.hallucination.indicators').add(1, { indicator });
  }
}

type Setter = (key: string, value: AttributeValue) => void;

function setQuietly(span: Writable, key: string, value: AttributeValue): void {
  try {
    span.setAttribute(key, value);
  } catch (error) {
    logger.debug(`Cannot set evaluation attribute '${key}' on span: ${String(error)}`);
  }
}

// --- the engine in force, for the instrumentors -------------------------------

const engineSlot = (): { engine?: EvaluationEngine } => stateSlot('evaluation.engine', () => ({}));

export function setActiveEvaluation(engine: EvaluationEngine | undefined): void {
  engineSlot().engine = engine;
}

export function activeEvaluation(): EvaluationEngine | undefined {
  return engineSlot().engine;
}

// --- the processor ---------------------------------------------------------------

export class EvaluationSpanProcessor implements SpanProcessor {
  constructor(readonly engine: EvaluationEngine) {}

  onStart(): void {}

  /** Called by the SDK just before the span is ended, while it is still writable. */
  onEnding(span: Span): void {
    try {
      const attributes = span.attributes as Attributes;
      const known = textsSlot().get(span);
      // Evaluated already - by somebody else, or blocked before the call: once per span.
      if (attributes['evaluation.completed'] || Object.keys(attributes).some((key) => key.startsWith('evaluation.'))) return;
      const prompt = known?.prompt ?? promptFromEvents(span) ?? promptFromAttributes(attributes);
      const response = known?.response ?? responseFromAttributes(attributes);
      if (prompt === undefined && response === undefined) return;
      this.engine.evaluate(span, prompt, response, attributes);
    } catch (error) {
      logger.error(`Error in evaluation span processor: ${String(error)}`);
    }
  }

  onEnd(): void {}

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
