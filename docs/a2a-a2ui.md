# A2A and A2UI

Spans for the two protocols an agent uses to talk to other agents and to a user interface:

- **A2A** (Agent2Agent): one `CLIENT` span per call a client makes to another agent, with the
  trace context sent along so one trace runs across both agents. For `@a2a-js/sdk` 1.x.
- **A2UI** (Agent-to-UI): the UI an agent sends as declarative JSON and the actions a user takes on
  it. Read off the A2A calls, off `@a2ui/agent`, off `@a2ui/web_core`, or recorded by your own
  code through a small API.

A port of the Python library's `a2a` (1.47.0) and `a2ui` (1.48.0) instrumentors: the same
attribute names, span names, content rule and multi-value rule, taken from the Python code
(`contract/a2a-a2ui.json`, see [the contract](#the-contract)). The A2UI names are marked
**provisional**: OpenTelemetry has no convention for A2UI.

| Piece | Package | Span | On by default |
|---|---|---|---|
| A2A client | `@a2a-js/sdk` 1.x | `{method} {agent}` (`SendMessage weather-agent`), `CLIENT` | yes (`a2a`) |
| A2UI agent SDK | `@a2ui/agent` 0.1.0 | `a2ui.parse_response`, `a2ui.parse_stream` | yes (`a2ui`) |
| A2UI renderer core | `@a2ui/web_core` 0.15 | `a2ui.apply` | **no**: name `a2ui_web_core`, or hand the module over |
| Your own transport | none | attributes on the current span, or `a2ui.receive` / `a2ui.send {type}` / `a2ui.renderer_error` | the API is always there |

Each of the first three does nothing when its package is not installed. Nothing here needs a
setting to turn on, and `GENAI_A2UI_ENABLED=false` turns the A2UI part off without touching A2A.

## What an A2A call records

```ts
import { instrument } from '@traceverse/genai-otel-instrument-node';
instrument({ serviceName: 'my-agent' }); // a2a and a2ui are in the default list

const client = await new ClientFactory().createFromUrl('https://agents.example');
await client.sendMessage({ tenant: '', message });      // -> span "SendMessage weather-agent"
```

The wrapped methods of `@a2a-js/sdk/client`'s `Client`:

| Client method | `a2a.method.name` |
|---|---|
| `sendMessage` | `SendMessage` |
| `sendMessageStream` | `SendStreamingMessage` when the Agent Card says the agent streams, else `SendMessage` |
| `getTask`, `listTasks`, `cancelTask` | `GetTask`, `ListTasks`, `CancelTask` |
| `createTaskPushNotificationConfig`, `getTaskPushNotificationConfig`, `listTaskPushNotificationConfig`, `deleteTaskPushNotificationConfig` | `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, `DeleteTaskPushNotificationConfig` |
| `resubscribeTask` | `SubscribeToTask` |
| `getAgentCard` | `GetExtendedAgentCard`: only when the card has an extended form to fetch; otherwise the SDK hands back its own card without a call, and there is no span |

The span is named `{a2a.method.name} {target}`, the target being the Agent Card's name (else the
host). A streaming call's span ends when its stream does, with the **final** task state; a stream
nobody reads has no span; a stream the caller abandons ends its span when it is closed or collected.

| Attribute | Value |
|---|---|
| `a2a.method.name`, `gen_ai.operation.name` | the method; `invoke_agent`, so a backend can draw an edge from your agent to the one called |
| `gen_ai.agent.name`, `.description`, `.version`, `a2a.agent.skill_count` | from the Agent Card |
| `a2a.protocol.binding` (provisional), `a2a.protocol.version`, `server.address`, `server.port` | the transport (`jsonrpc`, `grpc`, `http_json`); the card's interface for it |
| `a2a.tenant`, `a2a.message.id`, `a2a.message.reference_task_ids` | the request |
| `a2a.task.id`, `a2a.task.state`, `gen_ai.conversation.id` | task, final state (lower case, `input_required`), the A2A `contextId`. Left off when the operation saw several tasks or contexts: they would mislabel the span |
| `a2a.message.{text,file,data}_part_count`, `a2a.message.file_media_types` | parts of the request, by kind |
| `a2a.response.{text,file,data}_part_count`, `a2a.response.file_media_types`, `a2a.artifact.count` | what came back (reply message, status message, artifacts) |
| `error.type` | the class of the error the SDK threw (`TaskNotFoundError`, ...) |

A task that ends `failed` or `rejected` is **not** an error span: the call worked and the agent's
answer was no, so `a2a.task.state` says so and the status stays unset. Only a thrown error makes
the span `ERROR`. A request the caller aborts is not counted as a failed call.

**Content.** Ids, states, counts, media types and the Agent Card's name, description and version
are always recorded. Message and artifact text (`a2a.message.text`, `a2a.response.text`), data
parts (`a2a.message.data`, `a2a.response.data`) and skill names (`a2a.agent.skill_names`) only
with content capture on, cut to `GENAI_CONTENT_MAX_LENGTH`. File bytes, URLs and names are never
recorded. The text of an error is kept only with content capture on; it can echo content.

### One trace across two agents

Each call adds W3C `traceparent` and `tracestate` to the call's `serviceParameters`, which the
SDK turns into HTTP headers (JSON-RPC and REST) and gRPC metadata. Baggage follows the
session-baggage policy (`GENAI_SESSION_BAGGAGE_KEYS`): `session.id` and `user.id` leave only when
named there, other baggage passes as the stock propagator would. Your own `serviceParameters` are
kept and your options object is never edited: a copy goes down. `GENAI_A2A_PROPAGATE=false`
turns this off (default on).

The Python library does this through the SDK's interceptor. Here it is the options object,
because the wrapper has the call's span open before the SDK builds its request, the result is the
same, and it does not depend on the application's `clientConfig.interceptors`.

## What A2UI records

An A2UI part is a data part whose media type is `application/a2ui+json` or the deprecated
`application/json+a2ui` (in `mediaType` or in `metadata.mimeType`). Its data is **one message or a
list of messages**: the specification says a list, the agent SDKs write one per part, and both are
read. The same reader serves the A2A calls, the agent SDK wrapper, the renderer adapter and the
API.

| Attribute | Meaning |
|---|---|
| `a2ui.protocol.version` | `1.0`, `0.9`, `0.8`; left off when the operation saw more than one. A message with no `version` is v0.8: counted, not read |
| `a2ui.agent_message.count`, `a2ui.renderer_message.count` | agent-to-renderer and renderer-to-agent messages in the operation |
| `a2ui.message.types` | sorted, de-duplicated (`create_surface`, `update_components`, `action`, `error`, ...) |
| `a2ui.surface.id`, `a2ui.surface.count` | the surface when there is one; the count of distinct surfaces |
| `a2ui.catalog.id`, `a2ui.catalog.ids` | the catalog when there is one; every catalog referenced (`createSurface`, a component's own, function calls) |
| `a2ui.component.count` | components in `createSurface` and `updateComponents` |
| `a2ui.renderer.supported_catalog_ids` | the renderer's capabilities, from `a2uiRendererCapabilities` or `a2uiClientCapabilities` in the message or request metadata |
| `a2ui.action.name`, `a2ui.function.name` | the user's action, a function call; left off when several |
| `a2ui.error.codes`, `a2ui.error.count`, event `a2ui.error` | renderer and function error codes, one event per error with `a2ui.error.code` and `a2ui.surface.id` |
| `a2ui.validation.outcome` | `valid` or `invalid` |
| `a2ui.extension.active` | the A2UI extension URI (`https://a2ui.org/a2a-extension/a2ui/...`, any version) was named in `A2A-Extensions` or `X-A2A-Extensions`, or on a message or artifact |

With **content capture on**, also: `a2ui.messages` (the messages, as sorted JSON), `a2ui.data_model`,
`a2ui.action.context`, `a2ui.error.paths`, `a2ui.error.messages` and `a2ui.component.types`. Media
URLs inside components (a key named `url`, `src`, `uri`, or ending in `Url` / `Uri`) and any
`data:` URI are replaced by `[redacted]`, a data binding (`{"@path": ...}`) is kept, and the A2A
`data` attributes carry the same scrubbed copy.

A renderer `error` message or a function error does **not** make the carrying A2A span an error.

## The API, for transports this library does not see

For AG-UI, a WebSocket of your own, MCP Apps, or a renderer that talks to its agent some other way.
Each call adds the attributes above to the span that is current, or, when none is recording, opens a
short `INTERNAL` span. Several calls on one span accumulate into it. They never throw and never set
a status.

```ts
import { recordA2uiReceived, recordA2uiSent, recordA2uiRendererError } from '@traceverse/genai-otel-instrument-node';

socket.on('message', (messages) => {
  recordA2uiReceived(messages);                    // one message, a list, or { messages: [...] }
  try { renderer.processMessages(messages); }
  catch (error) { recordA2uiRendererError(error); } // an Error (its code / surfaceId / path), or a { code, ... } body
});
button.onclick = () => {
  const action = { version: '1.0', action: { name: 'book', surfaceId: 'trip', context: {} } };
  recordA2uiSent(action);                          // span name when none is current: "a2ui.send action"
  socket.send(JSON.stringify(action));
};
```

All three are exported from the Node, browser and React Native entries. An error given as a bare
`Error` or `{ code, message }` has no protocol version, so none is recorded for it.

## The agent SDK: `@a2ui/agent`

| Method | Span |
|---|---|
| `A2uiRequestProcessor.parseResponse` | `a2ui.parse_response` (`INTERNAL`), a child of the LLM span it ran under. `ERROR` with `error.type` = the error's class when the SDK threw: the model wrote UI the SDK rejected and the user sees nothing |
| `A2uiRequestProcessor.openStream` | `a2ui.parse_stream`, open until `close()` returns or `feed` / `close` throws; the totals at the end. A stream opened with `afterRejectedBlock: 'continue'` reads past a rejected block, and is `ERROR` too |

`@a2ui/agent` 0.1.0 has no renderer-to-agent message processor, so the Python library's
`a2ui.process` span has no counterpart yet. Without content capture the error message is not on
the span (it can quote the model's output).

## The renderer: `@a2ui/web_core` (opt-in)

`@a2ui/react`, `@a2ui/lit` and `@a2ui/angular` share `@a2ui/web_core`'s `MessageProcessor`. Name the
adapter, or hand the module over:

```ts
instrument({ enabledInstrumentors: ['a2a', 'a2ui', 'a2ui_web_core'] });   // Node
// browsers and React Native:
import * as webCore from '@a2ui/web_core';
instrumentA2uiWebCore(webCore);
```

One `a2ui.apply` span per batch applied (`processMessages`, `processMessagesWithErrors`,
`processMessagesAsync`), as long as the batch took. It is `ERROR` when the renderer rejected the
batch: the processor threw, or reported errors. Every renderer-side error is an `a2ui.error` event
with its code and surface and is counted in `a2ui.error.codes`, **even when the application never
sends the `error` message back to the agent** (`reportErrorsOnly: true`, or
`processMessagesWithErrors`): the errors are read where the processor makes them.

## Browsers and React Native

There is no module lookup by name there, so each library is handed over, before or after
`instrument()`:

```ts
import * as a2aClient from '@a2a-js/sdk/client';
import * as agent from '@a2ui/agent';
import * as webCore from '@a2ui/web_core';
import { instrumentA2aClient, instrumentA2uiAgent, instrumentA2uiWebCore } from '@traceverse/genai-otel-instrument-node';

instrumentA2aClient(a2aClient);   // the A2A client
instrumentA2uiAgent(agent);       // an agent running in the page
instrumentA2uiWebCore(webCore);   // the renderer core (opt-in)
```

Each returns `false` when what it was given is not the library. In those entries a call's span is
not made the active span while the SDK runs (they share one scope stack: a call in the background
must not capture what the app starts meanwhile), so `fetch` spans of your own are not its children;
the `traceparent` still goes out with the call. For React Native renderers that do not use
`@a2ui/web_core`, the A2A path and the API above apply.

`@a2ui/agent` and `@a2ui/web_core` are ES-module only. In an ES-module application they are patched
by name as they are for every other library; in a CommonJS application a package reached only
through a dynamic `import()` is not found by name, so hand it over
(`instrumentA2uiAgent(await import('@a2ui/agent'))`, available on the Node entry too).

## Settings

| Variable | Default | Notes |
|---|---|---|
| `GENAI_A2UI_ENABLED` | `true` | Turns the A2UI attributes, events and spans off. A2A is untouched. Only `false` (any case, no surrounding space) turns it off |
| `GENAI_A2A_PROPAGATE` | `true` | `false`: no trace context goes out on A2A calls |
| `GENAI_ENABLED_INSTRUMENTORS` | | `a2a` and `a2ui` are in the default list; `a2ui_web_core` is opt-in |
| `GENAI_ENABLE_CONTENT_CAPTURE`, `GENAI_CONTENT_MAX_LENGTH` | | Govern every content attribute above. There is no separate A2UI switch |

## Not covered

- The A2A **server** side (an agent written in Node): later.
- `a2ui.process` (the renderer-to-agent processor): `@a2ui/agent` 0.1.0 has none.
- Flutter, SwiftUI and Jetpack Compose renderers: no Dart, Swift or Kotlin port.
- A2A metrics: spans only.
- A2A over the SDK's v0.3 compatibility layer was not exercised.

## The contract

The A2A and A2UI names are a **scoped addition** to the vendored contract, not part of the contract
pinned at Python v1.46.0 (a full re-pin would also bring in unrelated 1.46.x to 1.48.0 changes).
`contract/a2a-a2ui.json` is generated from the Python repository's attribute modules at one commit
(`npm run sync:a2a-a2ui`); `npm run generate` turns it into constants, and
`npm run sync:a2a-a2ui:check` (run in CI) fails if it was edited by hand. A test compares every
constant to the file. `GENAI_A2UI_ENABLED` and `GENAI_A2A_PROPAGATE` read the Python expression
`os.getenv(X, "true").lower() != "false"` exactly; the two names in the default instrumentor list
are the only difference from the pinned list.
