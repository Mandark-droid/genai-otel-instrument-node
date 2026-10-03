/**
 * Gauges report what is observed now (contract/SDK_ADDITIONS.md section 12).
 *
 * Under cumulative temporality the OpenTelemetry JS SDK merges every
 * collection of an asynchronous instrument into the last one, so an attribute
 * set observed once is exported forever: a model that unloaded keeps its last
 * KV-cache figure, a GPU that stopped answering keeps its last temperature. A
 * gauge carries no temporality on the wire (OTLP `Gauge` has none), so asking
 * for DELTA for gauge instruments changes nothing a receiver sees except that a
 * series nobody observes any more stops. Every other instrument keeps the
 * temporality its exporter chose.
 */
import {
  AggregationTemporality,
  InstrumentType,
  type AggregationTemporalitySelector,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';

const isGauge = (type: InstrumentType): boolean => type === InstrumentType.OBSERVABLE_GAUGE || type === InstrumentType.GAUGE;

/** A temporality selector: DELTA for gauges, `base` (default cumulative) for the rest. */
export function currentGaugesSelector(base?: AggregationTemporalitySelector): AggregationTemporalitySelector {
  return (type) => (isGauge(type) ? AggregationTemporality.DELTA : (base?.(type) ?? AggregationTemporality.CUMULATIVE));
}

/** The exporter, asking for DELTA for gauges and its own choice for everything else. */
export function currentGauges(exporter: PushMetricExporter): PushMetricExporter {
  const own = exporter.selectAggregationTemporality?.bind(exporter);
  return {
    export: (metrics, done) => exporter.export(metrics, done),
    forceFlush: () => exporter.forceFlush(),
    shutdown: () => exporter.shutdown(),
    ...(exporter.selectAggregation ? { selectAggregation: exporter.selectAggregation.bind(exporter) } : {}),
    selectAggregationTemporality: currentGaugesSelector(own),
  };
}
