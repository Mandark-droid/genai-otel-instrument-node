/**
 * Instrumentor for `@aws-sdk/client-bedrock-runtime`. A port of
 * `genai_otel/instrumentors/aws_bedrock_instrumentor.py`: InvokeModel,
 * InvokeModelWithResponseStream, Converse and ConverseStream.
 *
 * In the JavaScript SDK every operation goes through `client.send(command)`,
 * so that one method is patched - on the Bedrock runtime client's own
 * prototype, not on the base class every AWS client shares - and the command
 * class decides what, if anything, is traced.
 */
import { pyJsonDumps } from '../pycompat';
import { ATTR } from '../semconv';
import type { Params, UsageDict } from './base';
import { isObject, OpenAIShapeInstrumentor, type Obj } from './openai-shape';
import { exportedClass } from './patch';
import type { PatchTarget } from './patching';

const SPAN_NAMES: Readonly<Record<string, string>> = {
  InvokeModelCommand: 'aws.bedrock.invoke_model',
  InvokeModelWithResponseStreamCommand: 'aws.bedrock.invoke_model_with_response_stream',
  ConverseCommand: 'aws.bedrock.converse',
  ConverseStreamCommand: 'aws.bedrock.converse_stream',
};

function commandName(command: unknown): string {
  return isObject(command) && typeof command.constructor === 'function' ? command.constructor.name : '';
}

/** Converse content is a list of typed blocks; only the text blocks belong on a span. */
function converseBlocksText(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks.map((block: unknown) => (isObject(block) && typeof block.text === 'string' ? block.text : '')).join('');
}

/** A request or response body: a JSON string, UTF-8 bytes, or already an object. */
function parseBody(body: unknown): Obj | undefined {
  try {
    if (typeof body === 'string') return body ? (JSON.parse(body) as Obj) : undefined;
    if (body instanceof Uint8Array) return body.length > 0 ? (JSON.parse(new TextDecoder().decode(body)) as Obj) : undefined;
    if (isObject(body)) return body;
  } catch {
    // not JSON: nothing to read
  }
  return undefined;
}

function converseUsage(usage: unknown): UsageDict | null {
  if (!isObject(usage) || (!('inputTokens' in usage) && !('outputTokens' in usage))) return null;
  const input = Number(usage.inputTokens || 0);
  const output = Number(usage.outputTokens || 0);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: Number(usage.totalTokens ?? input + output) };
}

/**
 * Token counts in an InvokeModel body. Model families spell them differently;
 * the reference reads `usage.inputTokens` and Gemini-style `usageMetadata`,
 * and the others are read here too rather than reported as zero.
 */
function bodyUsage(body: Obj): UsageDict | null {
  const metrics = body['amazon-bedrock-invocationMetrics'];
  if (isObject(metrics) && ('inputTokenCount' in metrics || 'outputTokenCount' in metrics)) {
    const input = Number(metrics.inputTokenCount || 0);
    const output = Number(metrics.outputTokenCount || 0);
    return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  }
  if (isObject(body.usage)) {
    const usage = body.usage;
    const input = Number(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0);
    const output = Number(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? 0);
    return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  }
  if (isObject(body.usageMetadata)) {
    const usage = body.usageMetadata;
    const input = Number(usage.promptTokenCount ?? 0);
    const output = Number(usage.candidatesTokenCount ?? 0);
    return { prompt_tokens: input, completion_tokens: output, total_tokens: Number(usage.totalTokenCount ?? input + output) };
  }
  // Titan (text and embeddings) and Llama.
  if ('inputTextTokenCount' in body || 'prompt_token_count' in body) {
    const input = Number(body.inputTextTokenCount ?? body.prompt_token_count ?? 0);
    const results = Array.isArray(body.results) ? (body.results as unknown[]) : [];
    const first = results[0];
    const output = Number((isObject(first) ? first.tokenCount : undefined) ?? body.generation_token_count ?? 0);
    return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  }
  return null;
}

export class BedrockInstrumentor extends OpenAIShapeInstrumentor {
  protected readonly label = 'AWS Bedrock';
  protected readonly packages = ['@aws-sdk/client-bedrock-runtime'];

