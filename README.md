# @traceverse/genai-otel-instrument-node

OpenTelemetry instrumentation for GenAI applications on Node.js / TypeScript: traces,
token and cost attribution, and (in later phases) GPU / energy / CO2 metrics and
evaluation signals - in the same wire format as the Python library
`genai-otel-instrument`.

[![npm](https://img.shields.io/npm/v/@traceverse/genai-otel-instrument-node/next)](https://www.npmjs.com/package/@traceverse/genai-otel-instrument-node) [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-site-indigo)](https://mandark-droid.github.io/genai-otel-instrument-node-docs/)

**Pre-release** (`0.1.0-alpha`). Documentation: https://mandark-droid.github.io/genai-otel-instrument-node-docs/ · Python library: [`genai-otel-instrument`](https://pypi.org/project/genai-otel-instrument/)

```bash
npm install @traceverse/genai-otel-instrument-node@next
```

| | |
|---|---|
| Package | `@traceverse/genai-otel-instrument-node` |
| Minimum runtime | Node 18.19 |
| Reference implementation | `genai_otel_instrument` **v1.46.0** (pinned in `scripts/sync-from-python.mjs`) |
| Status | Phase 1 (foundation), `0.1.0-alpha` pre-releases. No `v0.1.0` until the end-to-end evidence exists. |

A backend must not be able to tell which language produced a span except by three
resource attributes: `telemetry.sdk.language=nodejs`,
`telemetry.distro.name=genai-otel-instrument-node`, `telemetry.distro.version`.

## Use

One line, before the first LLM call:

```ts
import { instrument } from '@traceverse/genai-otel-instrument-node';

instrument({ serviceName: 'my-app', endpoint: 'http://collector:4318' });
```

Or with no code change at all:

```bash
# CommonJS application
node --require @traceverse/genai-otel-instrument-node/register app.js

# ES-module application
node --import @traceverse/genai-otel-instrument-node/register app.mjs
```

Use the hook that matches the application's module format: the ES-module build of a client
library can only be patched asynchronously, and `--import` waits for that before the
application starts.

Configuration then comes from the environment - the same variables, defaults and parsing
as the Python library (`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `GENAI_*`).
See [docs/configuration.md](https://mandark-droid.github.io/genai-otel-instrument-node-docs/configuration/).

`instrument()` never throws into the application unless `GENAI_FAIL_ON_ERROR=true`: a
configuration or setup error is logged and the application runs uninstrumented. Export
is batched off the request path; an unreachable collector costs the application nothing
but the telemetry.

Before a short-lived process exits, drain what is queued:

```ts
import { flushTelemetry, uninstrument } from '@traceverse/genai-otel-instrument-node';

await flushTelemetry(5); // seconds; resolves false if the collector did not take it
await uninstrument();
```

## Sessions

The platform groups spans into a session by `session.id`. A run whose spans carry none
shows up as traces with no session. Say which session a piece of work belongs to:

```js
import { withSession, setSession } from '@traceverse/genai-otel-instrument-node';

await withSession('chat-41', () => handle(request), { userId: 'u-17' }); // everything started inside
setSession('chat-41');                                                   // or: everything from now on
```

Every span started in scope gets `session.id`, `gen_ai.conversation.id` and, if given,
`user.id`. `sessionIdExtractor` / `userIdExtractor` (the reference library's callbacks)
are still supported and win for the spans they apply to. In a browser or React Native
app use `setSession`: there `withSession` does not hold across `await`.

## Browser and React Native

The same package loads in a browser bundle and in a React Native app, through the
`browser` and `react-native` export conditions. Those entries contain the core
(configuration, cost, semantic conventions, metrics), an explicit `instrument({...})`
that exports OTLP over `fetch`, and `traceGenAiCall()` for calls the app makes itself.
There is no default endpoint there: telemetry leaves the device only for a collector you
name. See [Runtimes](https://mandark-droid.github.io/genai-otel-instrument-node-docs/runtimes/), including what is and is not sent, and the [React Native and Cactus guide](https://mandark-droid.github.io/genai-otel-instrument-node-docs/react-native/), verified on a phone in the LiquidChat app.

In those entries:

- **Spans nest across `await`.** There is no async context in React Native or a plain
  browser, so the entry registers a context manager that keeps a context active until the
  promise passed to `context.with()` settles. A Cactus completion started inside your agent
  span becomes its child instead of a trace of its own. With two pipelines running at once,
  pass the parent explicitly where it matters.
- **Arize AX and Phoenix work as they are.** Every span carries `openinference.span.kind`
  (`LLM`, `EMBEDDING`, `RETRIEVER`, `TOOL`, `AGENT`, `CHAIN`), so operations with no GenAI
  operation to map (speech to text, model loads, your pipeline steps) are classified rather
  than "unknown". The resource carries `openinference.project.name` (the service name, or
  `OPENINFERENCE_PROJECT_NAME`), which Arize requires to accept a trace. Point the endpoint
  at `https://otlp.arize.com` with `space_id` and `api_key` headers. Other backends ignore
  both attributes. Content the span already carries (messages, tool arguments and results)
  is also exported under the names those backends display (`input.value`, `output.value`,
  `tool.*`). Turn all of this off with `openInferenceSpanKinds: false`.
- **Retrieval.** `addRetrievalAttributes(span, documents, { query })` records what a search
  returned, in rank order, under the same names as the Python library (available in every
  entry).
- **One call.** In React Native, `instrument({...})` is all an app needs: `AppState` and
  `cactus-react-native` are picked up when installed, and a finished trace is sent at once.
- **Agent graph.** Spans that name an agent carry the `graph.node.*` keys Arize AX and Phoenix
  draw their agent graph from, with each agent's parent the nearest enclosing agent, as in the
  Python library (`GENAI_ENABLE_AGENT_GRAPH_ATTRIBUTES=false` turns it off).
- **Your own components.** `traceAgent`, `traceTool`, `traceRetrieval` and `traceWorkflow`
  wrap an agent loop, a tool dispatcher, a search or a pipeline in one call each, with the
  conventions above built in (every entry, Node included).

## What is instrumented

| Library | Versions verified | Covered |
|---|---|---|
| `openai` | 4.0.0 - 7.27.0 | Chat Completions (buffered, streamed, tool calls), Embeddings, Responses API. Any OpenAI-compatible endpoint (vLLM, llama.cpp server, LiteLLM, Ollama) through the same client |
| `@anthropic-ai/sdk` | 0.20.0 - 0.131.0 | `messages.create` (buffered, streamed), `messages.stream()` |

Each call is one span with the request model, token counts, cost, and for streamed calls
time to first token. A model with no price in the shipped table gets **no** cost attribute
and `gen_ai.usage.cost.pricing_source = unpriced` - never a cost of 0.

See [docs/parity-matrix.md](https://mandark-droid.github.io/genai-otel-instrument-node-docs/parity-matrix/) for the state of every instrumentor
against the Python reference, what is not applicable to Node and why, and the reference
behaviours that were ported as they are.

An application bundled so that the client library cannot be resolved at run time can hand
it over explicitly:

```ts
import OpenAI from 'openai';
import { loadConfig, OpenAIInstrumentor } from '@traceverse/genai-otel-instrument-node';

new OpenAIInstrumentor().instrumentModule({ OpenAI }, loadConfig());
```

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
