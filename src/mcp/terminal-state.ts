/**
 * Deterministic terminal-state classifier for MCP agent sessions. Port of
 * `genai_otel/mcp_semconv/terminal_state.py`.
 *
 * Every session is classified into exactly one `TerminalState` by rules over
 * span attributes; no model is involved, the same spans always give the same
 * answer, and every classification carries the evidence that produced it.
 *
 * Rule precedence, first match wins: guardrail block; platform failure (an
 * unrecovered auth / shed / outage status); no tool for the requested
 * resolution; completed (clean or degraded); agent fault; recoverable. A
 * session that matches nothing is `ABANDONED_RECOVERABLE` with
 * `confident: false`.
 *
 * Spans may be OpenTelemetry spans (`status.code === SpanStatusCode.ERROR`) or
 * plain records with a `status` the reference accepts (`'ERROR'`,
 * `'STATUS_CODE_ERROR'`, `true`, `{ status_code: 'ERROR' }`).
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { pyStr } from '../pycompat';
import { CommerceAttributes, GuardrailAttributes, MCPAttributes } from './attributes';
import { KNOWN_CAPABILITIES, type MCPToolRegistry } from './tool-registry';

export const TerminalState = Object.freeze({
  COMPLETED_SUCCESS: 'COMPLETED_SUCCESS',
  COMPLETED_DEGRADED: 'COMPLETED_DEGRADED',
  ABANDONED_RECOVERABLE: 'ABANDONED_RECOVERABLE',
  ABANDONED_AGENT_FAULT: 'ABANDONED_AGENT_FAULT',
  BLOCKED_NO_TOOL: 'BLOCKED_NO_TOOL',
  BLOCKED_BY_GUARDRAIL: 'BLOCKED_BY_GUARDRAIL',
  BLOCKED_BY_PLATFORM: 'BLOCKED_BY_PLATFORM',
} as const);
export type TerminalState = (typeof TerminalState)[keyof typeof TerminalState];

/** The resolution a `BLOCKED_NO_TOOL` session was asking for. */
export const NoToolResolution = Object.freeze({
  CANCEL_ORDER: 'cancel_order',
  REFUND: 'refund',
  REPLACEMENT: 'replacement',
  MISSING_ITEM_CLAIM: 'missing_item_claim',
  MODIFY_PLACED_ORDER: 'modify_placed_order',
  RESCHEDULE_BOOKING: 'reschedule_booking',
  CANCEL_BOOKING: 'cancel_booking',
  ESCALATE_TO_HUMAN: 'escalate_to_human',
  ADDRESS_EDIT_MID_CART: 'address_edit_mid_cart',
  ORDER_HISTORY_LOOKUP: 'order_history_lookup',
} as const);
export type NoToolResolution = (typeof NoToolResolution)[keyof typeof NoToolResolution];

/** HTTP statuses that mean the platform failed, not the agent. */
export const PLATFORM_HTTP_STATUSES: ReadonlySet<number> = new Set([401, 403, 407, 429, 500, 502, 503, 504]);
/** Guardrail decisions that block. `steer` is a redirect, not a block. */
export const GUARDRAIL_BLOCK_DECISIONS: ReadonlySet<string> = new Set(['block', 'blocked', 'deny', 'denied']);
/** Stages whose mutating calls may change a cart hash. Placement (`Order`) mutates the order, not the cart. */
export const CART_MUTATION_STAGES: ReadonlySet<string> = new Set(['Cart', 'Reserve']);

export interface Evidence {
  rule: string;
  detail: string;
  spanIndex?: number;
  spanName?: string;
  attributes: Record<string, unknown>;
}

export interface Classification {
  state: TerminalState;
  rule: string;
  evidence: Evidence[];
  resolution?: NoToolResolution;
  /** False when no rule matched and the fallback was used. */
  confident: boolean;
  /** An order or booking was placed, whatever the final state. */
  orderPlaced: boolean;
  /** Every signal observed, decisive or not. */
  signals: Record<string, unknown>;
  /** A readable audit trail. */
  explain(): string;
}

type Signals = Record<string, unknown>;

function evidenceText(item: Evidence): string {
  return `${item.rule}${item.spanIndex === undefined ? '' : ` [span ${item.spanIndex}]`}: ${item.detail}`;
}

