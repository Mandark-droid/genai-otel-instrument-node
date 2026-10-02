/**
 * examples/mcp/tool-call.mjs, run as a child process against the built
 * package and a local OTLP receiver. It needs no other server.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('examples/mcp/tool-call.mjs', () => {
  let receiver: OtlpReceiver;

  beforeEach(async () => {
    receiver = await startOtlpReceiver();
  });
  afterEach(async () => {
    await receiver.close();
  });

  it('exports a client and a server span per tool call, under one session, with nothing of the payloads', async () => {
    const outcome = await run('examples/mcp/tool-call.mjs', {
      EXAMPLE_SESSION_ID: 'mcp-session-under-test',
      GENAI_MCP_HASH_SALT: 'example-salt',
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    });
    expect(outcome.code, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
    expect(outcome.stdout).toContain('session.id: mcp-session-under-test');
    expect(outcome.stdout).toContain('telemetry exported');

    const names = receiver.spans.map((span) => span.name).sort();
    expect(names).toEqual([
      'mcp.call_tool orders.cancel_order',
      'mcp.call_tool orders.cancel_order',
      'mcp.call_tool orders.find_order',
      'mcp.server.call_tool cancel_order',
      'mcp.server.call_tool cancel_order',
      'mcp.server.call_tool find_order',
    ]);
    for (const span of receiver.spans) expect(span.attributes['session.id'], span.name).toBe('mcp-session-under-test');

    const find = receiver.spans.find((span) => span.name === 'mcp.call_tool orders.find_order');
    expect(find?.attributes).toMatchObject({
      'mcp.server': 'orders',
      'mcp.stage': 'Track',
      'mcp.behaviour': 'read-only',
      'mcp.tool_selection.expected': 'find_order',
      'mcp.tool_selection.correct': true,
      'mcp.tool_selection.requested_capability': 'cancel_order',
    });
    expect(String(find?.attributes['mcp.user.id_hash'])).toMatch(/^sha256:[0-9a-f]{16}$/);

    const cancels = receiver.spans.filter((span) => span.name === 'mcp.call_tool orders.cancel_order');
    expect(cancels.map((span) => span.attributes['mcp.identifier.hallucinated']).sort()).toEqual([false, true]);

    const everything = JSON.stringify(receiver.spans.map((span) => span.attributes));
    for (const secret of ['customer@example.com', 'O-1001', 'O-9999', 'c-17', 'packed']) expect(everything, secret).not.toContain(secret);
  }, 60000);
});
