/**
 * The provider examples, each run as a child process against the built package
 * and a mock provider. None is run against a live API here (no keys); this
 * proves each one executes and that the calls it makes produce their spans.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockLlm, type MockLlm, type MockReply } from '../helpers/mock-llm';
import { startOtlpReceiver, type OtlpReceiver } from '../helpers/otlp-receiver';

const ROOT = resolve(__dirname, '../..');

function run(script: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const scrubbed: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(GENAI_|OTEL_|EXAMPLE_|[A-Z0-9]+_API_KEY$|[A-Z0-9]+_BASE_URL$|[A-Z0-9]+_HOST$)/i.test(name)) {
        scrubbed[name] = value;
      }
    }
    const child = spawn(process.execPath, [resolve(ROOT, script)], { cwd: ROOT, env: { ...scrubbed, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

interface ExampleCase {
  script: string;
  /** Environment; `{llm}` is replaced by the mock provider's URL. */
  env: Record<string, string>;
  replies: MockReply[];
  spans: string[];
  system: string;
  /** Spans that must carry a cost. Default: all. */
  costed?: string[];
  /** A reply built from the mock's URL, where the response must point back at it. */
  build?: (llm: string) => MockReply[];
}

const openaiCompatible = (provider: string, domain: string): ExampleCase => ({
  script: 'examples/openai-compatible/chat.mjs',
  env: { EXAMPLE_PROVIDER: provider, EXAMPLE_API_KEY: 'example-not-a-real-key', EXAMPLE_BASE_URL: `{llm}/${domain}/v1`, EXAMPLE_CHAT_MODEL: 'gpt-4o-mini' },
  replies: [{ fixture: 'openai/chat.completion.json' }],
  spans: [`${provider}.chat.completion`],
  system: provider,
});

