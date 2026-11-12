# A2A and A2UI example: a renderer's turn with an agent

`renderer-turn.mjs`: an A2A client (`@a2a-js/sdk`) asks an agent for a UI, the renderer core
(`@a2ui/web_core`) applies the surface the agent sent, rejects one update it cannot apply, and the
user's tap goes back to the agent. The agent is played by a local `fetch` handed to the SDK's own
JSON-RPC transport, so the example needs no network and no second process.

Spans (all under one `invoke_agent renderer.turn`):

| Span | What it says |
|---|---|
| `SendMessage travel-agent` (CLIENT, twice) | The call: method, binding, target agent, task id and state. The first carries the surface the agent sent (`a2ui.surface.id`, `a2ui.catalog.id`, `a2ui.agent_message.count`), the second the tap (`a2ui.action.name`, `a2ui.renderer_message.count`). `traceparent` went out with each call |
| `a2ui.apply` (INTERNAL, twice) | One batch applied by the renderer. The second is ERROR: the renderer rejected the update (`a2ui.error.codes = INTEGRITY_ERROR`, one `a2ui.error` event) |
| `invoke_agent renderer.turn` | The application's own span; `recordA2uiRendererError()` put the rejected update's code on it |

Content capture is off, so no message text, action context or error message is recorded.

`a2a` and `a2ui` are in the default instrumentor list. The renderer adapter, `a2ui_web_core`, is
opt-in, so the example names it.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run | **Yes, run here and in CI**: it needs no network. `tests/e2e/examples.test.ts` runs it as a child process against the built package and checks the five spans it exports |
| Against a live A2A agent (HTTP, SSE, gRPC) | **No.** The client calls are traced on the SDK's `Client` class, not on a transport; only the JSON-RPC transport was exercised, over a local `fetch` |

## Run it

```bash
npm ci && npm run build
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/a2a-a2ui/renderer-turn.mjs
```
