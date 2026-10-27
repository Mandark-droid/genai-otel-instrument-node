/**
 * Telemetry for the React Native example: start the SDK, hand it the cactus
 * classes, name the session.
 */
import { AppState } from 'react-native';
import { CactusLM, CactusSTT } from 'cactus-react-native';
import { instrument, instrumentCactus, setSession } from '@traceverse/genai-otel-instrument-node';

/**
 * Where to export. There is no default: a phone sends telemetry only to a
 * collector it is told about. From the Android emulator, the host machine is
 * 10.0.2.2; a collector elsewhere is reached by its own address.
 */
export const COLLECTOR_ENDPOINT = 'http://10.0.2.2:4318';

/** One conversation, one session: the platform groups spans by this id. */
// Not an epoch suffix: a 13-digit run is masked by the collector's card-number redaction.
export const SESSION_ID = `rn-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;

let started = false;

export function startTelemetry(): void {
  if (started) return;
  started = true;
  instrument({
    serviceName: 'genai-sdk-e2e-react-native',
    endpoint: COLLECTOR_ENDPOINT,
    // Flush when the app leaves the foreground: a backgrounded app can be
    // suspended or killed without notice.
    appState: AppState,
  });
  // React Native cannot look a package up by name: hand the classes over.
  instrumentCactus({ CactusLM, CactusSTT });
  setSession(SESSION_ID);
}
