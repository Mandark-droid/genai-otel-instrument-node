/**
 * On-device inference: instrumentors for libraries the application hands
 * over, because a browser and React Native cannot look a package up by name.
 *
 *   import * as transformers from '@huggingface/transformers';
 *   instrumentTransformers(transformers);
 *
 *   import { CactusLM, CactusSTT } from 'cactus-react-native';
 *   instrumentCactus({ CactusLM, CactusSTT });
 *
 * Either may be called before or after `instrument()`; spans appear once both
 * have happened. After `uninstrument()` the libraries are restored, and a later
 * `instrument()` needs them handed over again.
 */
import type { OTelConfig } from './config';
import { CactusInstrumentor } from './instrumentors/cactus';
import { TransformersInstrumentor } from './instrumentors/transformers';
import { stateSlot } from './state';

export function transformersInstrumentor(): TransformersInstrumentor {
  return stateSlot('onDevice.transformers', () => new TransformersInstrumentor());
}

export function cactusInstrumentor(): CactusInstrumentor {
  return stateSlot('onDevice.cactus', () => new CactusInstrumentor());
}

/** Trace transformers.js: model loads, `generate()` and pipeline calls. False if `module` is not the library. */
export function instrumentTransformers(module: unknown): boolean {
  return transformersInstrumentor().instrumentModule(module);
}

/** Trace cactus-react-native: `{ CactusLM, CactusSTT }`. False if neither class was given. */
export function instrumentCactus(classes: unknown): boolean {
  return cactusInstrumentor().instrumentModule(classes);
}

/** Called by `instrument()` on the browser and React Native entries. */
export function startOnDeviceInstrumentors(config: OTelConfig): void {
  void transformersInstrumentor().instrument(config);
  void cactusInstrumentor().instrument(config);
}

export function stopOnDeviceInstrumentors(): void {
  transformersInstrumentor().uninstrument();
  cactusInstrumentor().uninstrument();
}
