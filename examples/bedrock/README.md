# AWS Bedrock example

`converse.mjs`: A Converse call and an InvokeModel call through `@aws-sdk/client-bedrock-runtime`.

Spans: `aws.bedrock.converse`, `aws.bedrock.invoke_model`.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock provider | Yes: `tests/e2e/provider-examples.test.ts` runs it as a child process against the built package and a mock provider, and checks the spans it exports |
| Run against the live API | **No.** No AWS credentials were available where this was written |

## Run it

```bash
npm ci && npm run build
AWS_REGION=us-east-1 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/bedrock/converse.mjs
```

With no collector at hand, set `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) to print spans and
metrics to the console instead.

The instrumentor is registered as `boto3`, the name the Python library uses for it, so one `GENAI_ENABLED_INSTRUMENTORS` value works for both.
