/**
 * Rules every provider's spans follow, whatever Python v1.30.0 does for that
 * provider (contract/SDK_ADDITIONS.md sections 5 to 7). Every provider example
 * is run against the mock provider twice: content capture off, then on.
 *
 * - content reaches a span only when content capture is on; with it on, every
 *   chat span carries the prompt and the completion, streamed calls included;
 * - every model-call span has `gen_ai.operation.name`;
 * - enumerations are wire values: never Python's enum text, never "None".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecodedSpan } from '../helpers/otlp-decode';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';
import { startOtlpReceiver, type OtlpReceiver } from '../helpers/otlp-receiver';
import { ANTHROPIC_CASE, CASES, OPENAI_CASE, run, type ExampleCase } from '../helpers/provider-cases';

const ALL: ExampleCase[] = [OPENAI_CASE, ANTHROPIC_CASE, ...CASES];

/** Attribute keys that carry what was said. */
const CONTENT_KEY = /^(gen_ai\.response$|gen_ai\.request\.first_message$|gen_ai\.prompt|gen_ai\.completion|gen_ai\.(input|output)\.messages$|gen_ai\.system_instructions$|llm\.(input|output)_messages\..*\.content$)/;
/** The prompts the examples send; none may appear on a span with capture off. */
const PROMPTS = ['capital of France', 'Count from one to five', 'weather in Mumbai', 'Say hello', 'Name one prime number'];
/** `FinishReason.STOP`, `HarmCategory.HARM_CATEGORY_X`: Python's `str(enum)`. */
const ENUM_TEXT = /^[A-Z][A-Za-z]+\.[A-Z][A-Z0-9_]+$/;

const CHAT_OPERATIONS = new Set(['chat', 'generate_content', 'text_completion', 'text_generation', 'generate']);

function contentOf(span: DecodedSpan): { prompt: boolean; completion: boolean; keys: string[] } {
  const keys = Object.keys(span.attributes).filter((key) => CONTENT_KEY.test(key));
  const eventKeys = span.events.flatMap((event) => Object.keys(event.attributes).filter((key) => key.endsWith('.content')).map((key) => `${event.name}:${key}`));
  const prompt =
    'gen_ai.request.first_message' in span.attributes ||
    Object.keys(span.attributes).some((key) => key.startsWith('gen_ai.prompt') || key === 'gen_ai.input.messages') ||
    span.events.some((event) => event.name.startsWith('gen_ai.prompt') || event.name === 'gen_ai.user.message');
  const completion =
    'gen_ai.response' in span.attributes ||
    Object.keys(span.attributes).some((key) => key.startsWith('gen_ai.completion') || key === 'gen_ai.output.messages') ||
    span.events.some((event) => event.name.startsWith('gen_ai.completion') || event.name === 'gen_ai.choice');
  return { prompt, completion, keys: [...keys, ...eventKeys] };
}

describe('uniform span rules across providers', () => {
  let llm: MockLlm;
  let receiver: OtlpReceiver;

  beforeEach(async () => {
    llm = await startMockLlm();
    receiver = await startOtlpReceiver();
  });
  afterEach(async () => {
    await llm.close();
    await receiver.close();
  });

  async function exercise(example: ExampleCase, capture: boolean): Promise<DecodedSpan[]> {
    for (const reply of example.build ? example.build(llm.url) : example.replies) llm.reply(reply);
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, GENAI_ENABLE_CONTENT_CAPTURE: String(capture) };
    for (const [name, value] of Object.entries(example.env)) env[name] = value.replace('{llm}', llm.url).replace('{port}', String(llm.port));
    const outcome = await run(example.script, env);
    expect(outcome.code, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
    expect(receiver.spans.map((span) => span.name)).toEqual(example.spans);
    return receiver.spans;
  }

  const title = (example: ExampleCase): string => `${example.script} (${example.system})`;

  it.each(ALL.map((example) => [title(example), example] as const))('%s, capture off: no content; operation names; wire values', async (_title, example) => {
    for (const span of await exercise(example, false)) {
      expect(contentOf(span).keys, span.name).toEqual([]);
      const text = JSON.stringify([span.attributes, span.events]);
      for (const prompt of PROMPTS) expect(text, span.name).not.toContain(prompt);
      expect(span.attributes['gen_ai.operation.name'], `${span.name}: gen_ai.operation.name`).toEqual(expect.any(String));
      for (const [key, value] of Object.entries(span.attributes)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          expect(item, `${span.name} ${key}`).not.toBe('None');
          if (typeof item === 'string') expect(ENUM_TEXT.test(item), `${span.name} ${key} = ${item}`).toBe(false);
        }
      }
    }
  }, 60_000);

  it.each(ALL.map((example) => [title(example), example] as const))('%s, capture on: every chat span carries its prompt and its completion', async (_title, example) => {
    for (const span of await exercise(example, true)) {
      if (!CHAT_OPERATIONS.has(String(span.attributes['gen_ai.operation.name']))) continue;
      const found = contentOf(span);
      expect(found.prompt, `${span.name}: prompt`).toBe(true);
      // A tool call has no text to complete with; everything else does.
      if (span.attributes['gen_ai.response.finish_reasons']?.toString().includes('tool')) continue;
      expect(found.completion, `${span.name}: completion`).toBe(true);
    }
  }, 60_000);
});
