/**
 * Per-session state for the MCP attributes that no single call can produce. A
 * port of `genai_otel/mcp_semconv/session_tracker.py`.
 *
 *  - `mcp.identifier.hallucinated` needs every identifier the session has
 *    actually seen in a response;
 *  - `commerce.cart_hash` needs cart contents reduced to a canonical form;
 *  - `commerce.order.placement_attempt` needs placements counted per cart hash.
 */
import { createHash } from 'node:crypto';
import { logger } from '../logger';

/**
 * Keys treated as identifiers. Id-shaped keys only: a coupon code can
 * legitimately be supplied by the user and appear in no prior response.
 */
export const DEFAULT_IDENTIFIER_KEY_PATTERN = '(?:^|[_.\\-])ids?$|(?:[a-z0-9])Ids?$|^ids?$';
export const DEFAULT_MAX_DEPTH = 8;
/** Bounds memory on sessions that page through large catalogues. */
export const DEFAULT_MAX_IDENTIFIERS = 20000;

type Obj = Record<string, unknown>;
const isMapping = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

const ITEM_LIST_KEYS = ['items', 'cartItems', 'cart_items', 'lineItems', 'line_items'];
const ITEM_ID_KEYS = ['itemId', 'item_id', 'id', 'productId', 'product_id', 'sku', 'name'];
const QUANTITY_KEYS = ['quantity', 'qty', 'count'];

/**
 * A cart reduced to a sorted list of `[identifier, quantity]` pairs, so the
 * same items in another order hash the same. Anything unrecognised passes
 * through.
 */