function classification(fields: Omit<Classification, 'explain' | 'evidence' | 'confident' | 'orderPlaced'> & Partial<Pick<Classification, 'evidence' | 'confident' | 'orderPlaced'>>): Classification {
  const result: Classification = {
    evidence: [],
    confident: true,
    orderPlaced: false,
    ...fields,
    explain() {
      let header = `${result.state} (rule=${result.rule}, confident=${result.confident ? 'True' : 'False'})`;
      if (result.resolution !== undefined) header += ` resolution=${result.resolution}`;
      return [header, ...result.evidence.map((item) => `  - ${evidenceText(item)}`)].join('\n');
    },
  };
  return result;
}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

function statusIsError(status: unknown): boolean {
  if (status === undefined || status === null) return false;
  if (typeof status === 'boolean') return status;
  if (typeof status === 'string') return ['ERROR', 'STATUS_CODE_ERROR'].includes(status.trim().toUpperCase());
  if (isObject(status)) {
    if (status.code === SpanStatusCode.ERROR) return true;
    if (status.code !== undefined) return false;
    const code = status.status_code ?? status;
    return String(isObject(code) ? code.name : code).toUpperCase().endsWith('ERROR');
  }
  return String(status).toUpperCase().endsWith('ERROR');
}

/** A uniform view over one span, whatever it was recorded as. */
class SpanView {
  readonly name: string;
  readonly attributes: Obj;
  readonly statusError: boolean;

  constructor(
    readonly index: number,
    source: unknown,
  ) {
    const record = isObject(source) ? source : {};
    this.name = String(record.name ?? '');
    this.attributes = isObject(record.attributes) ? { ...record.attributes } : {};
    this.statusError = statusIsError(record.status);
  }

  get(key: string): unknown {
    return this.attributes[key];
  }

  get failed(): boolean {
    return (
      this.statusError ||
      MCPAttributes.ERROR_MESSAGE_RAW in this.attributes ||
      MCPAttributes.ERROR_HTTP_STATUS in this.attributes ||
      MCPAttributes.ERROR_JSONRPC_CODE in this.attributes
    );
  }

  get tool(): string | undefined {
    const value = this.get(MCPAttributes.TOOL);
    return value ? String(value) : undefined;
  }
}

/** An attribute read as a boolean, string forms included. */
function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['true', 'yes', '1'].includes(value.trim().toLowerCase());
  if (typeof value === 'number') return value !== 0;
  return false;
}

/** Explicitly false, not merely absent. */
function isFalse(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'string') return ['false', 'no', '0'].includes(value.trim().toLowerCase());
  if (typeof value === 'number') return value === 0;
  return false;
}

/** Python's `isinstance(value, int)`, booleans aside. */
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

function pick(attributes: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(attributes)) if (keys.includes(key)) out[key] = value;
  return out;
}

export interface ClassifierOptions {
  /** Describes the registration surface: needed for `BLOCKED_NO_TOOL`. */
  registry?: MCPToolRegistry;
  /** An explicit capability allow-list, for callers with no registry. Wins over the registry. */
  availableCapabilities?: Iterable<string>;
}

export class TerminalStateClassifier {
  readonly registry: MCPToolRegistry | undefined;
  private readonly explicit: Set<string> | undefined;

  constructor(options: ClassifierOptions = {}) {
    this.registry = options.registry;
    this.explicit = options.availableCapabilities === undefined ? undefined : new Set([...options.availableCapabilities].map(String));
  }

  private capabilityKnown(): boolean {
    return this.explicit !== undefined || this.registry !== undefined;
  }

  hasCapability(capability: string): boolean {
    if (this.explicit) return this.explicit.has(capability);
    return this.registry ? this.registry.hasCapability(capability) : false;
  }

  private toolsForCapability(capability: string): Set<string> {
    return new Set(this.registry ? this.registry.toolsForCapability(capability).map((meta) => meta.name) : []);
  }

  /** Capabilities the surface cannot satisfy: the measured tool-surface gaps. */
  missingCapabilities(): string[] {
    if (this.explicit) return KNOWN_CAPABILITIES.filter((capability) => !(this.explicit as Set<string>).has(capability));
    return this.registry ? this.registry.missingCapabilities() : [];
  }

