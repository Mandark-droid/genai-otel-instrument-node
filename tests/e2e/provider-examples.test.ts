/**
 * The provider examples, each run as a child process against the built package
 * and a mock provider. None is run against a live API here (no keys); this
 * proves each one executes and that the calls it makes produce their spans.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockLlm, type MockLlm } from '../helpers/mock-llm';
import { startOtlpReceiver, type OtlpReceiver } from '../helpers/otlp-receiver';
import { CASES, run } from '../helpers/provider-cases';

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
      for (const [name, value] of Object.entries(example.env)) env[name] = value.replace('{llm}', llm.url).replace('{port}', String(llm.port));
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
