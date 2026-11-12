import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { httpToxicityJudge } from '../../src/evaluation/http-judge';

let server: Server | undefined;

async function judgeAnswering(body: unknown): Promise<string> {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/score`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('httpToxicityJudge score mapping', () => {
  it('keeps a score under its own name when the judge names a category the rules do not map', async () => {
    const url = await judgeAnswering({ custom_harm: 0.7, not_a_number: 'high', nothing: null });
    const score = httpToxicityJudge(url, 5);
    expect(score).toBeDefined();
    const scores = await score!('some text', ['toxicity']);
    expect(scores).toEqual({ custom_harm: 0.7 });
  });

  it('refuses an answer that carries no usable score', async () => {
    const url = await judgeAnswering({ scores: { toxicity: 'n/a' } });
    await expect(httpToxicityJudge(url, 5)!('some text', ['toxicity'])).rejects.toThrow('no score');
  });
});
