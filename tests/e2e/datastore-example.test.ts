/**
 * examples/datastores/qdrant.mjs, run as a child process against the built
 * package, a stand-in for Qdrant's HTTP API and a local OTLP receiver.
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
      if (value !== undefined && !/^(GENAI_|OTEL_|EXAMPLE_|QDRANT_)/i.test(name)) scrubbed[name] = value;
    }
    const child = spawn(process.execPath, [resolve(ROOT, script)], { cwd: ROOT, env: { ...scrubbed, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

describe('examples/datastores/qdrant.mjs', () => {
  let qdrant: MockLlm;
  let receiver: OtlpReceiver;

  beforeEach(async () => {
    qdrant = await startMockLlm();
    receiver = await startOtlpReceiver();
  });
  afterEach(async () => {
    await qdrant.close();
    await receiver.close();
  });

  it('exports one client span with the score summary, under the session it prints', async () => {
    qdrant.reply({ json: { result: { points: [{ id: 1, version: 1, score: 0.9 }, { id: 2, version: 1, score: 0.5 }] }, status: 'ok', time: 0.001 } });
    const outcome = await run('examples/datastores/qdrant.mjs', {
      QDRANT_URL: qdrant.url,
      EXAMPLE_COLLECTION: 'docs',
      EXAMPLE_VECTOR_SIZE: '4',
      EXAMPLE_SESSION_ID: 'session-under-test',
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    });
    expect(outcome.code, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
    expect(outcome.stdout).toContain('session.id: session-under-test | points: 2 | top score: 0.9');
    expect(outcome.stdout).toContain('telemetry exported');

    expect(receiver.spans.map((span) => span.name)).toEqual(['qdrant.query_points']);
    const [span] = receiver.spans;
    expect(span?.statusCode).toBe(1);
    expect(span?.attributes).toMatchObject({
      'db.system': 'qdrant',
      'db.collection.name': 'docs',
      'db.vector.top_k': 5,
      'rag.result.score_max': 0.9,
      'rag.result.score_min': 0.5,
      'session.id': 'session-under-test',
    });
    // The request body reached the server; none of it reached the span.
    expect(qdrant.requests[0]?.path).toContain('/collections/docs/points/query');
    expect(JSON.stringify(span?.attributes)).not.toContain('0.84');
    expect(receiver.metrics.map((metric) => metric.name)).toEqual(expect.arrayContaining(['mcp.requests', 'mcp.client.operation.duration']));
  }, 60000);
});
