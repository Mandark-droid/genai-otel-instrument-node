/**
 * The instrumentors this SDK ships, registered under the names the Python
 * library uses in `GENAI_ENABLED_INSTRUMENTORS`.
 */
import { AnthropicInstrumentor } from './anthropic';
import { BedrockInstrumentor } from './bedrock';
import { CohereInstrumentor } from './cohere';
import { ElevenLabsInstrumentor } from './elevenlabs';
import { GoogleGenAIInstrumentor, VertexAIInstrumentor } from './google';
import { GroqInstrumentor } from './groq';
import { huggingFaceInferenceInstrumentor } from './huggingface';
import { BedrockAgentsInstrumentor, GoogleADKInstrumentor, OpenAIAgentsInstrumentor } from '../frameworks/agents';
import { LangChainInstrumentor, LangGraphInstrumentor, LlamaIndexInstrumentor } from '../frameworks/langchain';
import { a2aClientInstrumentor } from '../a2a/client-instrumentor';
import { a2uiAgentInstrumentor } from '../a2ui/agent-instrumentor';
import { a2uiWebCoreInstrumentor } from '../a2ui/web-core-instrumentor';
import { mcpInstrumentor } from '../mcp/client-instrumentor';
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
import { AzureAIInferenceInstrumentor } from './azure-ai-inference';
import { loadModuleCopies } from './patch';
import { setModuleLoader } from './patching';
import { registerInstrumentor, type Instrumentor } from './registry';
import { ReplicateInstrumentor } from './replicate';
import { SarvamInstrumentor } from './sarvam';
import { TogetherInstrumentor } from './together';
import { TransformersInstrumentor } from './transformers';

// Node can find a client library by name; the instrumentors ask through this.
setModuleLoader(loadModuleCopies);

registerInstrumentor('openai', () => new OpenAIInstrumentor());
registerInstrumentor('anthropic', () => new AnthropicInstrumentor());
registerInstrumentor('openrouter', () => new OpenRouterInstrumentor());
registerInstrumentor('cometapi', () => new CometAPIInstrumentor());
registerInstrumentor('hyperbolic', () => new HyperbolicInstrumentor());
registerInstrumentor('sambanova', () => new SambaNovaInstrumentor());
registerInstrumentor('anyscale', () => new AnyscaleInstrumentor());
registerInstrumentor('groq', () => new GroqInstrumentor());
registerInstrumentor('azure.ai.inference', () => new AzureAIInferenceInstrumentor());
registerInstrumentor('together', () => new TogetherInstrumentor());
registerInstrumentor('mistralai', () => new MistralInstrumentor());
registerInstrumentor('cohere', () => new CohereInstrumentor());
registerInstrumentor('ollama', () => new OllamaInstrumentor());
registerInstrumentor('google.generativeai', () => new GoogleGenAIInstrumentor());
registerInstrumentor('vertexai', () => new VertexAIInstrumentor());
registerInstrumentor('langchain', () => new LangChainInstrumentor());
registerInstrumentor('langgraph', () => new LangGraphInstrumentor());
registerInstrumentor('llama_index', () => new LlamaIndexInstrumentor());
registerInstrumentor('openai_agents', () => new OpenAIAgentsInstrumentor());
registerInstrumentor('google_adk', () => new GoogleADKInstrumentor());
registerInstrumentor('bedrock_agents', () => new BedrockAgentsInstrumentor());
// A2A client (`@a2a-js/sdk`) and the A2UI agent SDK (`@a2ui/agent`): in the default list, as in
// Python 1.48.0; each does nothing unless its package is installed. `a2ui_web_core` is opt-in and
// has no Python counterpart (the renderer adapter, decision A2UI-D7).
registerInstrumentor('a2a', () => a2aClientInstrumentor());
registerInstrumentor('a2ui', () => a2uiAgentInstrumentor());
registerInstrumentor('a2ui_web_core', () => a2uiWebCoreInstrumentor());
// Opt-in, as in the reference: named in GENAI_ENABLED_INSTRUMENTORS.
registerInstrumentor('mcp_client', () => mcpInstrumentor());
registerInstrumentor('mcp', () => mcpInstrumentor());
registerInstrumentor('replicate', () => new ReplicateInstrumentor());
registerInstrumentor('elevenlabs', () => new ElevenLabsInstrumentor());
registerInstrumentor('sarvamai', () => new SarvamInstrumentor());
// The reference name covers both halves of its HuggingFace instrumentor: the
// inference client (traced by wrapping) and local models (transformers.js).
registerInstrumentor('transformers', (): Instrumentor => {
  const parts: Instrumentor[] = [huggingFaceInferenceInstrumentor(), new TransformersInstrumentor()];
  return {
    instrument: (config) => Promise.all(parts.map((part) => part.instrument(config))).then(() => undefined),
    uninstrument: () => parts.forEach((part) => part.uninstrument()),
  };
});
// The reference name: its Bedrock instrumentor patches boto3.
registerInstrumentor('boto3', () => new BedrockInstrumentor());

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
export { BedrockInstrumentor } from './bedrock';
export { CohereInstrumentor } from './cohere';
export { GoogleGenAIInstrumentor, VertexAIInstrumentor } from './google';
export { ElevenLabsInstrumentor } from './elevenlabs';
export { GroqInstrumentor } from './groq';
export { traceHuggingFaceClient } from './huggingface';
export { ReplicateInstrumentor } from './replicate';
export { SarvamInstrumentor } from './sarvam';
export { MistralInstrumentor } from './mistral';
export { OllamaInstrumentor } from './ollama';
export { OpenAIInstrumentor } from './openai';
export { TogetherInstrumentor } from './together';
export { TransformersInstrumentor } from './transformers';
export {
  AnyscaleInstrumentor,
  CometAPIInstrumentor,
  HyperbolicInstrumentor,
  OpenRouterInstrumentor,
  SambaNovaInstrumentor,
} from './openai-compatible';
export { PatchingInstrumentor, type PatchTarget } from './patching';
export { availableInstrumentors, registerInstrumentor, type Instrumentor } from './registry';
