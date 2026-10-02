/**
 * Instrumentor for the `sarvamai` package. A port of
 * `genai_otel/instrumentors/sarvam_instrumentor.py`: chat completions, text
 * translate / transliterate / identify-language, speech-to-text (transcribe,
 * translate) and text-to-speech (convert, stream).
 *
 * Everything but chat is priced per thousand characters, from the
 * `speech_to_text` section of the pricing table - as the reference does.
 */
import type { Span } from '@opentelemetry/api';
import { logger } from '../logger';
import { ATTR } from '../semconv';
import type { Params, UsageDict } from './base';
import { isObject, OpenAIShapeInstrumentor, pick, type Obj } from './openai-shape';
import { exportedClass, prototypeDefining } from './patch';
import type { PatchTarget } from './patching';

type Operation =
  | 'chat'
  | 'translate'
  | 'transliterate'
  | 'identify_language'
  | 'stt'
  | 'stt_translate'
  | 'tts'
  | 'tts_stream';

/** Python's `len(str)`: code points. */
function characterCount(text: unknown): number {
  return text ? [...String(text)].length : 0;
}

/** The SDK spells the TTS model `bulbul:v2`; the pricing table keys it `bulbul-v2`. */
function normaliseTtsModel(model: string): string {
  return model.startsWith('bulbul') ? model.replace(/:/g, '-') : model;
}

/** A parameter under its snake_case (wire) or camelCase name; `fallback` when not given. */
function param(params: Params, snake: string, fallback?: unknown): unknown {
  const camel = snake.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return pick(params, snake, camel) ?? fallback;
}

export class SarvamInstrumentor extends OpenAIShapeInstrumentor {
  protected readonly label = 'Sarvam AI';
  protected readonly packages = ['sarvamai'];

  protected targets(module: unknown): PatchTarget[] {
    const Client = exportedClass(module, 'SarvamAIClient') as (new (options: Record<string, unknown>) => Obj) | undefined;
    if (typeof Client !== 'function') return [];
    let client: Obj;
    try {
      // Reaching the resource classes through an instance; no connection is opened.
      client = new Client({ apiSubscriptionKey: 'instrumentation-probe' });
    } catch {
      return [];
    }
    const target = (resource: unknown, method: string, spanName: string, operation: Operation): PatchTarget => ({
      holder: prototypeDefining(resource, method),
      method,
      spanName,
      attributes: (_instance, _args, params) => this.requestAttributes(operation, params),
      options: { params: (args) => ({ ...(isObject(args[0]) ? args[0] : {}), __operation: operation }) },
    });
    return [
      target(client.chat, 'completions', 'sarvam.chat.completions', 'chat'),
      target(client.text, 'translate', 'sarvam.text.translate', 'translate'),
      target(client.text, 'transliterate', 'sarvam.text.transliterate', 'transliterate'),
      target(client.text, 'identifyLanguage', 'sarvam.text.identify_language', 'identify_language'),
      target(client.speechToText, 'transcribe', 'sarvam.speech_to_text.transcribe', 'stt'),
      target(client.speechToText, 'translate', 'sarvam.speech_to_text.translate', 'stt_translate'),
      target(client.textToSpeech, 'convert', 'sarvam.text_to_speech.convert', 'tts'),
      target(client.textToSpeech, 'convertStream', 'sarvam.text_to_speech.stream', 'tts_stream'),
    ];
  }

  /** The model as the pricing table spells it, for each operation. */
  private modelOf(operation: Operation, params: Params): string {
    switch (operation) {
      case 'chat':
        return String(params.model ?? 'sarvam-m');
      case 'translate':
        return String(param(params, 'model', 'mayura:v1'));
      case 'transliterate':
        return 'sarvam-transliterate';
      case 'identify_language':
        return 'sarvam-detect-language';
      case 'stt':
        return String(param(params, 'model', 'saarika:v2.5'));
      case 'stt_translate':
        return String(param(params, 'model', 'saaras:v2.5'));
      default:
        return normaliseTtsModel(String(param(params, 'model', 'bulbul-v2')));
    }
  }

