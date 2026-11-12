/**
 * Start and stop the A2A and A2UI instrumentors on the browser and React Native entries, where a
 * package cannot be looked up by name: `instrument()` attaches the configuration, and the
 * application hands each library over (`instrumentA2aClient`, `instrumentA2uiAgent`,
 * `instrumentA2uiWebCore`). Either order works; spans appear once both have happened. After
 * `uninstrument()` the libraries are restored, and a later `instrument()` needs them handed over again.
 */
import type { OTelConfig } from '../config';
import { a2aClientInstrumentor } from '../a2a/client-instrumentor';
import { a2uiAgentInstrumentor } from './agent-instrumentor';
import { a2uiWebCoreInstrumentor } from './web-core-instrumentor';

/** Trace `@a2a-js/sdk`'s client: `import * as client from '@a2a-js/sdk/client'; instrumentA2aClient(client)`. False if it is not that module. */
export function instrumentA2aClient(module: unknown): boolean {
  return a2aClientInstrumentor().instrumentModule(module);
}

/** Trace `@a2ui/agent`: `import * as agent from '@a2ui/agent'; instrumentA2uiAgent(agent)`. False if it is not that module. */
export function instrumentA2uiAgent(module: unknown): boolean {
  return a2uiAgentInstrumentor().instrumentModule(module);
}

/** Trace `@a2ui/web_core`'s `MessageProcessor` (the renderer adapter; opt-in): `instrumentA2uiWebCore(webCore)`. False if it is not that module. */
export function instrumentA2uiWebCore(module: unknown): boolean {
  return a2uiWebCoreInstrumentor().instrumentModule(module);
}

/** Called by `instrument()` on the browser and React Native entries. */
export function startA2uiInstrumentors(config: OTelConfig): void {
  void a2aClientInstrumentor().instrument(config);
  void a2uiAgentInstrumentor().instrument(config);
  void a2uiWebCoreInstrumentor().instrument(config);
}

export function stopA2uiInstrumentors(): void {
  a2aClientInstrumentor().uninstrument();
  a2uiAgentInstrumentor().uninstrument();
  a2uiWebCoreInstrumentor().uninstrument();
}
