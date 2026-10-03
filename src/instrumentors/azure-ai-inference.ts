/**
 * Azure AI Inference (`@azure-rest/ai-inference`). The reference instruments
 * the Python `EmbeddingsClient.embed` (`azure.ai.inference.embeddings`); chat
 * is added here (`azure.ai.inference.chat`, SDK_ADDITIONS.md sections 6 and 7).
 *
 * The JavaScript client is a REST client: `ModelClient(endpoint, credential)
 * .path('/chat/completions').post({ body })`, built per call, with no class to
 * patch. Every request goes through an Azure pipeline from
 * `@azure/core-rest-pipeline`, so that is where it is observed: `sendRequest`
 * on the pipeline class, for requests to `/chat/completions` and `/embeddings`
 * only. Every other Azure SDK request on the same class passes through
 * untouched. The response is read from the text the pipeline already holds;
 * the application gets the same response object.
 *
 * A streamed request (`stream: true`) gets its span, and no tokens: the stream
 * belongs to the application and is not read here.
 */
import { completionText } from './content';
import type { Params, UsageDict } from './base';
import { isObject, OpenAIShapeInstrumentor, type Obj } from './openai-shape';
import { exportedClass } from './patch';
import type { PatchTarget } from './patching';
import { ATTR } from '../semconv';

type Kind = 'chat' | 'embeddings';

interface PipelineRequest {
  url?: unknown;
  body?: unknown;
}

function requestOf(args: unknown[]): PipelineRequest | undefined {
  const request = args[1];
  return isObject(request) ? (request as PipelineRequest) : undefined;
}

function kindOf(args: unknown[]): Kind | undefined {
  const url = requestOf(args)?.url;
  if (typeof url !== 'string') return undefined;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  if (path.endsWith('/chat/completions')) return 'chat';
  if (path.endsWith('/embeddings')) return 'embeddings';
  return undefined;
}

function bodyOf(args: unknown[]): Obj {
  const body = requestOf(args)?.body;
  if (typeof body !== 'string') return isObject(body) ? body : {};
  try {
    const parsed: unknown = JSON.parse(body);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The JSON the pipeline already read into `bodyAsText`. Undefined for a stream, or a body that is not JSON. */
function responseJson(result: unknown): Obj | undefined {
  if (!isObject(result) || typeof result.bodyAsText !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(result.bodyAsText);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const SYSTEM = 'azure_ai_inference';

export class AzureAIInferenceInstrumentor extends OpenAIShapeInstrumentor {
  protected readonly label = 'Azure AI Inference';
  protected readonly packages = ['@azure/core-rest-pipeline'];
  protected override get owner(): string {
    return 'azure.ai.inference';
  }

  protected targets(module: unknown): PatchTarget[] {
    const create = (module as { createEmptyPipeline?: unknown } | null)?.createEmptyPipeline ?? exportedClass(module, 'createEmptyPipeline');
    if (typeof create !== 'function') return [];
    let prototype: object | undefined;
    try {
      prototype = Object.getPrototypeOf((create as () => object)()) as object;
    } catch {
      return [];
    }
    return [
      {
        holder: prototype,
        method: 'sendRequest',
        attributes: (_instance, args, params) => this.requestAttributes(kindOf(args) ?? 'chat', params, args),
        options: {
          params: (args) => bodyOf(args),
          spanName: (_params, args) => `azure.ai.inference.${kindOf(args) ?? 'chat'}`,
        },
      },
    ];
  }

  /** Only inference requests are ours. */
  protected override shouldBypass(_instance: unknown, args: unknown[]): boolean {
    return kindOf(args) === undefined;
  }

  private requestAttributes(kind: Kind, params: Params, args: unknown[]): Obj {
    const attributes: Obj =
      kind === 'chat'
        ? this.chatRequestAttributes(params, { system: SYSTEM })
        : {
            [ATTR.GEN_AI_SYSTEM]: SYSTEM,
            [ATTR.GEN_AI_REQUEST_MODEL]: params.model ?? 'unknown',
            [ATTR.GEN_AI_OPERATION_NAME]: 'embeddings',
            [ATTR.GEN_AI_REQUEST_TYPE]: 'embedding',
            'gen_ai.request.input_count': typeof params.input === 'string' ? 1 : Array.isArray(params.input) ? params.input.length : 0,
          };
    try {
      const url = new URL(String(requestOf(args)?.url));
      attributes['server.address'] = url.hostname;
      attributes['server.port'] = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    } catch {
      // no endpoint to record
    }
    return attributes;
  }

  protected override resultFailure(result: unknown): string | undefined {
    const status = isObject(result) ? Number(result.status) : NaN;
    return status >= 400 ? `HTTP ${status}` : undefined;
  }

  protected extractUsage(result: unknown): UsageDict | null {
    const json = responseJson(result);
    const usage = json?.usage;
    if (!isObject(usage)) return null;
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
    const completion = Number(usage.completion_tokens ?? 0);
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: Number(usage.total_tokens ?? prompt + completion) };
  }

  protected override extractResponseAttributes(result: unknown): Obj {
    const json = responseJson(result);
    if (!json) return {};
    if (Array.isArray(json.data)) {
      const first: unknown = json.data[0];
      const vector = isObject(first) && Array.isArray(first.embedding) ? first.embedding : undefined;
      return {
        'gen_ai.response.embedding_count': json.data.length,
        ...(vector ? { [ATTR.GEN_AI_RESPONSE_VECTOR_SIZE]: vector.length } : {}),
        ...(typeof json.model === 'string' ? { [ATTR.GEN_AI_RESPONSE_MODEL]: json.model } : {}),
      };
    }
    return this.chatResponseAttributes(json, { id: true, model: true, finishReasons: true, toolCalls: true });
  }

  protected override extractFinishReason(result: unknown): string | null {
    const json = responseJson(result);
    return json ? this.firstFinishReason(json) : null;
  }

  protected override completionTextForContent(result: unknown): string | undefined {
    const json = responseJson(result);
    return json && !Array.isArray(json.data) ? completionText(json) : undefined;
  }

  protected override responseTextForEvaluation(result: unknown): string | undefined {
    return this.completionTextForContent(result);
  }
}
