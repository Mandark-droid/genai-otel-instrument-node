/**
 * Zero-code entry point for ES-module applications:
 *
 *     node --import genai-otel-instrument-node/register app.mjs
 *
 * ES modules cannot be patched synchronously from a hook, so this entry waits
 * until the instrumentors have finished patching the ESM builds of the client
 * libraries before the application's own module graph is evaluated.
 */
import { instrument, instrumentorsReady } from './auto-instrument';

instrument();
await instrumentorsReady();