  /** Classify one session; `spans` in chronological order. `requestedResolution` overrides what the spans say. */
  classify(spans: Iterable<unknown>, requestedResolution?: string): Classification {
    const views = [...spans].map((span, index) => new SpanView(index, span));
    const resolution = requestedResolution || findRequestedResolution(views);
    const signals = this.collectSignals(views, resolution);
    for (const rule of [this.ruleGuardrail, this.rulePlatform, this.ruleNoTool, this.ruleCompleted, this.ruleAgentFault, this.ruleRecoverable]) {
      const result = rule.call(this, views, resolution, signals);
      if (result) return result;
    }
    return classification({
      state: TerminalState.ABANDONED_RECOVERABLE,
      rule: 'fallback.no_terminal_signal',
      confident: false,
      orderPlaced: Boolean(signals.order_placed),
      signals,
      evidence: [
        {
          rule: 'fallback.no_terminal_signal',
          detail:
            'No rule matched: no guardrail block, no platform error, no requested resolution, no order placed and no agent-fault signal. Defaulted to ABANDONED_RECOVERABLE with confident=False.',
          attributes: {},
        },
      ],
    });
  }

  private collectSignals(views: SpanView[], resolution: string | undefined): Signals {
    const placements = views.filter((view) => truthy(view.get(CommerceAttributes.ORDER_PLACED)) && !view.failed);
    const [sequence, driftIndexes] = detectCartDrift(views);
    const failed = views.filter((view) => view.failed);
    const repeated: Record<string, number> = {};
    for (const view of failed) if (view.tool) repeated[view.tool] = (repeated[view.tool] ?? 0) + 1;
    return {
      span_count: views.length,
      order_placed: placements.length > 0,
      placement_span_indexes: placements.map((view) => view.index),
      cart_hash_sequence: sequence,
      cart_drift: driftIndexes.length > 0,
      cart_drift_span_indexes: driftIndexes,
      hallucinated_span_indexes: views.filter((view) => truthy(view.get(MCPAttributes.IDENTIFIER_HALLUCINATED))).map((view) => view.index),
      wrong_tool_span_indexes: views.filter((view) => isFalse(view.get(MCPAttributes.TOOL_SELECTION_CORRECT))).map((view) => view.index),
      duplicate_placement_span_indexes: views
        .filter((view) => {
          const attempt = view.get(CommerceAttributes.ORDER_PLACEMENT_ATTEMPT);
          return isInt(attempt) && attempt >= 2;
        })
        .map((view) => view.index),
      failed_span_indexes: failed.map((view) => view.index),
      repeated_failing_tools: Object.fromEntries(Object.entries(repeated).filter(([, count]) => count >= 2)),
      requested_resolution: resolution ?? null,
      capability_available: resolution && this.capabilityKnown() ? this.hasCapability(resolution) : null,
    };
  }

  /** Rule 1: enforcement stopped the session. */
  private ruleGuardrail(views: SpanView[], _resolution: string | undefined, signals: Signals): Classification | undefined {
    for (const view of views) {
      const decision = view.get(GuardrailAttributes.DECISION);
      const decisionBlocks = typeof decision === 'string' && GUARDRAIL_BLOCK_DECISIONS.has(decision.trim().toLowerCase());
      if (!decisionBlocks && !truthy(view.get(GuardrailAttributes.BLOCKED))) continue;
      const rule = view.get(GuardrailAttributes.RULE);
      return classification({
        state: TerminalState.BLOCKED_BY_GUARDRAIL,
        rule: 'guardrail.blocked',
        orderPlaced: Boolean(signals.order_placed),
        signals,
        evidence: [
          {
            rule: 'guardrail.blocked',
            detail: `Enforcement blocked the call${rule ? ` (rule=${pyStr(rule)})` : ''}`,
            spanIndex: view.index,
            spanName: view.name,
            attributes: pick(view.attributes, [GuardrailAttributes.DECISION, GuardrailAttributes.BLOCKED, GuardrailAttributes.RULE, MCPAttributes.TOOL]),
          },
        ],
      });
    }
    return undefined;
  }