export function canonicaliseCart(cart: unknown): unknown {
  if (!isMapping(cart)) return cart;
  const key = ITEM_LIST_KEYS.find((candidate) => Array.isArray(cart[candidate]));
  if (!key) return cart;
  const reduced: [string, unknown][] = [];
  for (const item of cart[key] as unknown[]) {
    if (!isMapping(item)) {
      reduced.push([String(item), 1]);
      continue;
    }
    const idKey = ITEM_ID_KEYS.find((candidate) => item[candidate] !== undefined && item[candidate] !== null);
    const quantityKey = QUANTITY_KEYS.find((candidate) => item[candidate] !== undefined && item[candidate] !== null);
    reduced.push([idKey ? String(item[idKey]) : '', quantityKey ? item[quantityKey] : null]);
  }
  const order = (pair: [string, unknown]): string => `${pair[0]}\u0000${String(pair[1])}`;
  return reduced.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

/** JSON with sorted keys and no whitespace, non-ASCII escaped: the form the reference hashes. */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value).replace(/[\u0080-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isMapping(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return canonicalJson(String(value));
}

/** A stable hash of cart contents. Undefined for an empty cart, never an invented value. */
export function computeCartHash(cart: unknown, length = 16): string | undefined {
  if (cart === null || cart === undefined) return undefined;
  const canonical = canonicaliseCart(cart);
  if (canonical === '' || (Array.isArray(canonical) && canonical.length === 0) || (isMapping(canonical) && Object.keys(canonical).length === 0)) {
    return undefined;
  }
  return createHash('sha256').update(canonicalJson(canonical), 'utf8').digest('hex').slice(0, length);
}

export interface SessionStateOptions {
  seedIdentifiers?: Iterable<string>;
  identifierKeyPattern?: string;
  maxIdentifiers?: number;
}

export class MCPSessionState {
  cartHash: string | undefined;
  previousCartHash: string | undefined;

  private readonly identifierPattern: RegExp;
  private readonly maxIdentifiers: number;
  private readonly observed = new Set<string>();
  private readonly seeded = new Set<string>();
  private identifiersFull = false;
  private readonly placements = new Map<string, number>();

  constructor(
    readonly sessionId: string,
    options: SessionStateOptions = {},
  ) {
    this.identifierPattern = new RegExp(options.identifierKeyPattern || DEFAULT_IDENTIFIER_KEY_PATTERN);
    this.maxIdentifiers = options.maxIdentifiers ?? DEFAULT_MAX_IDENTIFIERS;
    this.seed(options.seedIdentifiers ?? []);
  }

  private isIdentifierKey(key: string): boolean {
    return this.identifierPattern.test(key);
  }

  /** `[key, value]` pairs for identifier-shaped keys, to a bounded depth. */
  private walk(payload: unknown, depth: number, out: [string, string][]): void {
    if (depth > DEFAULT_MAX_DEPTH) return;
    if (Array.isArray(payload)) {
      for (const item of payload) this.walk(item, depth + 1, out);
      return;
    }
    if (!isMapping(payload)) return;
    for (const [key, value] of Object.entries(payload)) {
      if (Array.isArray(value) && this.isIdentifierKey(key)) {
        // An id-shaped key holding scalars is a batch of identifiers.
        for (const item of value) {
          if (typeof item === 'object' && item !== null) this.walk(item, depth + 1, out);
          else if (item !== null && item !== undefined) out.push([key, String(item)]);
        }
      } else if (typeof value === 'object' && value !== null) {
        this.walk(value, depth + 1, out);
      } else if (value !== null && value !== undefined && this.isIdentifierKey(key)) {
        out.push([key, String(value)]);
      }
    }
  }

  /** Record every identifier in a tool response. Returns how many were new. */
  observeResponse(payload: unknown): number {
    const found: [string, string][] = [];
    this.walk(payload, 0, found);
    if (this.identifiersFull) return 0;
    const before = this.observed.size;
    for (const [, value] of found) this.observed.add(value);
    if (this.observed.size >= this.maxIdentifiers) {
      this.identifiersFull = true;
      logger.debug(`Session ${this.sessionId} hit the identifier retention cap (${this.maxIdentifiers}); hallucination detection disabled for the remainder`);
    }
    return this.observed.size - before;
  }

  /** Identifiers the user supplied: never flagged. */
  seed(identifiers: Iterable<string>): void {
    for (const identifier of identifiers) if (String(identifier)) this.seeded.add(String(identifier));
  }

  /**
   * Request identifiers never seen in a prior response. Keys only: the values
   * are neither returned nor recorded. After the retention cap is hit the
   * answer is "none" rather than a guess.
   */
  checkRequestIdentifiers(requestArguments: unknown): { hallucinated: boolean; keys: string[] } {
    const found: [string, string][] = [];
    this.walk(requestArguments, 0, found);
    if (found.length === 0 || this.identifiersFull) return { hallucinated: false, keys: [] };
    const keys = [...new Set(found.filter(([, value]) => !this.observed.has(value) && !this.seeded.has(value)).map(([key]) => key))].sort();
    return { hallucinated: keys.length > 0, keys };
  }

  get observedIdentifierCount(): number {
    return this.observed.size;
  }

  /** Record the current cart; returns its hash. */
  noteCart(cart: unknown): string | undefined {
    const digest = computeCartHash(cart);
    if (digest === undefined) return undefined;
    if (digest !== this.cartHash) this.previousCartHash = this.cartHash;
    this.cartHash = digest;
    return digest;
  }

  /** Record a placement attempt; returns its 1-based ordinal. 2 or more: this cart was submitted before. */
  notePlacement(cartHash?: string): number {
    const key = cartHash ?? this.cartHash ?? '';
    const attempt = (this.placements.get(key) ?? 0) + 1;
    this.placements.set(key, attempt);
    return attempt;
  }

  placementAttempts(cartHash?: string): number {
    return this.placements.get(cartHash ?? this.cartHash ?? '') ?? 0;
  }
}

export class MCPSessionRegistry {
  private readonly sessions = new Map<string, MCPSessionState>();

  constructor(private readonly identifierKeyPattern?: string) {}

  /** Get or create the state of a session. */
  get(sessionId: string, seedIdentifiers?: Iterable<string>): MCPSessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = new MCPSessionState(sessionId, { seedIdentifiers, identifierKeyPattern: this.identifierKeyPattern });
      this.sessions.set(sessionId, state);
    } else if (seedIdentifiers) {
      state.seed(seedIdentifiers);
    }
    return state;
  }

  drop(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}
