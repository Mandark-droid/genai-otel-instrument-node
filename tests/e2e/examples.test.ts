/**
 * Runs the example programs as child processes against the built package and a
 * mock provider. They are not run against the live APIs anywhere (no key); this
 * proves they execute, and that each call they make produces its span.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';
import { startOtlpReceiver, type OtlpReceiver } from '../helpers/otlp-receiver';

const ROOT = resolve(__dirname, '../..');

function run(script: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const scrubbed: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(GENAI_|OTEL_|OPENAI_|ANTHROPIC_|EXAMPLE_)/i.test(name)) scrubbed[name] = value;
    }
    const child = spawn(process.execPath, [resolve(ROOT, script)], { cwd: ROOT, env: { ...scrubbed, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

describe('examples, against a mock provider', () => {
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

  it('examples/openai/chat.mjs: tool call, stream, embeddings -> three spans', async () => {
    llm.reply({ fixture: 'openai/chat.completion.tool-calls.json' });
    llm.reply({ fixture: 'openai/chat.completion.stream.sse' });
    llm.reply({ fixture: 'openai/embeddings.base64.json' });
    const outcome = await run('examples/openai/chat.mjs', {
      OPENAI_API_KEY: 'sk-example-not-a-real-key',
      OPENAI_BASE_URL: `${llm.url}/v1`,
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    });
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain('finish reason: tool_calls | tokens: 116');
    expect(outcome.stdout).toContain('Paris.');
    expect(outcome.stdout).toContain('vectors: 2 x 4');
    expect(outcome.stdout).toContain('telemetry exported');

    expect(receiver.spans.map((span) => span.name)).toEqual(['openai.chat.completion', 'openai.chat.completion', 'openai.embeddings']);
    expect(receiver.spans.every((span) => span.statusCode === 1)).toBe(true);
    expect(receiver.spans.every((span) => span.resource['service.name'] === 'example-openai')).toBe(true);
    const [tools, streamed, embeddings] = receiver.spans;
    expect(tools?.attributes['llm.output_messages.0.message.tool_calls.0.tool_call.function.name']).toBe('get_weather');
    expect(streamed?.attributes['gen_ai.usage.total_tokens']).toBe(22);
    expect(streamed?.attributes['gen_ai.server.time_to_first_token']).toBeGreaterThan(0);
    expect(embeddings?.attributes['gen_ai.response.vector_size']).toBe(4);
    for (const span of receiver.spans) expect(span.attributes['gen_ai.usage.cost.total'], span.name).toBeGreaterThan(0);
  }, 60000);

  it('examples/anthropic/messages.mjs: tool use, event stream, stream helper -> three spans', async () => {
    llm.reply({ fixture: 'anthropic/message.tool-use.json' });
    llm.reply({ fixture: 'anthropic/message.stream.sse' });
    llm.reply({ fixture: 'anthropic/message.stream.sse' });
    const outcome = await run('examples/anthropic/messages.mjs', {
      ANTHROPIC_API_KEY: 'sk-ant-example-not-a-real-key',
      ANTHROPIC_BASE_URL: llm.url,
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    });
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain('stop reason: tool_use | output tokens: 58');
    expect(outcome.stdout).toContain('final: Paris.');
    expect(outcome.stdout).toContain('telemetry exported');

    expect(receiver.spans.map((span) => span.name)).toEqual([
      'anthropic.messages.create',
      'anthropic.messages.create',
      'anthropic.messages.stream',
    ]);
    expect(receiver.spans.every((span) => span.statusCode === 1)).toBe(true);
    expect(receiver.spans.map((span) => span.attributes['gen_ai.usage.total_tokens'])).toEqual([468, 34, 34]);
    for (const span of receiver.spans) expect(span.attributes['gen_ai.usage.cost.total'], span.name).toBeGreaterThan(0);
  }, 60000);

  it('examples/a2a-a2ui/renderer-turn.mjs: A2A calls, a surface applied, a rejected update, the tap -> one trace', async () => {
    const outcome = await run('examples/a2a-a2ui/renderer-turn.mjs', { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url });
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain('surfaces: trip');
    expect(outcome.stdout).toContain('telemetry exported');

    const names = receiver.spans.map((span) => span.name).sort();
    expect(names).toEqual(['SendMessage travel-agent', 'SendMessage travel-agent', 'a2ui.apply', 'a2ui.apply', 'invoke_agent renderer.turn']);
    const [first, second] = receiver.spans.filter((span) => span.name === 'SendMessage travel-agent');
    expect(first?.kind).toBe(3);
    expect(first?.attributes['a2ui.surface.id']).toBe('trip');
    expect(first?.attributes['a2ui.agent_message.count']).toBe(2);
    expect(second?.attributes['a2ui.action.name']).toBe('book_flight');
    expect(second?.attributes['a2ui.renderer_message.count']).toBe(1);
    const turn = receiver.spans.find((span) => span.name === 'invoke_agent renderer.turn');
    // The rejected update is on the turn's own span; the apply spans say it was rejected.
    expect(turn?.attributes['a2ui.error.codes']).toEqual(['INTEGRITY_ERROR']);
    expect(receiver.spans.filter((span) => span.name === 'a2ui.apply').map((span) => span.statusCode).sort()).toEqual([0, 2]);
    // One trace: the calls and the applies are all children of the turn.
    for (const span of receiver.spans.filter((candidate) => candidate !== turn)) expect(span.parentSpanId, span.name).toBe(turn?.spanId);
    expect(JSON.stringify(receiver.spans.map((span) => span.attributes))).not.toContain('Book the 9:40');
  }, 60000);
});