  protected targets(module: unknown): PatchTarget[] {
    const client: unknown = exportedClass(module, 'BedrockRuntimeClient');
    if (typeof client !== 'function') return [];
    return [
      {
        // `send` is inherited from the base class of every AWS client; wrapping
        // it here defines it on the Bedrock runtime client alone.
        holder: (client as { prototype: object }).prototype,
        method: 'send',
        attributes: (_instance, args, params) =>
          commandName(args[0]).startsWith('Converse') ? this.converseAttributes(params) : this.invokeAttributes(params),
        options: {
          params: (args) => (isObject(args[0]) && isObject(args[0].input) ? args[0].input : {}),
          spanName: (_params, args) => SPAN_NAMES[commandName(args[0])] ?? 'aws.bedrock.send',
          streaming: (_params, args) => commandName(args[0]).includes('Stream'),
          // Converse returns `{ stream }`, InvokeModelWithResponseStream `{ body }`.
          streamOf: (result) => (isObject(result) ? (result.stream ?? result.body) : undefined),
        },
      },
    ];
  }

  /** Only the four model-invoking commands are ours. */
  protected override shouldBypass(_instance: unknown, args: unknown[]): boolean {
    return !(commandName(args[0]) in SPAN_NAMES);
  }

  private invokeAttributes(params: Params): Obj {
    const modelId = params.modelId ?? 'unknown';
    const attributes: Obj = { [ATTR.GEN_AI_SYSTEM]: 'aws_bedrock', [ATTR.GEN_AI_REQUEST_MODEL]: modelId };
    const body = parseBody(params.body);
    if (!body) return attributes;

    const model = String(modelId).toLowerCase();
    const isEmbedding =
      model.includes('embed') ||
      'texts' in body ||
      'inputs' in body ||
      ('inputText' in body && !model.includes('titan-text') && !('textGenerationConfig' in body) && !('messages' in body));
    attributes[ATTR.GEN_AI_OPERATION_NAME] = isEmbedding ? 'embeddings' : 'chat';
    attributes[ATTR.GEN_AI_REQUEST_TYPE] = isEmbedding ? 'embedding' : 'chat';
    if (isEmbedding) {
      const values = body.texts ?? body.inputs ?? body.inputText;
      attributes[ATTR.GEN_AI_REQUEST_INPUT_COUNT] = Array.isArray(values) ? values.length : values !== undefined && values !== null ? 1 : 0;
    }

    let firstMessage: string | null = null;
    if (Array.isArray(body.messages) && body.messages.length > 0) firstMessage = this.buildFirstMessage(body.messages);
    else if ('prompt' in body) firstMessage = this.buildFirstMessage([{ role: 'user', content: String(body.prompt) }]);
    else if ('inputText' in body) firstMessage = this.buildFirstMessage([{ role: 'user', content: String(body.inputText) }]);
    if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
    return attributes;
  }

  private converseAttributes(params: Params): Obj {
    const messages = Array.isArray(params.messages) ? (params.messages as unknown[]) : [];
    const attributes: Obj = {
      [ATTR.GEN_AI_SYSTEM]: 'aws_bedrock',
      [ATTR.GEN_AI_REQUEST_MODEL]: params.modelId ?? 'unknown',
      [ATTR.GEN_AI_OPERATION_NAME]: 'chat',
      [ATTR.GEN_AI_REQUEST_MESSAGE_COUNT]: messages.length,
    };
    if (params.system) {
      const instructions = converseBlocksText(params.system);
      if (instructions) attributes[ATTR.GEN_AI_REQUEST_INSTRUCTIONS] = this.capContent(instructions);
    }
    const inference = params.inferenceConfig;
    if (isObject(inference)) {
      if ('maxTokens' in inference) attributes[ATTR.GEN_AI_REQUEST_MAX_TOKENS] = inference.maxTokens;
      if ('temperature' in inference) attributes[ATTR.GEN_AI_REQUEST_TEMPERATURE] = inference.temperature;
      if ('topP' in inference) attributes[ATTR.GEN_AI_REQUEST_TOP_P] = inference.topP;
      if ('stopSequences' in inference) attributes[ATTR.GEN_AI_REQUEST_STOP_SEQUENCES] = inference.stopSequences;
    }
    const toolConfig = params.toolConfig;
    if (isObject(toolConfig)) {
      try {
        attributes[ATTR.LLM_TOOLS] = pyJsonDumps(toolConfig.tools ?? toolConfig);
      } catch {
        // tool definitions that cannot be serialised are left off
      }
    }
    const normalised = messages
      .filter(isObject)
      .map((message) => ({ role: message.role ?? 'user', content: converseBlocksText(message.content ?? '') }));
    const firstMessage = this.buildFirstMessage(normalised);
    if (firstMessage) attributes[ATTR.GEN_AI_REQUEST_FIRST_MESSAGE] = firstMessage;
    return attributes;
  }

