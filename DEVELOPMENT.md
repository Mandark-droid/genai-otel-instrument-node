# Development

Read `CLAUDE.md` first: the rules there are not negotiable.

## Commands

| Command | What it does |
|---|---|
| `npm ci` | Install the pinned toolchain |
| `npm test` | Unit, contract and instrumentor tests with coverage; enforces the 95% floor on `config`, `cost`, `metrics` |
| `npm run typecheck` | `tsc --noEmit` over `src`, `tests`, `scripts` and the examples |
| `npm run lint` | eslint |
| `npm run build` | CommonJS + ES-module bundles and type declarations into `dist/` |
| `npm run sync` / `npm run sync:check` | Vendor / verify the contract and pricing table |
| `npm run generate` | Regenerate `src/semconv.generated.ts` from `contract/semconv.json` (runs automatically before test, typecheck, lint and build) |
| `npm run smoke` | The built package: loads in both module formats; an application that never mentions it is traced through both zero-code hooks |
| `npm run compat` | The built package against each supported major of `openai` and `@anthropic-ai/sdk` (installs them into a temporary directory) |

The test toolchain and the SDK versions this repository develops against need Node 22 or
later. The package itself supports Node 18.19: CI builds it and runs `npm run smoke` and
`npm run compat` on Node 18, 20, 22 and 24.

`npm test` builds `dist/` first (`tests/global-setup.ts`), because `tests/e2e` runs the
example programs against the built package. Test workers run with `--expose-gc`:
`tests/instrumentors/no-leaked-spans.test.ts` forces garbage collections.

## Test first

Write the failing test, run it and see it fail, implement, see it pass. A commit never
contains a failing test.

Tests run in a scrubbed environment (`tests/setup.ts` removes every `GENAI_*` / `OTEL_*`
variable), because a developer machine usually has some set.

## The contract is vendored

`contract/*` and `src/pricing/llm_pricing.json` come from the Python repository at the
tag pinned in `scripts/sync-from-python.mjs`:

1. In the Python repository at that tag: `python scripts/generate_sdk_contract.py --out <dir>`.
2. Here: `npm run sync -- --from <dir>` (or set `GENAI_SDK_CONTRACT_DIR`).
3. `npm test`. Every break is a behaviour that changed upstream; fix the port, not the file.

`contract/SCHEMA.md` is the authority on the file shapes. Never edit a vendored file: CI
runs `npm run sync:check`, which fails on a hand edit. `.gitattributes` stops git from
rewriting their line endings, since they are verified by sha256.

## Layout

```
src/
  auto-instrument.ts   instrument() / uninstrument() / flushTelemetry()
  register.ts          --require hook      register.esm.ts   --import hook
  config.ts            environment-driven configuration
  resource.ts          resource attributes, identity, argv redaction
  cost/                calculator + cost-enrichment span processor
  pricing/             vendored llm_pricing.json
  semconv.ts           opt-in modes; semconv.generated.ts is generated
  metrics.ts           instruments, bucket boundaries, views
  instrumentors/       one file per provider
  state.ts             process-wide state shared across module copies
contract/              vendored contract files
scripts/               sync, code generation, built-package smoke
tests/                 unit, contract, instrumentors, fixtures, helpers
examples/              one runnable example per instrumentor, plus e2e/
docs/                  configuration, parity matrix
```

## Instrumentors

An instrumentor ships with: a test file driving the real client library against the mock
provider (`tests/helpers/mock-llm.ts`, fixtures in `tests/fixtures/`), an example under
`examples/<name>/` that `tests/e2e/examples.test.ts` runs, a row in
`docs/parity-matrix.md`, an entry in `scripts/sdk-compat.cjs`, and a changelog line.

Three things the existing ones do, which a new one must too:

1. **Return what the SDK returned.** The same promise object, the same stream object,
   observed in place. Callers use `withResponse()`, `controller`, `tee()`.
2. **End every span.** Completed, failed, cancelled, or never consumed.
3. **Never let a finalizer reach its target.** A `FinalizationRegistry` held value that can
   reach the object it is registered for keeps that object alive, and the span it should
   close stays open for ever. The held value is created where nothing of the SDK's is in
   scope - see `hookApiPromise` and `cancelWhenAbandoned` in `src/instrumentors/base.ts`.

## Module copies

The package ships as CommonJS and as ES modules, and `register` is bundled separately
from `index`. Several copies can therefore be loaded into one process. Anything that
must exist once - the "already instrumented" flag, the metric instruments, the default
cost calculator - lives on a global-symbol registry (`src/state.ts`), not in a module
variable.

The client libraries have the same split: `openai` and `@anthropic-ai/sdk` each ship
separate CommonJS and ES-module class objects. An instrumentor patches both.
