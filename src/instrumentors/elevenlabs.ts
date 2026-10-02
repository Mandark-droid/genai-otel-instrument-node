/**
 * Instrumentor for `@elevenlabs/elevenlabs-js`. A port of
 * `genai_otel/instrumentors/elevenlabs_instrumentor.py`: text-to-speech
 * (`convert`, `stream`) and speech-to-text (`convert`).
 *
 * Audio is priced by the character (speech synthesis) or by the second
 * (transcription), not by the token.
 *
 * One difference in what is measured: the reference wraps the audio iterator
 * and so times the whole synthesis. The JavaScript client hands back a web
 * `ReadableStream`, usually consumed through a reader or piped, which cannot be
 * observed in place; the span here ends when the stream is handed over.
 */
import type { Span } from '@opentelemetry/api';
import { logger } from '../logger';
import { ATTR } from '../semconv';
import type { Params, UsageDict } from './base';
import { isObject, pick, type Obj } from './openai-shape';
import { exportedClass, prototypeDefining } from './patch';
import { PatchingInstrumentor, type PatchTarget } from './patching';

const DEFAULT_TTS_MODEL = 'eleven_multilingual_v2';
const DEFAULT_STT_MODEL = 'scribe_v1';
const PROVIDER = 'elevenlabs';

/** Characters as Python's `len(str)` counts them: code points. */
function characterCount(text: unknown): number {
  return typeof text === 'string' ? [...text].length : 0;
}

export class ElevenLabsInstrumentor extends PatchingInstrumentor {
  protected readonly label = 'ElevenLabs';
  protected readonly packages = ['@elevenlabs/elevenlabs-js'];

  protected targets(module: unknown): PatchTarget[] {
    const Client = exportedClass(module, 'ElevenLabsClient') as (new (options: Record<string, unknown>) => Obj) | undefined;
    if (typeof Client !== 'function') return [];
    // The resource classes are reached through an instance; constructing a
    // client opens no connection.
    let client: Obj;
    try {
      client = new Client({ apiKey: 'instrumentation-probe' });
    } catch {
      return [];
    }
    const tts = client.textToSpeech;
    const stt = client.speechToText;
    const targets: PatchTarget[] = [];
    for (const method of ['convert', 'stream']) {
      targets.push({
        holder: prototypeDefining(tts, method),
        method,
        spanName: `elevenlabs.text_to_speech.${method}`,
        attributes: (_instance, _args, params) => this.ttsAttributes(params),
        // convert(voiceId, { text, modelId, outputFormat })
        options: { params: (args) => ({ ...(isObject(args[1]) ? args[1] : {}), voiceId: args[0], operation: 'tts' }) },
      });
    }
    targets.push({
      holder: prototypeDefining(stt, 'convert'),
      method: 'convert',
      spanName: 'elevenlabs.speech_to_text.convert',
      attributes: (_instance, _args, params) => this.sttAttributes(params),
      options: { params: (args) => ({ ...(isObject(args[0]) ? args[0] : {}), operation: 'stt' }) },
    });
    return targets;
  }

  private ttsAttributes(params: Params): Obj {
    const attributes: Obj = {
      [ATTR.GEN_AI_PROVIDER_NAME]: PROVIDER,
      [ATTR.GEN_AI_REQUEST_MODEL]: String(pick(params, 'modelId', 'model_id') ?? DEFAULT_TTS_MODEL),
      [ATTR.GEN_AI_OPERATION_NAME]: 'text_to_speech',
      [ATTR.GEN_AI_REQUEST_TYPE]: 'text_to_speech',
      [ATTR.GEN_AI_USAGE_CHARACTERS]: characterCount(params.text),
      [ATTR.GEN_AI_REQUEST_STREAMED]: true,
    };
    if (params.voiceId) attributes[ATTR.GEN_AI_REQUEST_VOICE_ID] = String(params.voiceId);
    const outputFormat = pick(params, 'outputFormat', 'output_format');
    if (outputFormat) {
      attributes['elevenlabs.output_format'] = String(outputFormat);
      attributes[ATTR.GEN_AI_RESPONSE_OUTPUT_FORMAT] = String(outputFormat);
    }
    return attributes;
  }

  private sttAttributes(params: Params): Obj {
    const attributes: Obj = {
      [ATTR.GEN_AI_PROVIDER_NAME]: PROVIDER,
      [ATTR.GEN_AI_REQUEST_MODEL]: String(pick(params, 'modelId', 'model_id') ?? DEFAULT_STT_MODEL),
      [ATTR.GEN_AI_OPERATION_NAME]: 'speech_to_text',
      [ATTR.GEN_AI_REQUEST_TYPE]: 'speech_to_text',
    };
    const language = pick(params, 'languageCode', 'language_code');
    if (language) attributes[ATTR.GEN_AI_REQUEST_LANGUAGE_CODE] = String(language);
    return attributes;
  }

  /** There are no tokens in an audio call. */
  protected extractUsage(): UsageDict | null {
    return null;
  }

  protected override recordResultMetrics(span: Span, spanName: string, result: unknown, startTime: number, params: Params): void {
    super.recordResultMetrics(span, spanName, result, startTime, params);
    try {
      if (params.operation === 'tts') {
        const model = String(pick(params, 'modelId', 'model_id') ?? DEFAULT_TTS_MODEL);
        this.recordMediaCost(span, model, { characters: characterCount(params.text) });
        return;
      }
      const model = String(pick(params, 'modelId', 'model_id') ?? DEFAULT_STT_MODEL);
      const seconds = pick(result, 'audioDurationSecs', 'audio_duration_secs');
      if (typeof seconds === 'number' && seconds > 0) {
        span.setAttribute(ATTR.GEN_AI_USAGE_AUDIO_DURATION_SECONDS, seconds);
        this.recordMediaCost(span, model, { seconds });
      } else {
        logger.debug('ElevenLabs transcription returned no audio duration; cost not recorded');
      }
      const text = isObject(result) ? result.text : undefined;
      if (typeof text === 'string') span.setAttribute(ATTR.GEN_AI_RESPONSE_TRANSCRIPT_LENGTH, characterCount(text));
      const language = pick(result, 'languageCode', 'language_code');
      if (language) span.setAttribute(ATTR.GEN_AI_RESPONSE_LANGUAGE_CODE, String(language));
    } catch (error) {
      logger.debug(`Failed to record ElevenLabs result: ${String(error)}`);
    }
  }

  /**
   * Cost by the character or by the second. The pricing table keys the TTS
   * models bare and Scribe under the provider (`elevenlabs/scribe_v1`), so the
   * qualified name is tried first. A cost is written only when a rate is
   * found: a zero for an unpriced model would read as "this was free".
   */
  private recordMediaCost(span: Span, model: string, usage: UsageDict): void {
    if (!this.config?.enableCostTracking) return;
    let cost: number | null = null;
    try {
      cost = this.costCalculator.calculateCost(`${PROVIDER}/${model}`, usage, 'audio');
      if (!cost) cost = this.costCalculator.calculateCost(model, usage, 'audio');
    } catch (error) {
      logger.debug(`Failed to price ElevenLabs model ${model}: ${String(error)}`);
    }
    if (cost && cost > 0) {
      span.setAttribute(ATTR.GEN_AI_USAGE_COST_TOTAL, cost);
      this.metrics.counters.cost.add(cost, { model, provider: PROVIDER });
    }
  }
}