  /** Rule 2: auth failure, load shedding or upstream outage - the session ended on it. */
  private rulePlatform(views: SpanView[], _resolution: string | undefined, signals: Signals): Classification | undefined {
    const failure = lastUnrecoveredFailure(views);
    if (!failure) return undefined;
    const status = failure.get(MCPAttributes.ERROR_HTTP_STATUS);
    if (!isInt(status) || !PLATFORM_HTTP_STATUSES.has(status)) return undefined;
    return classification({
      state: TerminalState.BLOCKED_BY_PLATFORM,
      rule: 'platform.http_status',
      orderPlaced: Boolean(signals.order_placed),
      signals,
      evidence: [
        {
          rule: 'platform.http_status',
          detail: `Session ended on an unrecovered HTTP ${status}, which is a platform condition (auth, shed or outage), not an agent or surface fault.`,
          spanIndex: failure.index,
          spanName: failure.name,
          attributes: pick(failure.attributes, [
            MCPAttributes.ERROR_HTTP_STATUS,
            MCPAttributes.ERROR_JSONRPC_CODE,
            MCPAttributes.ERROR_MESSAGE_RAW,
            MCPAttributes.TOOL,
            MCPAttributes.SERVER,
          ]),
        },
      ],
    });
  }

  /** Rule 3: the requested resolution has no satisfying tool in the surface. */
  private ruleNoTool(_views: SpanView[], resolution: string | undefined, signals: Signals): Classification | undefined {
    // Without a description of the surface this cannot be decided: decline rather than guess.
    if (!resolution || !this.capabilityKnown() || this.hasCapability(resolution)) return undefined;
    const known = (Object.values(NoToolResolution) as string[]).includes(resolution) ? (resolution as NoToolResolution) : undefined;
    const evidence: Evidence[] = [
      {
        rule: 'no_tool.capability_absent',
        detail: `The user requested '${resolution}' and no tool in the ${this.registry ? this.registry.candidateCount : 'supplied'}-tool registration surface can satisfy it, so no agent behaviour could have succeeded.`,
        attributes: { [CommerceAttributes.REQUESTED_RESOLUTION]: resolution },
      },
    ];
    const hallucinated = signals.hallucinated_span_indexes as number[];
    if (hallucinated.length > 0) {
      evidence.push({
        rule: 'no_tool.agent_signals_present_but_not_decisive',
        detail: `Hallucinated identifiers were also observed on spans ${pyStr(hallucinated)}, but the surface gap takes precedence: no tool existed to call correctly.`,
        attributes: {},
      });
    }
    return classification({
      state: TerminalState.BLOCKED_NO_TOOL,
      rule: 'no_tool.capability_absent',
      resolution: known,
      orderPlaced: Boolean(signals.order_placed),
      signals,
      evidence,
    });
  }

  /** Rule 4: an order or booking was placed; clean, or degraded. */
  private ruleCompleted(views: SpanView[], _resolution: string | undefined, signals: Signals): Classification | undefined {
    const indexes = signals.placement_span_indexes as number[];
    if (indexes.length === 0) return undefined;
    const placement = views[indexes[indexes.length - 1] as number] as SpanView;
    const degradations: Evidence[] = [];
    const attempt = placement.get(CommerceAttributes.ORDER_PLACEMENT_ATTEMPT);
    if (isInt(attempt) && attempt >= 2) {
      degradations.push({
        rule: 'degraded.duplicate_placement',
        detail: `Placement attempt ${attempt} against the same cart hash - the order was submitted more than once.`,
        spanIndex: placement.index,
        spanName: placement.name,
        attributes: { [CommerceAttributes.ORDER_PLACEMENT_ATTEMPT]: attempt },
      });
    }
    const quoted = placement.get(CommerceAttributes.PRICE_QUOTED);
    const charged = placement.get(CommerceAttributes.PRICE_CHARGED);
    if (quoted !== undefined && quoted !== null && charged !== undefined && charged !== null && quoted !== charged) {
      degradations.push({
        rule: 'degraded.price_mismatch',
        detail: `Quoted ${pyStr(quoted)} but charged ${pyStr(charged)}; the mismatch was absorbed.`,
        spanIndex: placement.index,
        spanName: placement.name,
        attributes: { [CommerceAttributes.PRICE_QUOTED]: quoted, [CommerceAttributes.PRICE_CHARGED]: charged },
      });
    }
    const couponRequested = views.some((view) => truthy(view.get(CommerceAttributes.COUPON_REQUESTED)));
    const couponApplied = views.some((view) => truthy(view.get(CommerceAttributes.COUPON_APPLIED)));
    if (couponRequested && !couponApplied) {
      degradations.push({ rule: 'degraded.coupon_missed', detail: 'A coupon was requested but never applied to the placed order.', attributes: { [CommerceAttributes.COUPON_REQUESTED]: true } });
    }
    const wrongVariant = views.find((view) => isFalse(view.get(CommerceAttributes.VARIANT_MATCH)));
    if (wrongVariant) {
      degradations.push({
        rule: 'degraded.wrong_variant',
        detail: 'The ordered variant does not match the requested variant.',
        spanIndex: wrongVariant.index,
        spanName: wrongVariant.name,
        attributes: { [CommerceAttributes.VARIANT_MATCH]: false },
      });
    }
    if (signals.cart_drift) {
      degradations.push({
        rule: 'degraded.cart_drift',
        detail: `Cart hash changed across the session (${pyStr(signals.cart_hash_sequence)}); the cart ordered is not the cart confirmed.`,
        attributes: { [CommerceAttributes.CART_HASH]: signals.cart_hash_sequence },
      });
    }
    if (degradations.length > 0) {
      return classification({ state: TerminalState.COMPLETED_DEGRADED, rule: (degradations[0] as Evidence).rule, orderPlaced: true, signals, evidence: degradations });
    }
    return classification({
      state: TerminalState.COMPLETED_SUCCESS,
      rule: 'completed.clean',
      orderPlaced: true,
      signals,
      evidence: [
        {
          rule: 'completed.clean',
          detail: 'Order placed with no degradation signal present.',
          spanIndex: placement.index,
          spanName: placement.name,
          attributes: { [CommerceAttributes.ORDER_PLACED]: true },
        },
      ],
    });
  }

