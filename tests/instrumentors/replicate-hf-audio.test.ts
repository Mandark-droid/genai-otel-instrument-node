/**
 * Replicate, HuggingFace Inference, ElevenLabs and Sarvam: real clients
 * against the mock provider.
 */
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { InferenceClient } from '@huggingface/inference';
import { SpanStatusCode } from '@opentelemetry/api';
import Replicate from 'replicate';
import { SarvamAIClient } from 'sarvamai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDefaultCostCalculator } from '../../src/cost';
import { traceHuggingFaceClient } from '../../src/instrumentors/huggingface';
import { startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

const calculator = getDefaultCostCalculator();
const MESSAGES = [{ role: 'user' as const, content: 'What is the capital of France?' }];

let llm: MockLlm;
let harness: Harness;

beforeAll(async () => {
  llm = await startMockLlm();
});
afterAll(async () => {
  await llm.close();
});
afterEach(async () => {
  try {
    expect(harness.openSpans()).toEqual([]);
  } finally {
    await harness.stop();
    llm.requests.length = 0;
  }
});

describe('Replicate instrumentor', () => {
  const client = (): Replicate => new Replicate({ auth: 'r8-test-not-a-real-key', baseUrl: `${llm.url}/v1`, useFileOutput: false });
  const prediction = (output: unknown): Record<string, unknown> => ({
    id: 'pred-fixture-0001',
    status: 'succeeded',
    output,
    urls: { get: `${llm.url}/v1/predictions/pred-fixture-0001`, cancel: `${llm.url}/v1/predictions/pred-fixture-0001/cancel` },
  });

  it('run: a span with the model and no tokens or cost - Replicate bills by hardware time', async () => {
    harness = await startHarness({ enabledInstrumentors: ['replicate'] });
    llm.reply({ status: 201, json: prediction(['Par', 'is.']) });
    const output = await client().run('meta/meta-llama-3-8b-instruct', { input: { prompt: 'Capital of France?' } });
    expect(output).toEqual(['Par', 'is.']);
    const span = harness.span('replicate.run');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'replicate',
      'gen_ai.request.model': 'meta/meta-llama-3-8b-instruct',
      'gen_ai.operation.name': 'run',
    });
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
    // A list of strings from a text model is not an embedding.
    expect('gen_ai.response.embedding_count' in span.attributes).toBe(false);
  });

  it('run of an embedding model: operation, input count, vector count and size', async () => {
    harness = await startHarness({ enabledInstrumentors: ['replicate'] });
    llm.reply({ status: 201, json: prediction([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]) });
    await client().run('replicate/all-mpnet-base-v2', { input: { texts: ['alpha', 'beta'] } });
    expect(harness.span('replicate.run').attributes).toMatchObject({
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.request.type': 'embedding',
      'gen_ai.request.input_count': 2,
      'gen_ai.response.embedding_count': 2,
      'gen_ai.response.vector_size': 3,
    });
  });

  it('a provider error ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: ['replicate'] });
    llm.reply({ status: 401, json: { detail: 'Unauthenticated' } });
    await expect(client().run('meta/meta-llama-3-8b-instruct', { input: { prompt: 'hi' } })).rejects.toThrow();
    expect(harness.span('replicate.run').status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('HuggingFace Inference', () => {
  const client = (): InferenceClient => traceHuggingFaceClient(new InferenceClient('hf_test_not_a_real_key', { endpointUrl: llm.url }));

  it('chatCompletion on a traced client: request parameters, tokens, cost', async () => {
    harness = await startHarness({ enabledInstrumentors: ['transformers'] });
    llm.reply({ fixture: 'openai/chat.completion.json' });
    const response = await client().chatCompletion({ model: 'gpt-4o-mini', messages: MESSAGES, max_tokens: 32, temperature: 0.1 });
    expect(response.choices[0]?.message.content).toBe('The capital of France is Paris.');
    expect(harness.span('huggingface.inference.chat_completion').attributes).toMatchObject({
      'gen_ai.system': 'huggingface',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.max_tokens': 32,
      'gen_ai.request.temperature': 0.1,
      'gen_ai.usage.input_tokens': 19,
      'gen_ai.usage.output_tokens': 9,
      'gen_ai.usage.cost.total': calculator.calculateCost('gpt-4o-mini', { prompt_tokens: 19, completion_tokens: 9 }, 'chat'),
    });
  });

  it('textGeneration: no usage is reported, so no tokens and no cost', async () => {
    harness = await startHarness({ enabledInstrumentors: ['transformers'] });
    // A dedicated endpoint answers in the completions shape; the client hands back only the text.
    llm.reply({ json: { choices: [{ text: 'Paris.', index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } });
    const output = await client().textGeneration({ model: 'google/gemma-2-2b-it', inputs: 'Capital of France?', parameters: { max_new_tokens: 16 } });
    expect(output.generated_text).toBe('Paris.');
    const attributes = harness.span('huggingface.inference.text_generation').attributes;
    expect(attributes).toMatchObject({ 'gen_ai.system': 'huggingface', 'gen_ai.request.model': 'google/gemma-2-2b-it', 'gen_ai.request.max_tokens': 16 });
    expect(Object.keys(attributes).filter((key) => key.startsWith('gen_ai.usage'))).toEqual([]);
  });

  it('chatCompletionStream: measured to the end of the stream', async () => {
    harness = await startHarness({ enabledInstrumentors: ['transformers'] });
    llm.reply({ fixture: 'openai/chat.completion.stream.sse' });
    let text = '';
    for await (const chunk of client().chatCompletionStream({ model: 'gpt-4o-mini', messages: MESSAGES })) {
      text += chunk.choices[0]?.delta.content ?? '';
    }
    expect(text.length).toBeGreaterThan(0);
    const span = harness.span('huggingface.inference.chat_completion');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes['gen_ai.server.time_to_first_token']).toBeGreaterThan(0);
  });

  it('the traced client is still an InferenceClient, and an unwrapped one is untouched', async () => {
    harness = await startHarness({ enabledInstrumentors: ['transformers'] });
    expect(client()).toBeInstanceOf(InferenceClient);
    llm.reply({ fixture: 'openai/chat.completion.json' });
    await new InferenceClient('hf_test_not_a_real_key', { endpointUrl: llm.url }).chatCompletion({ model: 'gpt-4o-mini', messages: MESSAGES });
    expect(harness.spans()).toEqual([]);
  });

  it('before instrument() a traced client simply works', async () => {
    const traced = client();
    llm.reply({ fixture: 'openai/chat.completion.json' });
    const response = await traced.chatCompletion({ model: 'gpt-4o-mini', messages: MESSAGES });
    expect(response.id).toBe('chatcmpl-fixture-0001');
    harness = await startHarness({ enabledInstrumentors: ['transformers'] });
    expect(harness.spans()).toEqual([]);
  });

  it('a provider error ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: ['transformers'] });
    llm.reply({ fixture: 'openai/error.429.json', status: 429 });
    await expect(client().chatCompletion({ model: 'gpt-4o-mini', messages: MESSAGES })).rejects.toThrow();
    expect(harness.span('huggingface.inference.chat_completion').status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('ElevenLabs instrumentor', () => {
  const client = (): ElevenLabsClient => new ElevenLabsClient({ apiKey: 'el-test-not-a-real-key', baseUrl: llm.url });

  it('textToSpeech.convert: characters, voice, output format, cost by character', async () => {
    harness = await startHarness({ enabledInstrumentors: ['elevenlabs'] });
    llm.reply({ raw: Buffer.from('fake-mp3-bytes'), headers: { 'content-type': 'audio/mpeg' } });
    const text = 'The capital of France is Paris.';
    const audio = await client().textToSpeech.convert('voice-123', { text, modelId: 'eleven_multilingual_v2', outputFormat: 'mp3_44100_128' }, { maxRetries: 0 });
    const chunks: Uint8Array[] = [];
    for await (const part of audio) chunks.push(part);
    expect(Buffer.concat(chunks).toString()).toBe('fake-mp3-bytes');
    const span = harness.span('elevenlabs.text_to_speech.convert');
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      'gen_ai.system': 'elevenlabs',
      'gen_ai.provider.name': 'elevenlabs',
      'gen_ai.request.model': 'eleven_multilingual_v2',
      'gen_ai.operation.name': 'text_to_speech',
      'gen_ai.request.type': 'text_to_speech',
      'gen_ai.usage.characters': text.length,
      'gen_ai.request.voice_id': 'voice-123',
      'elevenlabs.output_format': 'mp3_44100_128',
      'gen_ai.response.output_format': 'mp3_44100_128',
      'gen_ai.usage.cost.total': calculator.calculateCost('eleven_multilingual_v2', { characters: text.length }, 'audio'),
    });
  });

  it('speechToText.convert: audio seconds, transcript length, language, cost by second', async () => {
    harness = await startHarness({ enabledInstrumentors: ['elevenlabs'] });
    llm.reply({ json: { language_code: 'en', language_probability: 0.98, text: 'hello world', words: [], audio_duration_secs: 12.5 } });
    const result = await client().speechToText.convert({ file: new Blob([Buffer.from('fake-wav')]), modelId: 'scribe_v1', languageCode: 'en' }, { maxRetries: 0 });
    expect((result as { text: string }).text).toBe('hello world');
    expect(harness.span('elevenlabs.speech_to_text.convert').attributes).toMatchObject({
      'gen_ai.system': 'elevenlabs',
      'gen_ai.request.model': 'scribe_v1',
      'gen_ai.operation.name': 'speech_to_text',
      'gen_ai.request.type': 'speech_to_text',
      'gen_ai.request.language_code': 'en',
      'gen_ai.usage.audio_duration_seconds': 12.5,
      'gen_ai.response.transcript_length': 11,
      'gen_ai.response.language_code': 'en',
      // Scribe is priced under the provider-qualified key.
      'gen_ai.usage.cost.total': calculator.calculateCost('elevenlabs/scribe_v1', { seconds: 12.5 }, 'audio'),
    });
  });

  it('a provider error ends the span with ERROR status and no cost... of a transcription', async () => {
    harness = await startHarness({ enabledInstrumentors: ['elevenlabs'] });
    llm.reply({ status: 401, json: { detail: { status: 'invalid_api_key', message: 'Invalid API key' } } });
    await expect(client().speechToText.convert({ file: new Blob([Buffer.from('x')]), modelId: 'scribe_v1' }, { maxRetries: 0 })).rejects.toThrow();
    const span = harness.span('elevenlabs.speech_to_text.convert');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect('gen_ai.usage.cost.total' in span.attributes).toBe(false);
  });
});

describe('Sarvam instrumentor', () => {
  const client = (): SarvamAIClient => new SarvamAIClient({ apiSubscriptionKey: 'sarvam-test-not-a-real-key', baseUrl: llm.url });
  const noRetry = { maxRetries: 0 };

  it('chat.completions: tokens, cost, response text', async () => {
    harness = await startHarness({ enabledInstrumentors: ['sarvamai'] });
    llm.reply({
      json: {
        id: 'sarvam-chat-0001',
        object: 'chat.completion',
        created: 1759400200,
        model: 'sarvam-105b',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Paris.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      },
    });
    await client().chat.completions({ model: 'sarvam-105b', messages: MESSAGES }, noRetry);
    expect(harness.span('sarvam.chat.completions').attributes).toMatchObject({
      'gen_ai.system': 'sarvam',
      'gen_ai.request.model': 'sarvam-105b',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.type': 'chat',
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 3,
      'gen_ai.response': 'Paris.',
    });
  });

  it('text.translate: languages, translated text, characters, cost per thousand characters', async () => {
    harness = await startHarness({ enabledInstrumentors: ['sarvamai'] });
    llm.reply({ json: { request_id: 'r-1', translated_text: 'नमस्ते', source_language_code: 'en-IN' } });
    const input = 'Hello there';
    await client().text.translate({ input, source_language_code: 'en-IN', target_language_code: 'hi-IN', model: 'mayura:v1', mode: 'formal' }, noRetry);
    const pricing = (calculator.pricingData.speech_to_text as Record<string, { promptPrice: number }>)['mayura:v1'];
    expect(harness.span('sarvam.text.translate').attributes).toMatchObject({
      'gen_ai.system': 'sarvam',
      'gen_ai.request.model': 'mayura:v1',
      'gen_ai.operation.name': 'translate',
      'gen_ai.request.type': 'translate',
      'sarvam.source_language': 'en-IN',
      'sarvam.target_language': 'hi-IN',
      'sarvam.translate.mode': 'formal',
      'sarvam.translated_text': 'नमस्ते',
      'gen_ai.usage.characters': input.length,
      'gen_ai.usage.cost.total': (input.length / 1000) * (pricing?.promptPrice ?? Number.NaN),
    });
  });

  it('textToSpeech.convert: model spelling normalised for pricing, speaker, characters', async () => {
    harness = await startHarness({ enabledInstrumentors: ['sarvamai'] });
    llm.reply({ json: { request_id: 'r-2', audios: ['ZmFrZQ=='] } });
    await client().textToSpeech.convert({ text: 'Namaste', language_code: 'hi-IN', speaker: 'anushka', model: 'bulbul:v2' }, noRetry);
    const attributes = harness.span('sarvam.text_to_speech.convert').attributes;
    expect(attributes).toMatchObject({
      'gen_ai.system': 'sarvam',
      'gen_ai.request.model': 'bulbul-v2',
      'gen_ai.operation.name': 'text_to_speech',
      'gen_ai.request.type': 'text_to_speech',
      'sarvam.target_language': 'hi-IN',
      'sarvam.speaker': 'anushka',
      'gen_ai.request.voice_id': 'anushka',
      'gen_ai.request.streamed': false,
      'sarvam.input_text_length': 7,
      'gen_ai.usage.characters': 7,
    });
    expect(attributes['gen_ai.usage.cost.total']).toBeGreaterThan(0);
  });

  it('a provider error ends the span with ERROR status', async () => {
    harness = await startHarness({ enabledInstrumentors: ['sarvamai'] });
    llm.reply({ status: 403, json: { error: { message: 'invalid subscription key', code: 'invalid_api_key_error' } } });
    await expect(client().text.translate({ input: 'hi', source_language_code: 'en-IN', target_language_code: 'hi-IN' }, noRetry)).rejects.toThrow();
    expect(harness.span('sarvam.text.translate').status.code).toBe(SpanStatusCode.ERROR);
  });
});
