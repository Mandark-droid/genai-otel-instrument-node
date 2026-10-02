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

### Notes
- `npm audit`: one low-severity finding in `esbuild` (development server on Windows),
  reached only through the build tool. It does not ship and is not exercised.