  private requestAttributes(operation: Operation, params: Params): Obj {
    const attributes: Obj = { [ATTR.GEN_AI_SYSTEM]: 'sarvam', [ATTR.GEN_AI_REQUEST_MODEL]: this.modelOf(operation, params) };
    const set = (name: string, key: string, convert: (value: unknown) => unknown = String): void => {
      const value = param(params, key);
      if (value !== undefined) attributes[name] = convert(value);
    };
    const operationName = (name: string): void => {
      attributes[ATTR.GEN_AI_OPERATION_NAME] = name;
      attributes[ATTR.GEN_AI_REQUEST_TYPE] = name;
    };

    switch (operation) {
      case 'chat': {
        operationName('chat');
        const messages = Array.isArray(params.messages) ? params.messages : [];
        if (messages.length > 0) {
          const firstMessage = this.buildFirstMessage(messages);
          if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
        }
        break;
      }
      case 'translate': {
        operationName('translate');
        attributes['sarvam.source_language'] = String(param(params, 'source_language_code', 'auto'));
        attributes['sarvam.target_language'] = String(param(params, 'target_language_code', 'unknown'));
        if (params.input) {
          const firstMessage = this.buildFirstMessage([{ role: 'user', content: String(params.input) }]);
          if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
        }
        set('sarvam.translate.mode', 'mode');
        set('sarvam.translate.speaker_gender', 'speaker_gender');
        set('sarvam.translate.numerals_format', 'numerals_format');
        set('sarvam.translate.output_script', 'output_script');
        set('sarvam.translate.enable_preprocessing', 'enable_preprocessing', Boolean);
        break;
      }
      case 'transliterate':
        operationName('transliterate');
        attributes['sarvam.source_language'] = String(param(params, 'source_language_code', 'auto'));
        attributes['sarvam.target_language'] = String(param(params, 'target_language_code', 'unknown'));
        set('sarvam.transliterate.numerals_format', 'numerals_format');
        set('sarvam.transliterate.spoken_form', 'spoken_form', Boolean);
        set('sarvam.transliterate.spoken_form_numerals_language', 'spoken_form_numerals_language');
        break;
      case 'identify_language':
        operationName('identify_language');
        break;
      case 'stt':
        operationName('speech_to_text');
        attributes['sarvam.language_code'] = String(param(params, 'language_code', 'unknown'));
        set('sarvam.stt.mode', 'mode');
        set('sarvam.stt.input_audio_codec', 'input_audio_codec');
        break;
      case 'stt_translate':
        operationName('speech_to_text_translate');
        set('sarvam.stt.prompt', 'prompt', (value) => String(value).slice(0, 200));
        set('sarvam.stt.input_audio_codec', 'input_audio_codec');
        break;
      case 'tts': {
        operationName('text_to_speech');
        // The JavaScript client names the target language `language_code`.
        attributes['sarvam.target_language'] = String(param(params, 'target_language_code') ?? param(params, 'language_code', 'unknown'));
        const speaker = String(param(params, 'speaker', 'unknown'));
        attributes['sarvam.speaker'] = speaker;
        if (speaker && speaker !== 'unknown') attributes[ATTR.GEN_AI_REQUEST_VOICE_ID] = speaker;
        attributes[ATTR.GEN_AI_REQUEST_STREAMED] = Boolean(params.stream);
        if (params.text) attributes['sarvam.input_text_length'] = characterCount(params.text);
        set('sarvam.tts.pace', 'pace', Number);
        set('sarvam.tts.temperature', 'temperature', Number);
        set('sarvam.tts.pitch', 'pitch', Number);
        set('sarvam.tts.loudness', 'loudness', Number);
        const sampleRate = param(params, 'speech_sample_rate');
        if (sampleRate !== undefined) {
          attributes['sarvam.tts.speech_sample_rate'] = Math.trunc(Number(sampleRate));
          attributes[ATTR.GEN_AI_REQUEST_AUDIO_SAMPLE_RATE] = Math.trunc(Number(sampleRate));
        }
        set('sarvam.tts.enable_preprocessing', 'enable_preprocessing', Boolean);
        const codec = param(params, 'output_audio_codec');
        if (codec) {
          attributes['sarvam.tts.output_audio_codec'] = String(codec);
          attributes[ATTR.GEN_AI_RESPONSE_OUTPUT_FORMAT] = String(codec);
        }
        break;
      }
      case 'tts_stream': {
        operationName('text_to_speech');
        attributes[ATTR.GEN_AI_REQUEST_STREAMED] = true;
        set(ATTR.GEN_AI_REQUEST_VOICE_ID, 'speaker');
        const sampleRate = param(params, 'speech_sample_rate');
        if (sampleRate !== undefined) attributes[ATTR.GEN_AI_REQUEST_AUDIO_SAMPLE_RATE] = Math.trunc(Number(sampleRate));
        set(ATTR.GEN_AI_RESPONSE_OUTPUT_FORMAT, 'output_audio_codec');
        break;
      }
    }
    return attributes;
  }

