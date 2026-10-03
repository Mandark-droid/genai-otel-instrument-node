/**
 * Providers reached through the `openai` client (and, for CometAPI, the
 * `@anthropic-ai/sdk` client) at a base URL of their own.
 *
 * Ports of `openrouter_instrumentor.py`, `cometapi_instrumentor.py`,
 * `hyperbolic_instrumentor.py`, `sambanova_instrumentor.py` and
 * `anyscale_instrumentor.py`. Each claims its domain, so the generic OpenAI /
 * Anthropic instrumentor stands aside and a call is traced exactly once, under
 * the provider's own span name and `gen_ai.system`.
 *
 * The reference patches the client constructor and wraps methods on each
 * instance; here the same prototypes the OpenAI instrumentor patches are
 * wrapped a second time, and the wrapper acts only for a client whose base URL
 * is the provider's. The effect is the same and it also covers clients created
 * before `instrument()` ran.
 */
import type { Span } from '@opentelemetry/api';
import type { OTelConfig } from '../config';
import { logger } from '../logger';
import { pyStr } from '../pycompat';
import { clientBaseUrl, hostMatches, registerBaseUrlClaim, type Params, type UsageDict } from './base';
import {
  BASIC_PARAMS,
  basicUsage,
  getattr,
  isObject,
  OpenAIShapeInstrumentor,
  PENALTY_PARAMS,
  reasoningUsage,
  type Obj,
  type ResponseAttributeOptions,
} from './openai-shape';
import { exportedClass } from './patch';
import type { PatchTarget } from './patching';
import type { Instrumentor } from './registry';

interface OpenAIClientClass {
  Chat?: { Completions?: { prototype?: object } };
  Embeddings?: { prototype?: object };
}

abstract class ClaimingInstrumentor extends OpenAIShapeInstrumentor {
  /** Substring of the base URL that identifies the provider. */
  protected abstract readonly claimDomain: string;
  protected abstract readonly system: string;
  protected readonly packages: readonly string[] = ['openai'];
  /** Embeddings through the vendor get `<vendor>.embeddings` (SDK_ADDITIONS.md section 7). */
  protected readonly embeddings: boolean = true;
  protected abstract readonly response: ResponseAttributeOptions;

  protected override get owner(): string {
    return this.system;
  }

  protected abstract chatAttributes(params: Params): Obj;

  protected targets(module: unknown, packageName: string): PatchTarget[] {
    if (packageName !== 'openai') return [];
    const client = exportedClass(module, 'OpenAI') as OpenAIClientClass | undefined;
    if (!client) return [];
    const targets: PatchTarget[] = [
      {
        holder: client.Chat?.Completions?.prototype,
        method: 'create',
        spanName: `${this.system}.chat.completion`,
        attributes: (_instance, _args, params) => this.chatAttributes(params),
      },
    ];
    if (this.embeddings) {
      targets.push({
        holder: client.Embeddings?.prototype,
        method: 'create',
        spanName: `${this.system}.embeddings`,
        attributes: (_instance, _args, params) => this.embeddingRequestAttributes(params, this.system),
      });
    }
    return targets;
  }

  protected override onEnabled(): void {
    registerBaseUrlClaim(this.claimDomain, this.system);
  }

  /** Only clients pointed at the provider are ours. */
  protected override shouldBypass(instance: unknown): boolean {
    return !hostMatches(clientBaseUrl(instance), this.claimDomain);
  }

  protected override extractResponseAttributes(result: unknown): Obj {
    return this.chatResponseAttributes(result, this.response);
  }

  protected override extractFinishReason(result: unknown): string | null {
    return this.firstFinishReason(result, this.response.stopReason);
  }
}

export class OpenRouterInstrumentor extends ClaimingInstrumentor {
  protected readonly label = 'OpenRouter';
  protected readonly claimDomain = 'openrouter.ai';
  protected readonly system = 'openrouter';
  protected readonly response = { id: true, model: true, finishReasons: true, toolCalls: true, embeddings: true };

  protected chatAttributes(params: Params): Obj {
    const attributes = this.chatRequestAttributes(params, {
      system: this.system,
      params: [...BASIC_PARAMS, ...PENALTY_PARAMS],
      tools: true,
    });
    if ('provider' in params) attributes['openrouter.provider'] = pyStr(params.provider);
    if ('route' in params) attributes['openrouter.route'] = pyStr(params.route);
    return attributes;
  }

