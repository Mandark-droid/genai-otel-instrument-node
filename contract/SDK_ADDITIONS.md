# Cross-SDK additions (not present in Python v1.30.0)

Decided by the lead so all four SDKs agree. Not in `MANIFEST.json`; not generated.
Each SDK lists these in its parity matrix as "not present in Python".

## 1. Pricing-missing counter

| | |
|---|---|
| Name | `gen_ai.usage.cost.pricing_missing` |
| Kind | counter |
| Unit | `""` |
| Meter | `genai_otel.instrumentors.base` |
| Attributes | `model`, `call_type` |
| When | incremented once per span whose model has no price (contract `priced: false`) and for the 13 pricing entries on which Python's calculator raises |

## 2. Resource identity

`telemetry.distro.name` is `genai-otel-instrument-<lang>` (`node`, `dotnet`, `java`,
`go`). Python emits `genai-otel-instrument` with no suffix. `telemetry.sdk.language` is
whatever the OpenTelemetry SDK for that language sets (`nodejs`, `dotnet`, `java`, `go`).

## 3. Custom pricing is honoured by every instrumentor (decision, 2026-10-02)

In Python v1.30.0, `GENAI_CUSTOM_PRICING_JSON` is ignored by 39 of 42 instrumentor
modules (OpenAI and Anthropic included) because `instrument()` never calls
`_setup_config()`. **The SDKs do not copy this.** In every SDK, custom pricing supplied
through `GENAI_CUSTOM_PRICING_JSON` (or the equivalent option) applies to every
instrumentor and to the cost-enrichment processor, with the merge semantics of
`CostCalculator._merge_custom_pricing` (accepted categories and validation as recorded
in `cost_vectors.json`). A span priced from custom pricing reports the same
`gen_ai.usage.cost.*` attributes and `pricing_source` the Python calculator reports for a
custom-priced model. Each SDK needs a test that fails if an instrumentor ignores it, and
lists this in the parity matrix as a deliberate difference from Python v1.30.0 (to be
fixed upstream).