  protected extractUsage(result: unknown): UsageDict | null {
    const usage = isObject(result) ? result.usage : undefined;
    if (!isObject(usage)) return null;
    const mapped: UsageDict = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) if (key in usage) mapped[key] = usage[key];
    return Object.keys(mapped).length > 0 ? mapped : null;
  }

  /** The chat response text, recorded on every span as the reference does. */
  protected override extractResponseAttributes(result: unknown): Obj {
    return this.chatResponseAttributes(result, { responseText: true });
  }

  protected override recordResultMetrics(span: Span, spanName: string, result: unknown, startTime: number, params: Params): void {
    super.recordResultMetrics(span, spanName, result, startTime, params);
    const operation = params.__operation as Operation | undefined;
    if (!operation || operation === 'chat') return;
    try {
      const model = this.modelOf(operation, params);
      let characters = 0;
      switch (operation) {
        case 'translate': {
          const translated = pick(result, 'translated_text', 'translatedText');
          if (translated !== undefined) span.setAttribute('sarvam.translated_text', String(translated).slice(0, 500));
          characters = characterCount(params.input);
          break;
        }
        case 'transliterate':
          characters = characterCount(params.input);
          break;
        case 'identify_language': {
          const language = pick(result, 'language_code', 'languageCode');
          if (language !== undefined) span.setAttribute('sarvam.detected_language', String(language));
          characters = characterCount(params.input);
          break;
        }
        case 'stt':
        case 'stt_translate': {
          const transcript = isObject(result) ? result.transcript : undefined;
          if (typeof transcript === 'string') {
            characters = characterCount(transcript);
            span.setAttribute('sarvam.transcript_length', characters);
          }
          break;
        }
        case 'tts': {
          const duration = pick(result, 'audio_duration_seconds', 'audioDurationSeconds', 'duration');
          if (typeof duration === 'number' && duration > 0) span.setAttribute(ATTR.GEN_AI_USAGE_AUDIO_DURATION_SECONDS, duration);
          characters = characterCount(params.text);
          break;
        }
        case 'tts_stream':
          characters = characterCount(params.text);
          break;
      }
      this.recordCharacterCost(span, model, characters);
    } catch (error) {
      logger.debug(`Failed to record Sarvam result: ${String(error)}`);
    }
  }

  /** `characters / 1000 * promptPrice`, from the `speech_to_text` pricing section. */
  private recordCharacterCost(span: Span, model: string, characters: number): void {
    span.setAttribute(ATTR.GEN_AI_USAGE_CHARACTERS, characters);
    if (!this.config?.enableCostTracking || characters <= 0) return;
    const section = this.costCalculator.pricingData.speech_to_text;
    if (!isObject(section)) return;
    let pricing: unknown = section[model];
    if (pricing === undefined) {
      const lower = model.toLowerCase();
      for (const key of Object.keys(section)) {
        if (key.toLowerCase() === lower || lower.includes(key.toLowerCase())) {
          pricing = section[key];
          break;
        }
      }
    }
    if (!isObject(pricing)) {
      logger.debug(`No pricing found for Sarvam model '${model}' in speech_to_text category`);
      return;
    }
    const cost = (characters / 1000) * Number(pricing.promptPrice ?? 0);
    span.setAttribute(ATTR.GEN_AI_USAGE_COST_TOTAL, cost);
    if (cost > 0) this.metrics.counters.cost.add(cost, { model });
  }
}