  /** Rule 5: agent behaviour caused the abandonment. */
  private ruleAgentFault(views: SpanView[], _resolution: string | undefined, signals: Signals): Classification | undefined {
    const evidence: Evidence[] = [];
    for (const index of signals.hallucinated_span_indexes as number[]) {
      const view = views[index] as SpanView;
      const keys = view.get(MCPAttributes.IDENTIFIER_HALLUCINATED_KEYS);
      evidence.push({
        rule: 'agent_fault.hallucinated_identifier',
        detail: `Call passed identifier key(s) ${pyStr(Array.isArray(keys) ? keys : keys ? [...String(keys)] : [])} that appeared in no prior response in this session.`,
        spanIndex: index,
        spanName: view.name,
        attributes: {
          [MCPAttributes.IDENTIFIER_HALLUCINATED]: true,
          [MCPAttributes.IDENTIFIER_HALLUCINATED_KEYS]: keys ?? null,
          [MCPAttributes.TOOL]: view.get(MCPAttributes.TOOL) ?? null,
        },
      });
    }
    for (const index of signals.wrong_tool_span_indexes as number[]) {
      const view = views[index] as SpanView;
      evidence.push({
        rule: 'agent_fault.wrong_tool',
        detail: `Called '${pyStr(view.get(MCPAttributes.TOOL) ?? null)}' where ground truth was '${pyStr(view.get(MCPAttributes.TOOL_SELECTION_EXPECTED) ?? null)}'.`,
        spanIndex: index,
        spanName: view.name,
        attributes: {
          [MCPAttributes.TOOL]: view.get(MCPAttributes.TOOL) ?? null,
          [MCPAttributes.TOOL_SELECTION_EXPECTED]: view.get(MCPAttributes.TOOL_SELECTION_EXPECTED) ?? null,
          [MCPAttributes.TOOL_SELECTION_CORRECT]: false,
        },
      });
    }
    if (signals.cart_drift && (signals.failed_span_indexes as number[]).length > 0) {
      evidence.push({
        rule: 'agent_fault.stale_cart',
        detail: `Cart hash drifted (${pyStr(signals.cart_hash_sequence)}) and the session ended on a failure - the agent operated on a stale cart.`,
        attributes: {},
      });
    }
    for (const [tool, count] of Object.entries(signals.repeated_failing_tools as Record<string, number>)) {
      evidence.push({
        rule: 'agent_fault.repeated_identical_failure',
        detail: `Tool '${tool}' failed ${count} times with no change in approach.`,
        attributes: { [MCPAttributes.TOOL]: tool },
      });
    }
    if (evidence.length === 0) return undefined;
    return classification({
      state: TerminalState.ABANDONED_AGENT_FAULT,
      rule: (evidence[0] as Evidence).rule,
      orderPlaced: Boolean(signals.order_placed),
      signals,
      evidence,
    });
  }

