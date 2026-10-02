# Security

This is a private repository. Report a vulnerability directly to the repository owner;
do not open a public issue anywhere.

## What this library sends, and where

- **Only to the configured OTLP endpoint.** There is no call home, no usage reporting and
  no runtime download. The pricing table is bundled into the package; nothing is fetched.
- **Prompt and response content is not captured by default.** It is recorded only when
  `GENAI_ENABLE_CONTENT_CAPTURE=true` or
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` is `SPAN_ONLY` / `SPAN_AND_EVENT`,
  and is truncated to `GENAI_CONTENT_MAX_LENGTH`. An unrecognised value of the standard
  variable means no capture.
- **The process command line is redacted.** `process.command_args` and
  `process.command_line` have credential values removed (`--password x`, `--api-key=x`,
  `TOKEN=x`, `scheme://user:password@host`) before they are attached to the resource.
  The hardened profiles (`GENAI_PROFILE=strict|bfsi|bank`) do not report the command line
  at all.
- **No OS user name and no machine identifier** are attached to the resource.
- API keys are never read. The instrumentors see request parameters and responses, not
  client credentials, and do not record request headers.

## Failure behaviour

Instrumentation errors are caught and logged; `GENAI_FAIL_ON_ERROR=false` is the default.
Export is batched and asynchronous and never blocks a request path. Shutdown and flush
are bounded by a timeout.

## Dependencies

`npm audit` is expected to be clean for runtime dependencies. A development-only finding
is recorded in `CHANGELOG.md` when it cannot be resolved without breaking the toolchain.
