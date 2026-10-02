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