  /** Rule 6: an in-protocol resolution existed and was not taken. */
  private ruleRecoverable(views: SpanView[], resolution: string | undefined, signals: Signals): Classification | undefined {
    // A: the requested capability exists, and no tool satisfying it was called.
    if (resolution && signals.capability_available === true) {
      const satisfying = this.toolsForCapability(resolution);
      const called = new Set(views.map((view) => view.tool).filter((tool): tool is string => Boolean(tool)));
      if (satisfying.size > 0 && ![...satisfying].some((tool) => called.has(tool))) {
        return classification({
          state: TerminalState.ABANDONED_RECOVERABLE,
          rule: 'recoverable.capability_available_unused',
          orderPlaced: Boolean(signals.order_placed),
          signals,
          evidence: [
            {
              rule: 'recoverable.capability_available_unused',
              detail: `'${resolution}' was requested and tool(s) ${pyStr([...satisfying].sort())} could have satisfied it, but none were called.`,
              attributes: { [CommerceAttributes.REQUESTED_RESOLUTION]: resolution },
            },
          ],
        });
      }
    }
    // B: the session ended on a failure that was never retried.
    const failure = lastUnrecoveredFailure(views);
    if (failure) {
      const attempts = views.filter((view) => view.tool && view.tool === failure.tool).length;
      if (attempts <= 1) {
        return classification({
          state: TerminalState.ABANDONED_RECOVERABLE,
          rule: 'recoverable.unretried_failure',
          orderPlaced: Boolean(signals.order_placed),
          signals,
          evidence: [
            {
              rule: 'recoverable.unretried_failure',
              detail: `Session ended on a recoverable failure of '${pyStr(failure.tool ?? null)}' that was never retried or worked around.`,
              spanIndex: failure.index,
              spanName: failure.name,
              attributes: {
                [MCPAttributes.TOOL]: failure.tool ?? null,
                [MCPAttributes.ERROR_MESSAGE_RAW]: failure.get(MCPAttributes.ERROR_MESSAGE_RAW) ?? null,
                [MCPAttributes.ERROR_JSONRPC_CODE]: failure.get(MCPAttributes.ERROR_JSONRPC_CODE) ?? null,
              },
            },
          ],
        });
      }
    }
    return undefined;
  }
}

/** The resolution declared on the spans; intent is never inferred from text. */
function findRequestedResolution(views: SpanView[]): string | undefined {
  for (const view of views) {
    for (const key of [CommerceAttributes.REQUESTED_RESOLUTION, MCPAttributes.TOOL_SELECTION_REQUESTED_CAPABILITY]) {
      const value = view.get(key);
      if (value) return String(value);
    }
  }
  return undefined;
}

/**
 * Cart-hash changes no cart mutation explains: the cart moved under the
 * agent. A cart-stage mutation in the same call, or since the last reading,
 * explains a change; a placement does not.
 */
function detectCartDrift(views: SpanView[]): [unknown[], number[]] {
  const sequence: unknown[] = [];
  const drift: number[] = [];
  let previous: unknown;
  let pendingMutation = false;
  for (const view of views) {
    const mutatesCart = view.get(MCPAttributes.BEHAVIOUR) === 'mutating' && CART_MUTATION_STAGES.has(String(view.get(MCPAttributes.STAGE)));
    const digest = view.get(CommerceAttributes.CART_HASH);
    if (digest === undefined || digest === null) {
      pendingMutation = pendingMutation || mutatesCart;
      continue;
    }
    if (sequence.length === 0 || sequence[sequence.length - 1] !== digest) sequence.push(digest);
    if (previous !== undefined && digest !== previous && !(mutatesCart || pendingMutation)) drift.push(view.index);
    previous = digest;
    pendingMutation = false;
  }
  return [sequence, drift];
}

/** The failure the session ended on, if it ended on one; a failure followed by success is not it. */
function lastUnrecoveredFailure(views: SpanView[]): SpanView | undefined {
  const last = views[views.length - 1];
  return last?.failed ? last : undefined;
}

/** Classify one session into exactly one terminal state. */
export function classifySession(
  spans: Iterable<unknown>,
  options: ClassifierOptions & { requestedResolution?: string } = {},
): Classification {
  return new TerminalStateClassifier(options).classify(spans, options.requestedResolution);
}
