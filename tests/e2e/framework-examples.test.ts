/**
 * examples/langgraph and examples/vercel-ai-sdk, each run as a child process
 * against the built package, the mock LLM and a local OTLP receiver.
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
      if (value !== undefined && !/^(GENAI_|OTEL_|EXAMPLE_)/i.test(name)) scrubbed[name] = value;
    }
    const child = spawn(process.execPath, [resolve(ROOT, script)], { cwd: ROOT, env: { ...scrubbed, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

describe('framework examples', () => {
  let receiver: OtlpReceiver;
  let llm: MockLlm;

  beforeEach(async () => {
    receiver = await startOtlpReceiver();
    llm = await startMockLlm();
  });
  afterEach(async () => {
    await receiver.close();
    await llm.close();
  });

  it('examples/langgraph/agent.mjs: one graph span over two model calls, one session, consumption against the budget', async () => {
    llm.reply({ fixture: 'openai/chat.completion.json' });
    llm.reply({ fixture: 'openai/chat.completion.json' });
    const outcome = await run('examples/langgraph/agent.mjs', {
      EXAMPLE_BASE_URL: `${llm.url}/v1`,
      EXAMPLE_CHAT_MODEL: 'gpt-4o-mini',
      EXAMPLE_SESSION_ID: 'graph-thread-under-test',
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    });
    expect(outcome.code, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
    expect(outcome.stdout).toContain('session.id: graph-thread-under-test');
    expect(outcome.stdout).toContain('telemetry exported');

    expect(receiver.spans.map((span) => span.name).sort()).toEqual(['langgraph.graph.invoke', 'openai.chat.completion', 'openai.chat.completion']);
    const graph = receiver.spans.find((span) => span.name === 'langgraph.graph.invoke');
    const calls = receiver.spans.filter((span) => span.name === 'openai.chat.completion');
    expect(graph?.spanId).toMatch(/^[0-9a-f]{16}$/);
    for (const call of calls) {
      expect(call.parentSpanId).toBe(graph?.spanId);
      expect(call.attributes['session.id']).toBe('graph-thread-under-test');
    }
    const perCall = Number(calls[0]?.attributes['gen_ai.usage.total_tokens']);
    expect(perCall).toBeGreaterThan(0);
    expect(graph?.attributes).toMatchObject({
      'gen_ai.operation.name': 'graph.execution',
      'session.id': 'graph-thread-under-test',
      'gen_ai.agent.iteration_budget': 10,
      'gen_ai.agent.iteration_budget.consumed': 2,
      'gen_ai.agent.token_budget.consumed': perCall * 2,
    });
    // The question is on no span: content capture is off.
    expect(JSON.stringify(receiver.spans.map((span) => span.attributes))).not.toContain('capital of France');
  }, 60_000);

  it('examples/vercel-ai-sdk/generate.mjs: the SDK\'s own spans, priced once, in the session, without the prompt', async () => {
    llm.reply({ fixture: 'openai/chat.completion.json' });
    const outcome = await run('examples/vercel-ai-sdk/generate.mjs', {
      EXAMPLE_BASE_URL: `${llm.url}/v1`,
      EXAMPLE_CHAT_MODEL: 'gpt-4o-mini',
      EXAMPLE_PROVIDER_NAME: 'openai',
      EXAMPLE_SESSION_ID: 'ai-sdk-session-under-test',
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    });
    expect(outcome.code, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
    expect(outcome.stdout).toContain('session.id: ai-sdk-session-under-test');
    expect(outcome.stdout).toContain('telemetry exported');

    const priced = receiver.spans.filter((span) => 'gen_ai.usage.cost.total' in span.attributes);
    expect(priced.map((span) => span.name)).toEqual(['chat gpt-4o-mini']);
    expect(priced[0]?.attributes).toMatchObject({ 'gen_ai.system': 'openai', 'gen_ai.request.model': 'gpt-4o-mini' });
    expect(receiver.spans.some((span) => span.name === 'invoke_agent gpt-4o-mini')).toBe(true);
    for (const span of receiver.spans) expect(span.attributes['session.id'], span.name).toBe('ai-sdk-session-under-test');
    expect(JSON.stringify(receiver.spans.map((span) => span.attributes))).not.toContain('capital of France');
  }, 60_000);
});
