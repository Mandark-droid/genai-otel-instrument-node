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

// The Ollama instrumentor polls an Ollama server for its loaded models. This
// machine may well run one; tests that want the poller turn it on themselves.
process.env.GENAI_ENABLE_OLLAMA_SERVER_METRICS = 'false';
