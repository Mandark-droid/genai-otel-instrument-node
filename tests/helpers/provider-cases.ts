/**
 * The provider examples and what each needs from the mock provider: shared by
 * the example tests and the cross-provider span rules.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { MockReply } from './mock-llm';

const ROOT = resolve(__dirname, '../..');

export function run(script: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const scrubbed: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(GENAI_|OTEL_|EXAMPLE_|[A-Z0-9]+_API_KEY$|[A-Z0-9]+_BASE_URL$|[A-Z0-9]+_HOST$)/i.test(name)) {
        scrubbed[name] = value;
      }
    }
    const child = spawn(process.execPath, ['--require', resolve(ROOT, 'tests/helpers/loopback.cjs'), resolve(ROOT, script)], { cwd: ROOT, env: { ...scrubbed, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    // A child that hangs is killed with its output kept, so the failure says where it stopped.
    const timer = setTimeout(() => {
      stderr += `
[killed after ${RUN_LIMIT_MS} ms]`;
      child.kill();
    }, RUN_LIMIT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

/** Under the 60 s test timeout, so a hung example fails with its output rather than a bare timeout. */
const RUN_LIMIT_MS = 50_000;

export interface ExampleCase {
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
  // The provider's own host; tests/helpers/loopback.cjs resolves it to the mock.
  env: { EXAMPLE_PROVIDER: provider, EXAMPLE_API_KEY: 'example-not-a-real-key', EXAMPLE_BASE_URL: `http://${domain}:{port}/v1`, EXAMPLE_CHAT_MODEL: 'gpt-4o-mini' },
  replies: [{ fixture: 'openai/chat.completion.json' }],
  spans: [`${provider}.chat.completion`],
  system: provider,
});

export const CASES: ExampleCase[] = [
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

/** The two examples with their own tests in tests/e2e/examples.test.ts, as cases. */
export const OPENAI_CASE: ExampleCase = {
  script: 'examples/openai/chat.mjs',
  env: { OPENAI_API_KEY: 'sk-example-not-a-real-key', OPENAI_BASE_URL: '{llm}/v1' },
  replies: [{ fixture: 'openai/chat.completion.tool-calls.json' }, { fixture: 'openai/chat.completion.stream.sse' }, { fixture: 'openai/embeddings.base64.json' }],
  spans: ['openai.chat.completion', 'openai.chat.completion', 'openai.embeddings'],
  system: 'openai',
};

export const ANTHROPIC_CASE: ExampleCase = {
  script: 'examples/anthropic/messages.mjs',
  env: { ANTHROPIC_API_KEY: 'sk-ant-example-not-a-real-key', ANTHROPIC_BASE_URL: '{llm}' },
  replies: [{ fixture: 'anthropic/message.tool-use.json' }, { fixture: 'anthropic/message.stream.sse' }, { fixture: 'anthropic/message.stream.sse' }],
  spans: ['anthropic.messages.create', 'anthropic.messages.create', 'anthropic.messages.stream'],
  system: 'anthropic',
};
