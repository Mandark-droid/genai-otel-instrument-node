/**
 * Tool-metadata registry loaded from MCP tool schema maps. A port of
 * `genai_otel/mcp_semconv/tool_registry.py`.
 *
 * Stage, behaviour, idempotency and capabilities are looked up from a schema
 * map, never hardcoded, so another tool surface only needs other JSON.
 *
 * When several servers are reached through one composite proxy, tool names
 * arrive prefixed (`food_search_restaurants`). `resolve()` strips the prefix
 * into the server and keeps the raw name; if the prefix stayed on, every
 * comparison against the real tool name would fail and tool-selection accuracy
 * would silently read 0%. Prefixes are recognised from the known server and
 * tool names, never by splitting on the first separator -
 * `search_restaurants_dineout` is a real, unprefixed name.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger';
import { BEHAVIOUR_MUTATING, BEHAVIOUR_READ_ONLY } from './attributes';

export const DEFAULT_PREFIX_SEPARATORS: readonly string[] = ['_', '-', '.', '/', ':'];
/** A mutating tool in one of these stages places an order, unless the schema says otherwise. */
export const DEFAULT_PLACEMENT_STAGES: ReadonlySet<string> = new Set(['Order']);

/**
 * Capability -> name patterns, used when a schema map declares no
 * capabilities. Deliberately strict: `report_error` files a report, it does
 * not cancel or refund, so it maps to nothing here.
 */
export const DEFAULT_CAPABILITY_PATTERNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  cancel_order: ['cancel.*order', 'order.*cancel', '^cancel$'],
  refund: ['refund'],
  replacement: ['replace', 'replacement'],
  missing_item_claim: ['missing.*item', 'item.*missing', 'claim'],
  modify_placed_order: ['modify.*order', 'amend.*order', 'edit.*order', 'update.*order'],
  reschedule_booking: ['reschedule', 'change.*slot', 'modify.*booking'],
  cancel_booking: ['cancel.*booking', 'booking.*cancel', 'cancel.*table'],
  escalate_to_human: ['escalate', 'human.*agent', 'agent.*handoff', 'live.*chat'],
  address_edit_mid_cart: ['(update|edit|change|modify).*address'],
  order_history_lookup: ['get.*orders?$', 'order.*history', 'list.*orders?'],
});

export const KNOWN_CAPABILITIES: readonly string[] = Object.freeze(Object.keys(DEFAULT_CAPABILITY_PATTERNS));

export interface ToolMetadata {
  name: string;
  server: string;
  stage?: string;
  behaviour?: string;
  idempotent?: boolean;
  placement: boolean;
  capabilities: ReadonlySet<string>;
  endpoint?: string;
}

/** The outcome of resolving a wire name. `tool` is what to compare with ground truth; `rawName` is what arrived. */
export interface ToolResolution {
  rawName: string;
  tool: string;
  server?: string;
  stage?: string;
  behaviour?: string;
  idempotent?: boolean;
  placement: boolean;
  capabilities: ReadonlySet<string>;
  prefixStripped: boolean;
  ambiguous: boolean;
  known: boolean;
}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const EMPTY: ReadonlySet<string> = new Set();

/** `**MCP Server**` -> `mcp server`. */
function normaliseDetailKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function coerceBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(lowered)) return true;
    if (['false', 'no', '0'].includes(lowered)) return false;
  }
  return undefined;
}

export function unresolved(rawName: string, tool: string = rawName, server?: string): ToolResolution {
  return { rawName, tool, server, placement: false, capabilities: EMPTY, prefixStripped: false, ambiguous: false, known: false };
}

export interface RegistryOptions {
  prefixSeparators?: readonly string[];
  capabilityPatterns?: Readonly<Record<string, readonly string[]>>;
}

export class MCPToolRegistry {
  private readonly byServer = new Map<string, Map<string, ToolMetadata>>();
  private readonly byTool = new Map<string, ToolMetadata[]>();
  private readonly prefixSeparators: readonly string[];
  private readonly capabilityPatterns: Readonly<Record<string, readonly string[]>>;
  private readonly capabilityCache = new Map<string, readonly ToolMetadata[]>();

