/**
 * Media on spans: an instrumented call with image, audio or document parts,
 * with `GENAI_OTEL_MEDIA_CAPTURE_MODE` on. What the reference writes:
 * `gen_ai.prompt.{n}.role`, per part `gen_ai.prompt.{n}.content.{m}.type` and
 * either `.text` or the media fields, `gen_ai.media.stripped_reason`; and,
 * under the GenAI semconv opt-in, `gen_ai.input.messages`.
 *
 * Here text - in the parts and in the canonical messages - also needs content
 * capture on (SDK_ADDITIONS.md section 5); media capture is its own switch.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clearBaseUrlClaims } from '../../src/instrumentors/base';
import { eventually, startHarness, type Harness } from '../helpers/harness';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';

let llm: MockLlm;
let harness: Harness | undefined;
const root = mkdtempSync(join(tmpdir(), 'genai-otel-media-span-'));

beforeAll(async () => {
  llm = await startMockLlm();
});
afterAll(async () => {
  await llm.close();
  rmSync(root, { recursive: true, force: true });
});
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  clearBaseUrlClaims();
});

const PNG = Buffer.from('\x89PNG\r\n\x1a\nfake-png-bytes', 'latin1');
const image = `data:image/png;base64,${PNG.toString('base64')}`;
const openai = (): OpenAI => new OpenAI({ apiKey: 'sk-test-not-a-real-key', baseURL: `${llm.url}/v1`, maxRetries: 0 });
const MESSAGES = [
  { role: 'user' as const, content: [{ type: 'text' as const, text: 'What is in this picture?' }, { type: 'image_url' as const, image_url: { url: image } }] },
];
const media = { mediaCaptureMode: 'full', mediaStore: 'filesystem', mediaStoreEndpoint: root, mediaStoreBucket: 'm' };

describe('media on spans', () => {
  it('full: the image is uploaded and the span says where; the text part needs content capture', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai'], ...media } as never);
    llm.reply({ fixture: 'openai/chat.completion.json' });
    await openai().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
    await eventually(() => expect(harness?.spans()).toHaveLength(1));
    const attributes = harness.span('openai.chat.completion').attributes;
    expect(attributes).toMatchObject({
      'gen_ai.prompt.0.role': 'user',
      'gen_ai.prompt.0.content.0.type': 'text',
      'gen_ai.prompt.0.content.1.type': 'image',
      'gen_ai.prompt.0.content.1.media_mime_type': 'image/png',
      'gen_ai.prompt.0.content.1.media_byte_size': PNG.length,
      'gen_ai.prompt.0.content.1.media_source': 'inline_offloaded',
    });
    // The bytes are where the span says.
    expect(readFileSync(fileURLToPath(String(attributes['gen_ai.prompt.0.content.1.media_uri'])))).toEqual(PNG);
    // Content capture is off: no text, and no canonical messages.
    expect('gen_ai.prompt.0.content.0.text' in attributes).toBe(false);
    expect('gen_ai.input.messages' in attributes).toBe(false);
    expect(JSON.stringify(attributes)).not.toContain('What is in this picture');
  });

  it('with content capture on too: the text part, and the canonical messages under the GenAI opt-in', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai'], ...media, enableContentCapture: true, semconvStabilityOptIn: 'gen_ai/dup' } as never);
    llm.reply({ fixture: 'openai/chat.completion.json' });
    await openai().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
    await eventually(() => expect(harness?.spans()).toHaveLength(1));
    const attributes = harness.span('openai.chat.completion').attributes;
    expect(attributes['gen_ai.prompt.0.content.0.text']).toBe('What is in this picture?');
    const canonical = JSON.parse(String(attributes['gen_ai.input.messages'])) as { role: string; parts: Record<string, unknown>[] }[];
    expect(canonical[0]?.role).toBe('user');
    expect(canonical[0]?.parts[0]).toEqual({ type: 'text', content: 'What is in this picture?' });
    expect(canonical[0]?.parts[1]).toMatchObject({ type: 'uri', modality: 'image', mime_type: 'image/png', byte_size: PNG.length });
  });

  it('reference_only: type and size, no upload', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai'], ...media, mediaCaptureMode: 'reference_only' } as never);
    llm.reply({ fixture: 'openai/chat.completion.json' });
    await openai().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
    await eventually(() => expect(harness?.spans()).toHaveLength(1));
    const attributes = harness.span('openai.chat.completion').attributes;
    expect(attributes['gen_ai.prompt.0.content.1.media_source']).toBe('reference_only');
    expect('gen_ai.prompt.0.content.1.media_uri' in attributes).toBe(false);
  });

  it('a modality that is not allowed is stripped, with the reason', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai'], ...media, mediaAllowedModalities: 'audio' } as never);
    llm.reply({ fixture: 'openai/chat.completion.json' });
    await openai().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
    await eventually(() => expect(harness?.spans()).toHaveLength(1));
    expect(harness.span('openai.chat.completion').attributes['gen_ai.media.stripped_reason']).toBe('modality_not_allowed');
  });

  it('Anthropic image blocks', async () => {
    harness = await startHarness({ enabledInstrumentors: ['anthropic'], ...media } as never);
    llm.reply({ fixture: 'anthropic/message.json' });
    const client = new Anthropic({ apiKey: 'sk-ant-test-not-a-real-key', baseURL: llm.url, maxRetries: 0 });
    await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }] }],
    });
    await eventually(() => expect(harness?.spans()).toHaveLength(1));
    expect(harness.span('anthropic.messages.create').attributes).toMatchObject({ 'gen_ai.prompt.0.content.0.type': 'image', 'gen_ai.prompt.0.content.0.media_source': 'inline_offloaded' });
  });

  it('off (the default): nothing about media', async () => {
    harness = await startHarness({ enabledInstrumentors: ['openai'] });
    llm.reply({ fixture: 'openai/chat.completion.json' });
    await openai().chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES });
    expect(Object.keys(harness.span('openai.chat.completion').attributes).filter((key) => key.includes('.content.'))).toEqual([]);
  });
});
