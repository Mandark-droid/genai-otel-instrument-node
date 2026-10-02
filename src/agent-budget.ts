/**
 * Per-invocation budget governance for agent spans. A port of
 * `genai_otel/agent_budget.py`.
 *
 * Agent frameworks all cap how much work one invocation may do - turns,
 * iterations, recursion depth, sometimes tokens. With the cap and the
 * consumption on the same span, "which agents run near their limit" is one
 * query instead of a sum over child spans - and it survives head sampling,
 * which drops exactly those children.
 *
 * Consumption is accumulated in a frame carried by the OpenTelemetry context,
 * not read back from child spans, for that reason. A nested agent has a frame
 * of its own: a supervisor reports its own direct usage, not its sub-agents'.
 */
import { context, createContextKey, type Context } from '@opentelemetry/api';
import { SemanticConvention as SC } from './semconv';

export class BudgetFrame {
  tokens = 0;
  iterations = 0;
}

const BUDGET_KEY = createContextKey('traceverse.genai-otel-instrument.agent-budget');

/** A context in which model calls are attributed to `frame`. */
export function withBudgetFrame(ctx: Context, frame: BudgetFrame): Context {
  return ctx.setValue(BUDGET_KEY, frame);
}

/**
 * Attribute one model call's tokens to the enclosing agent invocation. A no-op
 * outside one, which is the common case.
 */
export function recordInference(tokens: number, ctx: Context = context.active()): void {
  if (!Number.isInteger(tokens) || tokens < 0) return;
  const frame = ctx.getValue(BUDGET_KEY) as BudgetFrame | undefined;
  if (!frame) return;
  frame.tokens += tokens;
  frame.iterations += 1;
}

/** How each framework spells its per-invocation caps. Iteration caps are far more common than token caps. */
const ITERATION_BUDGET_KEYS = ['max_turns', 'max_iterations', 'max_iter', 'recursion_limit', 'max_llm_calls', 'max_rounds', 'maxTurns', 'maxIterations', 'recursionLimit', 'maxSteps'];
const TOKEN_BUDGET_KEYS = ['max_tokens', 'token_budget', 'max_total_tokens', 'tokenBudget', 'maxTotalTokens'];

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const truncated = Math.trunc(value);
  return truncated > 0 ? truncated : undefined;
}

function lookup(sources: unknown[], keys: readonly string[]): number | undefined {
  for (const source of sources) {
    if (typeof source !== 'object' || source === null) continue;
    for (const key of keys) {
      const found = positiveInt((source as Record<string, unknown>)[key]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * The configured budgets, from any mix of call options and agent objects; the
 * first match wins. A cap is recorded as configured and never derived - an
 * iteration limit times a per-call `max_tokens` is a number nobody configured.
 */
export function extractBudgetAttributes(...sources: unknown[]): Record<string, number> {
  const attributes: Record<string, number> = {};
  const iterations = lookup(sources, ITERATION_BUDGET_KEYS);
  if (iterations !== undefined) attributes[SC.GEN_AI_AGENT_ITERATION_BUDGET] = iterations;
  const tokens = lookup(sources, TOKEN_BUDGET_KEYS);
  if (tokens !== undefined) attributes[SC.GEN_AI_AGENT_TOKEN_BUDGET] = tokens;
  return attributes;
}

/** What one agent invocation consumed. Nothing consumed: no attribute, not a zero. */
export function consumptionAttributes(frame: BudgetFrame | undefined): Record<string, number> {
  const attributes: Record<string, number> = {};
  if (!frame) return attributes;
  if (frame.tokens > 0) attributes[SC.GEN_AI_AGENT_TOKEN_BUDGET_CONSUMED] = frame.tokens;
  if (frame.iterations > 0) attributes[SC.GEN_AI_AGENT_ITERATION_BUDGET_CONSUMED] = frame.iterations;
  return attributes;
}

/** Consumed over budget, or undefined when there is no budget: "none configured" is not "zero per cent used". */
export function utilization(consumed: unknown, budget: unknown): number | undefined {
  if (typeof consumed !== 'number' || typeof budget !== 'number' || !Number.isInteger(consumed) || !Number.isInteger(budget)) return undefined;
  if (budget <= 0) return undefined;
  return consumed / budget;
}
