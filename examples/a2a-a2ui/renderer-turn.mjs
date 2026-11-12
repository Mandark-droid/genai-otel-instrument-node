// @ts-check
/**
 * A renderer's turn with an agent: the UI an agent sends over A2A, applied by the A2UI web renderer
 * core, and the user's tap sent back - one trace from the tap to the agent's reply, with the
 * A2UI facts (surface, catalog, action, validation errors) on the spans.
 *
 * The agent is played by a local `fetch`, so the example needs no network and no second process.
 *
 *   npm run build
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/a2a-a2ui/renderer-turn.mjs
 *
 * `a2a` and `a2ui` are in the default instrumentor list. The renderer adapter (`a2ui_web_core`) is
 * opt-in, so it is named here; content capture is off, so no message text is recorded.
 */
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { MessageProcessor } from '@a2ui/web_core';
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1';
import { flushTelemetry, instrument, instrumentorsReady, recordA2uiRendererError, traceAgent, uninstrument } from '@traceverse/genai-otel-instrument-node';

instrument({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'example-a2a-a2ui', enabledInstrumentors: ['a2a', 'a2ui_web_core'] });
await instrumentorsReady();

const A2UI = 'application/a2ui+json';
const surface = [
  { version: '1.0', createSurface: { surfaceId: 'trip', catalogId: basicCatalog.id } },
  { version: '1.0', updateComponents: { surfaceId: 'trip', components: [{ id: 'root', component: 'Text', text: 'Book the 9:40 flight?' }] } },
];

/** The agent: answers the first message with a surface, the second (the user's tap) with plain text. */
let turn = 0;
const fetchImpl = /** @type {typeof fetch} */ (
  async (_url, init) => {
    const { id } = JSON.parse(String(init?.body));
    turn += 1;
    const artifacts = turn === 1 ? [{ artifactId: 'ui', parts: [{ data: surface, mediaType: A2UI }] }] : [];
    const task = { id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_COMPLETED' }, artifacts };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { task } }));
  }
);
const card = {
  name: 'travel-agent',
  description: 'Books trips',
  version: '1.0.0',
  supportedInterfaces: [{ url: 'https://travel.example/a2a', protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
  capabilities: {},
  skills: [],
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: [],
  defaultOutputModes: [],
  extensions: [],
  signatures: [],
};
const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })] }).createFromAgentCard(/** @type {any} */ (card));
const message = (/** @type {any[]} */ parts) => /** @type {any} */ ({ tenant: '', message: { messageId: `m-${turn}`, contextId: '', taskId: '', role: 1, parts, extensions: [], referenceTaskIds: [] } });

const renderer = new MessageProcessor([basicCatalog]);

await traceAgent('renderer.turn', { id: 'turn-1' }, async () => {
  // 1. Ask. The reply carries a surface, which the renderer applies.
  const reply = /** @type {any} */ (await client.sendMessage(message([{ content: { $case: 'text', value: 'plan a trip' } }])));
  for (const artifact of reply.artifacts) {
    for (const part of artifact.parts) renderer.processMessages(part.content.value);
  }
  // 2. The renderer rejects what it cannot show: recorded on this span even if the app tells nobody.
  const errors = renderer.processMessagesWithErrors([{ version: '1.0', updateComponents: { surfaceId: 'gone', components: [{ id: 'root', component: 'Text', text: 'x' }] } }]);
  for (const error of errors) recordA2uiRendererError(error);
  // 3. The user taps: the action goes back to the agent, in the same trace.
  const action = { version: '1.0', action: { name: 'book_flight', surfaceId: 'trip', sourceComponentId: 'root', context: {} } };
  await client.sendMessage(message([{ content: { $case: 'data', value: action }, mediaType: A2UI }]));
});
console.log('surfaces:', [...renderer.getSurfaces().keys()].join(','));

const flushed = await flushTelemetry(10);
await uninstrument();
console.log(flushed ? 'telemetry exported' : 'telemetry was NOT accepted by the collector');
