/**
 * The content guard (contract/SDK_ADDITIONS.md section 10): frameworks that emit
 * their own spans write prompts and answers on them whatever our content-capture
 * setting says, and because instrument() installs the tracer provider they
 * export through this pipeline. With content capture OFF the guard removes those
 * attributes, and the span events that carry content, before export.
 */
import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTENT_ATTRIBUTE_KEYS } from '../../src/content-guard';
import { startHarness, type Harness } from '../helpers/harness';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const SAID = {
  // OpenInference (Arize's instrumentations)
  'input.value': 'What is my balance?',
  'output.value': 'Your balance is 42.',
  'llm.input_messages.0.message.content': 'What is my balance?',
  'llm.output_messages.0.message.content': 'Your balance is 42.',
  'llm.prompts': ['What is my balance?'],
  // Genkit
  'genkit:input': '{"prompt":"What is my balance?"}',
  'genkit:output': '{"text":"Your balance is 42."}',
  // Vercel AI SDK
  'ai.prompt': '{"prompt":"What is my balance?"}',
  'ai.prompt.messages': '[{"role":"user","content":"What is my balance?"}]',
  'ai.response.text': 'Your balance is 42.',
  'ai.response.toolCalls': '[{"toolName":"balance","args":{}}]',
  // GenAI semantic conventions, from any other instrumentation
  'gen_ai.prompt.0.content': 'What is my balance?',
  'gen_ai.completion.0.content': 'Your balance is 42.',
  'gen_ai.input.messages': '[{"role":"user","parts":[{"type":"text","content":"What is my balance?"}]}]',
};
const KEPT = { 'llm.model_name': 'gpt-4o-mini', 'llm.token_count.prompt': 9, 'openinference.span.kind': 'LLM', 'ai.model.id': 'gpt-4o-mini', 'gen_ai.request.model': 'gpt-4o-mini' };

function foreignSpan(): void {
  const span = trace.getTracer('openinference.instrumentation.openai').startSpan('ChatCompletion', { attributes: { ...SAID, ...KEPT } });
  span.addEvent('gen_ai.user.message', { content: 'What is my balance?', role: 'user' });
  span.addEvent('gen_ai.choice', { 'gen_ai.completion': 'Your balance is 42.', index: 0 });
  span.addEvent('retry', { attempt: 1 });
  span.end();
}

describe('content guard', () => {
  it('content capture off: what was said is removed from spans we did not create; everything else stays', async () => {
    harness = await startHarness({ enabledInstrumentors: [], enableContentCapture: false });
    foreignSpan();
    const span = harness.span('ChatCompletion');
    for (const key of Object.keys(SAID)) expect(span.attributes, key).not.toHaveProperty([key]);
    expect(span.attributes).toMatchObject(KEPT);
    expect(span.events.map((event) => event.name)).toEqual(['retry']);
    expect(JSON.stringify([span.attributes, span.events])).not.toContain('balance is');
  });

  it('content capture on: nothing is removed', async () => {
    harness = await startHarness({ enabledInstrumentors: [], enableContentCapture: true });
    foreignSpan();
    const span = harness.span('ChatCompletion');
    expect(span.attributes).toMatchObject({ ...SAID, ...KEPT });
    expect(span.events.map((event) => event.name)).toEqual(['gen_ai.user.message', 'gen_ai.choice', 'retry']);
  });

  it('the list lives in one place and names every framework section 10 names', () => {
    for (const key of ['genkit:input', 'genkit:output', 'input.value', 'output.value', 'ai.prompt', 'ai.response.text', 'ai.response.toolCalls']) {
      expect(CONTENT_ATTRIBUTE_KEYS, key).toContain(key);
    }
  });
});