  protected extractUsage(result: unknown): UsageDict | null {
    return reasoningUsage(result);
  }

  protected override addContentEvents(span: Span, result: unknown, params: Params): void {
    this.chatContentEvents(span, result, params);
  }
}

export class CometAPIInstrumentor extends ClaimingInstrumentor {
  protected readonly label = 'CometAPI';
  protected readonly claimDomain = 'cometapi.com';
  protected readonly system = 'cometapi';
  protected override readonly packages = ['openai', '@anthropic-ai/sdk'];
  protected readonly response = { id: true, model: true, finishReasons: true, embeddings: true, stopReason: true };

  protected chatAttributes(params: Params): Obj {
    return this.chatRequestAttributes(params, { system: this.system, tools: true });
  }

  protected override targets(module: unknown, packageName: string): PatchTarget[] {
    if (packageName !== '@anthropic-ai/sdk') return super.targets(module, packageName);
    const client = exportedClass(module, 'Anthropic') as { Messages?: { prototype?: object } } | undefined;
    return [
      {
        holder: client?.Messages?.prototype,
        method: 'create',
        spanName: 'cometapi.messages.create',
        attributes: (_instance, _args, params) => this.chatAttributes(params),
      },
    ];
  }

  /** Both dialects: OpenAI's `prompt_tokens` and Anthropic's `input_tokens`. */
  protected extractUsage(result: unknown): UsageDict | null {
    if (!isObject(result) || !isObject(result.usage)) return null;
    const usage = result.usage;
    if ('prompt_tokens' in usage || 'completion_tokens' in usage) {
      const mapped: UsageDict = {
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
      };
      if (isObject(usage.completion_tokens_details)) {
        mapped.completion_tokens_details = { reasoning_tokens: getattr(usage.completion_tokens_details, 'reasoning_tokens', 0) };
      }
      return mapped;
    }
    if ('input_tokens' in usage || 'output_tokens' in usage) {
      const input = (usage.input_tokens as number | null | undefined) || 0;
      const output = (usage.output_tokens as number | null | undefined) || 0;
      const mapped: UsageDict = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
      if ('cache_read_input_tokens' in usage) mapped.cache_read_input_tokens = usage.cache_read_input_tokens || 0;
      if ('cache_creation_input_tokens' in usage) mapped.cache_creation_input_tokens = usage.cache_creation_input_tokens || 0;
      return mapped;
    }
    return null;
  }

  protected override addContentEvents(span: Span, result: unknown, params: Params): void {
    this.chatContentEvents(span, result, params);
  }
}

/**
 * Hyperbolic. The reference traces raw `requests.post` calls to
 * `api.hyperbolic.xyz`; JavaScript applications reach it through the OpenAI
 * client, so that is where it is traced. Same span name and attributes.
 */
export class HyperbolicInstrumentor extends ClaimingInstrumentor {
  protected readonly label = 'Hyperbolic';
  protected readonly claimDomain = 'api.hyperbolic.xyz';
  protected readonly system = 'hyperbolic';
  protected readonly response = { id: true, model: true, finishReasons: true };

  protected chatAttributes(params: Params): Obj {
    return this.chatRequestAttributes(params, { system: this.system });
  }

  protected extractUsage(result: unknown): UsageDict | null {
    return basicUsage(result);
  }
}

/** SambaNova. The reference patches the `sambanova` Python SDK; here it is the OpenAI client at `api.sambanova.ai`. */
export class SambaNovaInstrumentor extends ClaimingInstrumentor {
  protected readonly label = 'SambaNova';
  protected readonly claimDomain = 'api.sambanova.ai';
  protected readonly system = 'sambanova';
  // The reference records the response text on every span, content capture or not.
  protected readonly response = { id: true, model: true, finishReasons: true, responseText: true };

  protected chatAttributes(params: Params): Obj {
    return this.chatRequestAttributes(params, { system: this.system, tools: true });
  }

  protected extractUsage(result: unknown): UsageDict | null {
    return basicUsage(result);
  }
}

/**
 * Anyscale: a no-op in the reference too. Its endpoints are OpenAI-compatible
 * and are traced by the OpenAI instrumentor.
 */
export class AnyscaleInstrumentor implements Instrumentor {
  instrument(_config: OTelConfig): void {
    logger.debug('Anyscale uses the OpenAI client; traced by the OpenAI instrumentor');
  }

  uninstrument(): void {}
}
