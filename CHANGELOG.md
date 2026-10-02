# Changelog

## [Unreleased]

### Added
- Repository scaffold.
- Build and test toolchain: TypeScript, CommonJS + ES-module bundles (tsup), vitest with
  coverage floors (90% on `config`, `cost`, `metrics`), eslint, `tsc --noEmit`.
- `scripts/sync-from-python.mjs`: vendors the cross-language contract and the pricing
  table from the Python reference at the pinned tag (v1.30.0), verifying every file
  against the manifest's sha256. `--check` fails on drift or a hand edit.
- Vendored `contract/*` and `src/pricing/llm_pricing.json` at v1.30.0.
- `loadConfig()`: environment-driven configuration with the Python library's variables,
  defaults and parsing, checked against every case in `contract/config.json`.
- `buildResource()`: resource attributes with `telemetry.sdk.language=nodejs`,
  `telemetry.distro.name=genai-otel-instrument-node` and `telemetry.distro.version`,
  host / os / process attributes, argv credential redaction, `host.ip`, and a random or
  derived `service.instance.id`. The attribute set matches the reference implementation's.
- `instrument()`, `uninstrument()`, `flushTelemetry()`, `instrumentorsReady()`: tracer and
  meter providers with OTLP http/protobuf or gRPC exporters (console exporters when the
  endpoint is empty), trace-id-ratio sampling, W3C trace-context propagation, flush on
  exit and optionally on SIGTERM. Export is batched off the request path; shutdown and
  flush are bounded by a timeout.
- Zero-code entry points: `node --require @traceverse/genai-otel-instrument/register`
  (CommonJS) and `node --import @traceverse/genai-otel-instrument/register` (ES modules).
- GitHub Actions `test` workflow: sync check, typecheck, lint, tests and build on Node
  20 / 22 / 24, and a built-package smoke on Node 18.

- `CostCalculator`: a port of the Python cost calculator - case-insensitive exact match,
  then the longest pricing key that matches on a token boundary; parameter-count tiers
  for local models; custom pricing (`GENAI_CUSTOM_PRICING_JSON`) merged over the shipped
  table; granular cost (prompt, completion, reasoning, cache read, cache write);
  `pricingSource`, `deprecation`, `priceChecked`, `stalePrices`. Passes every vector in
  `contract/cost_vectors.json` bit for bit.
- An unpriced model yields `null`, never `0`: no cost attribute is written, and the call
  is counted in the new `gen_ai.usage.cost.pricing_missing` counter.
- `CostEnrichmentSpanProcessor`: prices GenAI and OpenInference spans produced by other
  instrumentation, at span end.

- `scripts/generate-contract-code.mjs`: generates `src/semconv.generated.ts` and
  `src/metrics.generated.ts` from the vendored contract before build, test, typecheck and
  lint. Attribute names, metric names, units, kinds and bucket boundaries are not typed by
  hand anywhere.
- `genaiSemconvModes()` / `genaiTierOptedIn()`: the `OTEL_SEMCONV_STABILITY_OPT_IN`
  policy, passing every opt-in case in `contract/semconv.json`.
- Shared GenAI client metric instruments (the 20 of the Python base instrumentor) and
  the explicit-bucket histogram views, matching `contract/metrics.json` in name, unit,
  kind, description, instrumentation scope and bucket boundaries.

### Notes
- `npm audit`: one low-severity finding in `esbuild` (development server on Windows),
  reached only through the build tool. It does not ship and is not exercised.