  constructor(tools: Iterable<ToolMetadata>, options: RegistryOptions = {}) {
    this.prefixSeparators = options.prefixSeparators ?? DEFAULT_PREFIX_SEPARATORS;
    this.capabilityPatterns = options.capabilityPatterns ?? DEFAULT_CAPABILITY_PATTERNS;
    for (const meta of tools) {
      if (!this.byServer.has(meta.server)) this.byServer.set(meta.server, new Map());
      (this.byServer.get(meta.server) as Map<string, ToolMetadata>).set(meta.name, meta);
      this.byTool.set(meta.name, [...(this.byTool.get(meta.name) ?? []), meta]);
    }
  }

  static fromDicts(documents: Iterable<unknown>, options?: RegistryOptions): MCPToolRegistry {
    const tools: ToolMetadata[] = [];
    for (const document of documents) tools.push(...MCPToolRegistry.parseDocument(document));
    return new MCPToolRegistry(tools, options);
  }

  static fromFiles(paths: Iterable<string>, options?: RegistryOptions): MCPToolRegistry {
    const documents: unknown[] = [];
    for (const path of paths) {
      try {
        documents.push(JSON.parse(readFileSync(path, 'utf8')));
      } catch (error) {
        logger.warn(`Failed to load MCP tool schema ${path}: ${String(error)}`);
      }
    }
    return MCPToolRegistry.fromDicts(documents, options);
  }

  static fromDirectory(directory: string, options?: RegistryOptions): MCPToolRegistry {
    let names: string[];
    try {
      names = readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .sort();
    } catch (error) {
      logger.warn(`Failed to list MCP tool schema directory ${directory}: ${String(error)}`);
      return new MCPToolRegistry([], options);
    }
    return MCPToolRegistry.fromFiles(
      names.map((name) => join(directory, name)),
      options,
    );
  }

  private static parseDocument(document: unknown): ToolMetadata[] {
    if (!isObject(document)) return [];
    const defaultServer = String(document.server || '').trim();
    const entries: ToolMetadata[] = [];
    for (const rawTool of Array.isArray(document.tools) ? (document.tools as unknown[]) : []) {
      if (!isObject(rawTool)) continue;
      const name = String(rawTool.name || '').trim();
      if (!name) continue;
      const details: Obj = {};
      if (isObject(rawTool.details)) for (const [key, value] of Object.entries(rawTool.details)) details[normaliseDetailKey(key)] = value;

      const server = String(rawTool.server || defaultServer || '').trim();
      const stageValue = rawTool.stage || details.stage;
      const behaviourValue = rawTool.behaviour || rawTool.behavior || details.behaviour;
      const endpointValue = rawTool.endpoint || details.endpoint;
      const stage = stageValue ? String(stageValue).trim() : undefined;
      const behaviour = behaviourValue ? String(behaviourValue).trim().toLowerCase() : undefined;

      // Derived unless the schema states it, and conservatively: a read-only
      // call is safe to repeat, a mutating one is assumed not to be.
      let idempotent = coerceBool(rawTool.idempotent) ?? coerceBool(details.idempotent);
      if (idempotent === undefined && behaviour) idempotent = behaviour === BEHAVIOUR_READ_ONLY;

      const declaredPlacement = coerceBool(rawTool.placement);
      const placement = declaredPlacement ?? Boolean(stage && DEFAULT_PLACEMENT_STAGES.has(stage) && behaviour === BEHAVIOUR_MUTATING);
      const capabilities = new Set(
        (Array.isArray(rawTool.capabilities) ? (rawTool.capabilities as unknown[]) : []).map((value) => String(value).trim()).filter(Boolean),
      );
      entries.push({ name, server, stage, behaviour, idempotent, placement, capabilities, endpoint: endpointValue ? String(endpointValue).trim() : undefined });
    }
    return entries;
  }

  get servers(): string[] {
    return [...this.byServer.keys()].sort();
  }

  /** Total number of tools in the registration surface. */
  get candidateCount(): number {
    let count = 0;
    for (const tools of this.byServer.values()) count += tools.size;
    return count;
  }

