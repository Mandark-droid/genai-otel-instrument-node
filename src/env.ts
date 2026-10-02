/**
 * The environment the runtime-agnostic core reads its settings from.
 *
 * The core never touches `process.env`: a browser and React Native have no
 * process environment. Whoever owns the runtime supplies one - the Node entry
 * passes `process.env` (src/node-env.ts), the browser and React Native entries
 * pass what the application gave `instrument({...})`. Until someone does, it is
 * empty and every setting takes its default.
 */
export type Env = Record<string, string | undefined>;

let ambient: Env = {};

export function setAmbientEnv(env: Env): void {
  ambient = env;
}

export function ambientEnv(): Env {
  return ambient;
}
