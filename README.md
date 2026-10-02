# genai-otel-instrument-node

OpenTelemetry instrumentation for GenAI applications on Node.js / TypeScript: traces,
token and cost attribution, and (in later phases) GPU / energy / CO2 metrics and
evaluation signals - in the same wire format as the Python library
`genai-otel-instrument`.

**Private repository. Not published to any public registry.**

| | |
|---|---|
| Package | `@traceverse/genai-otel-instrument` |
| Minimum runtime | Node 18.19 |
| Reference implementation | `genai_otel_instrument` **v1.30.0** (pinned in `scripts/sync-from-python.mjs`) |
| Status | Phase 1 (foundation). No `v0.1.0` tag until the end-to-end evidence exists - see `CLAUDE.md` rule 9. |

A backend must not be able to tell which language produced a span except by three
resource attributes: `telemetry.sdk.language=nodejs`,
`telemetry.distro.name=genai-otel-instrument-node`, `telemetry.distro.version`.

## Use

One line, before the first LLM call:

```ts
import { instrument } from '@traceverse/genai-otel-instrument';

instrument({ serviceName: 'my-app', endpoint: 'http://collector:4318' });
```

Or with no code change at all:

```bash
# CommonJS application
node --require @traceverse/genai-otel-instrument/register app.js

# ES-module application
node --import @traceverse/genai-otel-instrument/register app.mjs
```

Configuration then comes from the environment - the same variables, defaults and parsing
as the Python library (`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `GENAI_*`).
See [docs/configuration.md](docs/configuration.md).

`instrument()` never throws into the application unless `GENAI_FAIL_ON_ERROR=true`: a
configuration or setup error is logged and the application runs uninstrumented. Export
is batched off the request path; an unreachable collector costs the application nothing
but the telemetry.

Before a short-lived process exits, drain what is queued:

```ts
import { flushTelemetry, uninstrument } from '@traceverse/genai-otel-instrument';

await flushTelemetry(5); // seconds; resolves false if the collector did not take it
await uninstrument();
```

## What is instrumented

See [docs/parity-matrix.md](docs/parity-matrix.md) for the state of every instrumentor
against the Python reference, including what is not applicable to Node and why.

## The contract

`contract/*.json` and `src/pricing/llm_pricing.json` are generated from the Python
library at the pinned tag and **vendored, never edited by hand**. The contract tests
read them:

| File | Checked by |
|---|---|
| `contract/config.json` | every environment variable, default and raw-value case |
| `contract/cost_vectors.json` | every cost vector, to 1e-9 |
| `contract/semconv.json` | attribute names, opt-in modes, resource attribute set, span emission |
| `contract/metrics.json` | instrument name, unit, kind, bucket boundaries |

```bash
npm run sync          # re-vendor from the generated contract directory
npm run sync:check    # verify nothing drifted or was hand-edited (runs in CI)
```

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md). In short:

```bash
npm ci
npm run typecheck && npm run lint && npm test && npm run build
```
