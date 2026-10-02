# ElevenLabs example

`speech.mjs`: One text-to-speech call through `@elevenlabs/elevenlabs-js`, priced by the character.

Spans: `elevenlabs.text_to_speech.convert`.

## Status

| | |
|---|---|
| Type-checked | Yes, in CI (`npm run typecheck`) |
| Run against a mock provider | Yes: `tests/e2e/provider-examples.test.ts` runs it as a child process against the built package and a mock provider, and checks the spans it exports |
| Run against the live API | **No.** No API key was available where this was written |

## Run it

```bash
npm ci && npm run build
ELEVENLABS_API_KEY=... OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/elevenlabs/speech.mjs
```

With no collector at hand, set `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) to print spans and
metrics to the console instead.

The span ends when the audio stream is handed to the application, not when the last byte is read.
