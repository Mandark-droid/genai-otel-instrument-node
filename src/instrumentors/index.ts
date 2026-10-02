/**
 * The instrumentors this SDK ships, registered under the names the Python
 * library uses in `GENAI_ENABLED_INSTRUMENTORS`.
 */
import { AnthropicInstrumentor } from './anthropic';
import { CohereInstrumentor } from './cohere';
import { GroqInstrumentor } from './groq';
import { MistralInstrumentor } from './mistral';
import { OllamaInstrumentor } from './ollama';
import { OpenAIInstrumentor } from './openai';
import {
  AnyscaleInstrumentor,
  CometAPIInstrumentor,
  HyperbolicInstrumentor,
  OpenRouterInstrumentor,
  SambaNovaInstrumentor,
} from './openai-compatible';
import { registerInstrumentor } from './registry';
import { TogetherInstrumentor } from './together';

registerInstrumentor('openai', () => new OpenAIInstrumentor());
registerInstrumentor('anthropic', () => new AnthropicInstrumentor());
registerInstrumentor('openrouter', () => new OpenRouterInstrumentor());
registerInstrumentor('cometapi', () => new CometAPIInstrumentor());
registerInstrumentor('hyperbolic', () => new HyperbolicInstrumentor());
registerInstrumentor('sambanova', () => new SambaNovaInstrumentor());
registerInstrumentor('anyscale', () => new AnyscaleInstrumentor());
registerInstrumentor('groq', () => new GroqInstrumentor());
registerInstrumentor('together', () => new TogetherInstrumentor());
registerInstrumentor('mistralai', () => new MistralInstrumentor());
registerInstrumentor('cohere', () => new CohereInstrumentor());
registerInstrumentor('ollama', () => new OllamaInstrumentor());

export {
  BaseInstrumentor,
  clearBaseUrlClaims,
  findBaseUrlClaim,
  registerBaseUrlClaim,
  StreamTiming,
  type AttributeExtractor,
  type Params,
  type UsageDict,
} from './base';
export { AnthropicInstrumentor } from './anthropic';
export { CohereInstrumentor } from './cohere';
export { GroqInstrumentor } from './groq';
export { MistralInstrumentor } from './mistral';
export { OllamaInstrumentor } from './ollama';
export { OpenAIInstrumentor } from './openai';
export { TogetherInstrumentor } from './together';
export {
  AnyscaleInstrumentor,
  CometAPIInstrumentor,
  HyperbolicInstrumentor,
  OpenRouterInstrumentor,
  SambaNovaInstrumentor,
} from './openai-compatible';
export { PatchingInstrumentor, type PatchTarget } from './patching';
export { availableInstrumentors, registerInstrumentor, type Instrumentor } from './registry';
