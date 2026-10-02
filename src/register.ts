/**
 * Zero-code entry point for CommonJS applications:
 *
 *     node --require @traceverse/genai-otel-instrument/register app.js
 *
 * Configuration comes from the environment (OTEL_SERVICE_NAME,
 * OTEL_EXPORTER_OTLP_ENDPOINT, GENAI_*). A failure here is logged and the
 * application starts uninstrumented, unless GENAI_FAIL_ON_ERROR=true.
 */
import { instrument } from './auto-instrument';

instrument();