  get(tool: string, server?: string): ToolMetadata | undefined {
    if (server !== undefined) return this.byServer.get(server)?.get(tool);
    const matches = this.byTool.get(tool) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Mark named tools as order-placement tools, for surfaces whose placement tool is not stage `Order`. */
  markPlacement(toolNames: Iterable<string>): void {
    const wanted = new Set(toolNames);
    for (const tools of this.byServer.values()) {
      for (const [name, meta] of tools) {
        if (!wanted.has(name) || meta.placement) continue;
        const updated: ToolMetadata = { ...meta, placement: true };
        tools.set(name, updated);
        this.byTool.set(
          name,
          (this.byTool.get(name) ?? []).map((entry) => (entry === meta ? updated : entry)),
        );
      }
    }
  }

  /** Never undefined: an unknown tool resolves to itself with `known: false`, so the span still carries the raw name. */
  resolve(rawNameInput: unknown, serverHint?: string): ToolResolution {
    const rawName = String(rawNameInput || '').trim();
    if (!rawName) return unresolved('', '');

    // An explicit server plus a matching tool is the strongest signal.
    const hinted = serverHint ? this.byServer.get(serverHint)?.get(rawName) : undefined;
    if (hinted) return MCPToolRegistry.resolution(rawName, hinted, false);

    const exact = this.byTool.get(rawName) ?? [];
    if (exact.length === 1) return MCPToolRegistry.resolution(rawName, exact[0] as ToolMetadata, false);
    // The same tool name on several servers.
    if (exact.length > 1) return MCPToolRegistry.ambiguousResolution(rawName, rawName, exact, false);

    // No exact match: try a known server prefix, longest server name first.
    const servers = [...this.byServer.keys()].sort().sort((a, b) => b.length - a.length);
    for (const server of servers) {
      for (const separator of this.prefixSeparators) {
        const marker = server + separator;
        if (!rawName.startsWith(marker)) continue;
        const remainder = rawName.slice(marker.length);
        if (!remainder) continue;
        const meta = this.byServer.get(server)?.get(remainder);
        if (meta) return MCPToolRegistry.resolution(rawName, meta, true);
        // A known server but an unknown tool: still strip, the server attribution is real.
        return { ...unresolved(rawName, remainder, server), prefixStripped: true };
      }
    }
    return unresolved(rawName, rawName, serverHint);
  }

  private static resolution(rawName: string, meta: ToolMetadata, prefixStripped: boolean): ToolResolution {
    return {
      rawName,
      tool: meta.name,
      server: meta.server || undefined,
      stage: meta.stage,
      behaviour: meta.behaviour,
      idempotent: meta.idempotent,
      placement: meta.placement,
      capabilities: meta.capabilities,
      prefixStripped,
      ambiguous: false,
      known: true,
    };
  }

  /** The server stays unset; a field on which every candidate agrees is still reported. */
  private static ambiguousResolution(rawName: string, tool: string, candidates: ToolMetadata[], prefixStripped: boolean): ToolResolution {
    const agreed = <K extends 'stage' | 'behaviour' | 'idempotent' | 'placement'>(key: K): ToolMetadata[K] | undefined => {
      const values = new Set(candidates.map((candidate) => candidate[key]));
      return values.size === 1 ? (candidates[0] as ToolMetadata)[key] : undefined;
    };
    const [first, ...rest] = candidates;
    const shared = new Set([...(first?.capabilities ?? [])].filter((capability) => rest.every((candidate) => candidate.capabilities.has(capability))));
    return {
      rawName,
      tool,
      server: undefined,
      stage: agreed('stage'),
      behaviour: agreed('behaviour'),
      idempotent: agreed('idempotent'),
      placement: Boolean(agreed('placement')),
      capabilities: shared,
      prefixStripped,
      ambiguous: true,
      known: true,
    };
  }

  /** Every tool that satisfies a capability: declared by the schema, or matched by name. */
  toolsForCapability(capability: string): readonly ToolMetadata[] {
    const cached = this.capabilityCache.get(capability);
    if (cached) return cached;
    const patterns = (this.capabilityPatterns[capability] ?? []).map((pattern) => new RegExp(pattern, 'i'));
    const matches: ToolMetadata[] = [];
    for (const tools of this.byServer.values()) {
      for (const meta of tools.values()) {
        if (meta.capabilities.has(capability) || patterns.some((pattern) => pattern.test(meta.name))) matches.push(meta);
      }
    }
    this.capabilityCache.set(capability, matches);
    return matches;
  }

  /** What the surface can do, not what the agent happened to call. */
  hasCapability(capability: string): boolean {
    return this.toolsForCapability(capability).length > 0;
  }

  missingCapabilities(capabilities: Iterable<string> = KNOWN_CAPABILITIES): string[] {
    return [...capabilities].filter((capability) => !this.hasCapability(capability));
  }
}
