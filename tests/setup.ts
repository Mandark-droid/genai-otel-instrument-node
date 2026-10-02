/**
 * Run every test file in a scrubbed environment.
 *
 * A developer machine routinely has GENAI_* / OTEL_* variables set (this one
 * does), and they would otherwise leak into every `loadConfig()` that reads
 * `process.env`.
 */
for (const name of Object.keys(process.env)) {
  if (/^(GENAI_|OTEL_|TRACEVERDE_)/i.test(name) || name.toUpperCase() === 'ENVIRONMENT') {
    delete process.env[name];
  }
}