const CASES: ExampleCase[] = [
  openaiCompatible('openrouter', 'openrouter.ai'),
  openaiCompatible('cometapi', 'api.cometapi.com'),
  openaiCompatible('hyperbolic', 'api.hyperbolic.xyz'),
  openaiCompatible('sambanova', 'api.sambanova.ai'),
  {
    script: 'examples/groq/chat.mjs',
    env: { GROQ_API_KEY: 'gsk-example-not-a-real-key', EXAMPLE_BASE_URL: '{llm}', EXAMPLE_CHAT_MODEL: 'gpt-4o-mini' },
    replies: [{ fixture: 'openai/chat.completion.json' }, { fixture: 'openai/chat.completion.stream.sse' }],
    spans: ['groq.chat.completions', 'groq.chat.completions'],
    system: 'groq',
  },
  {
    script: 'examples/together/chat.mjs',
    env: {
      TOGETHER_API_KEY: 'tg-example-not-a-real-key',
      EXAMPLE_BASE_URL: '{llm}',
      EXAMPLE_CHAT_MODEL: 'gpt-4o-mini',
      EXAMPLE_EMBEDDING_MODEL: 'text-embedding-3-small',
    },
    replies: [{ fixture: 'openai/chat.completion.json' }, { fixture: 'openai/embeddings.float.json' }],
    spans: ['together.chat.completion', 'together.embeddings'],
    system: 'together',
  },
  {
    script: 'examples/mistral/chat.mjs',
    env: { MISTRAL_API_KEY: 'mistral-example-not-a-real-key', EXAMPLE_BASE_URL: '{llm}' },
    replies: [{ fixture: 'mistral/chat.completion.json' }, { fixture: 'mistral/chat.stream.sse' }, { fixture: 'mistral/embeddings.json' }],
    spans: [
      'mistralai.chat.complete mistral-small-latest',
      'mistralai.chat.stream mistral-small-latest',
      'mistralai.embeddings.create mistral-embed',
    ],
    system: 'mistralai',
  },
  {
    script: 'examples/cohere/chat.mjs',
    env: { CO_API_KEY: 'cohere-example-not-a-real-key', EXAMPLE_BASE_URL: '{llm}' },
    replies: [{ fixture: 'cohere/chat.v2.json' }, { fixture: 'cohere/embed.json' }],
    spans: ['cohere.chat', 'cohere.embeddings'],
    system: 'cohere',
  },
  {
    script: 'examples/ollama/chat.mjs',
    env: { OLLAMA_HOST: '{llm}' },
    replies: [{ fixture: 'ollama/chat.json' }, { fixture: 'ollama/chat.stream.ndjson' }, { fixture: 'ollama/embed.json' }],
    spans: ['ollama.chat', 'ollama.chat', 'ollama.embeddings'],
    system: 'ollama',
    // A local embedding model has no price: no cost attribute, by design.
    costed: ['ollama.chat'],
  },
  {
    script: 'examples/google-genai/chat.mjs',
    env: { GEMINI_API_KEY: 'google-example-not-a-real-key', EXAMPLE_BASE_URL: '{llm}' },
    replies: [
      { fixture: 'google/generate-content.json' },
      { fixture: 'google/generate-content.stream.sse' },
      { fixture: 'google/embed-content.json' },
    ],
    spans: ['google.genai.models.generate_content', 'google.genai.models.generate_content', 'google.genai.models.embeddings'],
    system: 'google',
    // The embeddings endpoint reports no usage: no tokens, so no cost.
    costed: ['google.genai.models.generate_content'],
  },
  {
    script: 'examples/bedrock/converse.mjs',
    env: {
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE00',
      AWS_SECRET_ACCESS_KEY: 'example-secret-not-a-real-key',
      AWS_REGION: 'us-east-1',
      EXAMPLE_BASE_URL: '{llm}',
    },
    replies: [
      { json: { output: { message: { role: 'assistant', content: [{ text: 'Paris.' }] } }, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } },
      { json: { output: { message: { role: 'assistant', content: [{ text: 'Hello.' }] } }, usage: { inputTokens: 4, outputTokens: 2 } } },
    ],
    spans: ['aws.bedrock.converse', 'aws.bedrock.invoke_model'],
    system: 'aws_bedrock',
  },
  {
    script: 'examples/replicate/run.mjs',
    env: { REPLICATE_API_TOKEN: 'r8-example-not-a-real-key', EXAMPLE_BASE_URL: '{llm}/v1' },
    replies: [],
    build: (url) => [
      {
        status: 201,
        json: { id: 'pred-1', status: 'succeeded', output: ['Par', 'is.'], urls: { get: `${url}/v1/predictions/pred-1`, cancel: `${url}/v1/predictions/pred-1/cancel` } },
      },
    ],
    spans: ['replicate.run'],
    system: 'replicate',
    // Billed by hardware time: no tokens, no cost.
    costed: [],
  },
  {
    script: 'examples/huggingface-inference/chat.mjs',
    env: { HF_TOKEN: 'hf_example_not_a_real_key', EXAMPLE_BASE_URL: '{llm}', EXAMPLE_CHAT_MODEL: 'gpt-4o-mini' },
    replies: [{ fixture: 'openai/chat.completion.json' }],
    spans: ['huggingface.inference.chat_completion'],
    system: 'huggingface',
  },
  {
    script: 'examples/elevenlabs/speech.mjs',
    env: { ELEVENLABS_API_KEY: 'el-example-not-a-real-key', EXAMPLE_BASE_URL: '{llm}' },
    replies: [{ raw: Buffer.from('fake-mp3-bytes'), headers: { 'content-type': 'audio/mpeg' } }],
    spans: ['elevenlabs.text_to_speech.convert'],
    system: 'elevenlabs',
  },
  {
    script: 'examples/sarvam/translate.mjs',
    env: { SARVAM_API_KEY: 'sarvam-example-not-a-real-key', EXAMPLE_BASE_URL: '{llm}' },
    replies: [{ json: { request_id: 'r-1', translated_text: 'namaste', source_language_code: 'en-IN' } }],
    spans: ['sarvam.text.translate'],
    system: 'sarvam',
  },
];

describe('provider examples, against a mock provider', () => {
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

  it.each(CASES.map((example) => [`${example.script} (${example.system})`, example] as const))(
    '%s',
    async (_title, example) => {
      for (const reply of example.build ? example.build(llm.url) : example.replies) llm.reply(reply);
      const env: Record<string, string> = { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url };
      for (const [name, value] of Object.entries(example.env)) env[name] = value.replace('{llm}', llm.url);
      const outcome = await run(example.script, env);
      expect(outcome.code, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
      expect(outcome.stdout).toContain('telemetry exported');

      expect(receiver.spans.map((span) => span.name)).toEqual(example.spans);
      for (const span of receiver.spans) {
        expect(span.statusCode, span.name).toBe(1);
        expect(span.attributes['gen_ai.system'], span.name).toBe(example.system);
        if (!example.costed || example.costed.includes(span.name)) {
          expect(span.attributes['gen_ai.usage.cost.total'], span.name).toBeGreaterThan(0);
        }
      }
    },
    60000,
  );
});
