/**
 * Node only: the core's settings come from the process environment.
 *
 * Imported for its side effect by every Node-only module, before anything that
 * reads a setting.
 */
import { setAmbientEnv } from './env';

setAmbientEnv(process.env);