  /** Converse (`usage`), a ConverseStream metadata event, an InvokeModel body, or a streamed chunk. */
  protected extractUsage(result: unknown): UsageDict | null {
    if (!isObject(result)) return null;
    const converse = converseUsage(result.usage) ?? (isObject(result.metadata) ? converseUsage(result.metadata.usage) : null);
    if (converse) return converse;
    const body = parseBody(isObject(result.chunk) ? result.chunk.bytes : result.body);
    return body ? bodyUsage(body) : null;
  }

  protected override extractFinishReason(result: unknown): string | null {
    if (!isObject(result)) return null;
    if (typeof result.stopReason === 'string' && result.stopReason) return result.stopReason;
    const stop = result.messageStop;
    if (isObject(stop) && typeof stop.stopReason === 'string' && stop.stopReason) return stop.stopReason;
    return null;
  }

  protected override extractResponseAttributes(result: unknown): Obj {
    const attributes: Obj = {};
    if (!isObject(result)) return attributes;

    if (isObject(result.output)) {
      const message = isObject(result.output.message) ? result.output.message : {};
      const blocks = Array.isArray(message.content) ? (message.content as unknown[]) : [];
      const text = converseBlocksText(blocks);
      if (text) attributes[ATTR.GEN_AI_RESPONSE] = this.capContent(text);
      const finishReason = this.extractFinishReason(result);
      if (finishReason) attributes[ATTR.GEN_AI_RESPONSE_FINISH_REASONS] = [finishReason];
      let index = 0;
      for (const block of blocks) {
        if (!isObject(block) || !('toolUse' in block)) continue;
        const toolUse = isObject(block.toolUse) ? block.toolUse : {};
        const prefix = `llm.output_messages.0.message.tool_calls.${index}`;
        if (toolUse.toolUseId) attributes[`${prefix}.tool_call.id`] = toolUse.toolUseId;
        if (toolUse.name) attributes[`${prefix}.tool_call.function.name`] = toolUse.name;
        if ('input' in toolUse) {
          try {
            attributes[`${prefix}.tool_call.function.arguments`] = pyJsonDumps(toolUse.input);
          } catch {
            // arguments that cannot be serialised are left off
          }
        }
        index += 1;
      }
      return attributes;
    }

    const body = parseBody(result.body);
    if (!body) return attributes;
    let response: unknown;
    if ('content' in body) {
      const content = body.content;
      if (Array.isArray(content) && content.length > 0) {
        const first: unknown = content[0];
        response = isObject(first) && 'text' in first ? first.text : String(first);
      } else if (typeof content === 'string') response = content;
    } else if ('completion' in body) response = body.completion;
    else if ('generation' in body) response = body.generation;
    else if ('outputText' in body) response = body.outputText;
    else if (Array.isArray(body.results) && body.results.length > 0) {
      const first: unknown = body.results[0];
      if (isObject(first) && 'outputText' in first) response = first.outputText;
    }
    if (response !== undefined && response !== null) attributes[ATTR.GEN_AI_RESPONSE] = this.capContent(response);

    let vectors: unknown = body.embeddings;
    if ((vectors === undefined || vectors === null) && body.embedding !== undefined && body.embedding !== null) vectors = [body.embedding];
    if (Array.isArray(vectors)) {
      attributes[ATTR.GEN_AI_RESPONSE_EMBEDDING_COUNT] = vectors.length;
      if (Array.isArray(vectors[0])) attributes[ATTR.GEN_AI_RESPONSE_VECTOR_SIZE] = vectors[0].length;
    }
    return attributes;
  }
}
