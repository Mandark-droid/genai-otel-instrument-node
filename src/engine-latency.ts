/**
 * Latency breakdown reported by a self-hosted inference engine. Port of
 * `engine_latency.py`.
 *
 * vLLM and SGLang use one `gen_ai.latency.*` attribute set in their own
 * tracing; those names are emitted here unchanged, so an operator running the
 * engine's tracing beside this library sees one vocabulary.
 *
 * Everything is defensive: a timing that is missing, negative, not a number or
 * out of order is "that phase was not measured" - the attribute is absent.
 */
import { ATTR } from './semconv';

/** A usable duration or timestamp in the engine's unit, or undefined. */
function seconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** Time between two engine timestamps; undefined when either is missing or they are out of order. */
function delta(end: unknown, start: unknown): number | undefined {
  const endSeconds = seconds(end);
  const startSeconds = seconds(start);
  if (endSeconds === undefined || startSeconds === undefined) return undefined;
  const duration = endSeconds - startSeconds;
  return duration >= 0 ? duration : undefined;
}

function present(candidates: Record<string, number | undefined>): Record<string, number> {
  const attributes: Record<string, number> = {};
  for (const [key, value] of Object.entries(candidates)) if (value !== undefined) attributes[key] = value;
  return attributes;
}

/**
 * From a vLLM `RequestMetrics`: absolute timestamps and a few durations, in
 * seconds - except `model_forward_time`, which vLLM reports in milliseconds.
 */
export function vllmLatencyAttributes(metrics: unknown): Record<string, number> {
  if (typeof metrics !== 'object' || metrics === null) return {};
  const m = metrics as Record<string, unknown>;
  const forwardMs = seconds(m.model_forward_time);
  return present({
    [ATTR.GEN_AI_LATENCY_TIME_IN_QUEUE]: seconds(m.time_in_queue),
    [ATTR.GEN_AI_LATENCY_TIME_TO_FIRST_TOKEN]: delta(m.first_token_time, m.arrival_time),
    [ATTR.GEN_AI_LATENCY_E2E]: delta(m.finished_time, m.arrival_time),
    [ATTR.GEN_AI_LATENCY_TIME_IN_MODEL_PREFILL]: delta(m.first_token_time, m.first_scheduled_time),
    [ATTR.GEN_AI_LATENCY_TIME_IN_MODEL_DECODE]: delta(m.last_token_time, m.first_token_time),
    [ATTR.GEN_AI_LATENCY_TIME_IN_MODEL_INFERENCE]: delta(m.last_token_time, m.first_scheduled_time),
    [ATTR.GEN_AI_LATENCY_TIME_IN_SCHEDULER]: seconds(m.scheduler_time),
    [ATTR.GEN_AI_LATENCY_TIME_IN_MODEL_EXECUTE]: seconds(m.model_execute_time),
    [ATTR.GEN_AI_LATENCY_TIME_IN_MODEL_FORWARD]: forwardMs === undefined ? undefined : forwardMs / 1000,
  });
}

/**
 * From a llama.cpp `timings` object: `prompt_ms` is prefill (and time to the
 * first token), `predicted_ms` is decode. Milliseconds there, seconds here.
 */
export function llamacppLatencyAttributes(timings: unknown): Record<string, number> {
  if (typeof timings !== 'object' || timings === null || Array.isArray(timings)) return {};
  const t = timings as Record<string, unknown>;
  const promptMs = seconds(t.prompt_ms);
  const predictedMs = seconds(t.predicted_ms);
  const attributes: Record<string, number> = {};
  if (promptMs !== undefined) {
    attributes[ATTR.GEN_AI_LATENCY_TIME_IN_MODEL_PREFILL] = promptMs / 1000;
    attributes[ATTR.GEN_AI_LATENCY_TIME_TO_FIRST_TOKEN] = promptMs / 1000;
  }
  if (predictedMs !== undefined) attributes[ATTR.GEN_AI_LATENCY_TIME_IN_MODEL_DECODE] = predictedMs / 1000;
  if (promptMs !== undefined && predictedMs !== undefined) {
    const total = (promptMs + predictedMs) / 1000;
    attributes[ATTR.GEN_AI_LATENCY_TIME_IN_MODEL_INFERENCE] = total;
    attributes[ATTR.GEN_AI_LATENCY_E2E] = total;
  }
  return attributes;
}
