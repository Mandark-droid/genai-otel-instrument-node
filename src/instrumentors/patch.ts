/**
 * Locating and patching the client libraries.
 *
 * The provider SDKs ship as CommonJS and as ES modules, and the two builds
 * define separate class objects: `require('openai').OpenAI` is not the class
 * `import('openai')` gives. Patching one silently leaves an application that
 * uses the other untraced, so both are located and both are patched.
 *
 * Methods are patched on the resource class prototype, which has two useful
 * consequences: a client constructed before `instrument()` ran is traced too,
 * and nothing depends on intercepting the module while it loads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../logger';

function resolvers(): NodeRequire[] {
  const out: NodeRequire[] = [];
  // The application's own dependency tree first - from its working directory
  // and from its entry script, which differ when it is started from elsewhere -
  // then this package's.
  const bases = [join(process.cwd(), 'noop.js'), process.argv[1], import.meta.url];
  for (const base of bases) {
    if (!base) continue;
    try {
      out.push(createRequire(base));
    } catch {
      // an unusable base is not an error
    }
  }
  return out;
}

/** The first string under `import` / `default` of a conditional-exports value. */
function importTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const conditions = value as Record<string, unknown>;
  // `node` first: a package may ship a separate build for it (@google/genai does).
  return importTarget(conditions.node) ?? importTarget(conditions.import) ?? importTarget(conditions.default);
}

/**
 * The files an ES-module `import` of the package would load, given where its
 * CommonJS entry resolved. Three layouts occur among the client libraries:
 * `index.mjs` next to `index.js`; an `exports["."].import` target elsewhere
 * (`dist/index.mjs` beside `dist/index.cjs`); and an ES-module-only package,
 * whose single entry is the ES module.
 */
function esmEntries(name: string, resolved: string): string[] {
  const entries = new Set<string>();
  const sibling = join(dirname(resolved), 'index.mjs');
  if (existsSync(sibling)) entries.add(sibling);

  // `@scope/pkg/sub/path.js` -> package `@scope/pkg`, subpath `./sub/path.js`.
  const segments = name.split('/');
  const packageName = name.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] as string);
  const rest = name.slice(packageName.length);
  const subpath = rest ? `.${rest}` : '.';

  // Walk up to the package's own package.json.
  let directory = dirname(resolved);
  for (let depth = 0; depth < 12; depth += 1) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; type?: string; exports?: unknown };
        if (manifest.name === packageName) {
          const target = importTarget(exportFor(manifest.exports, subpath));
          if (target) {
            const file = join(directory, target);
            // The same file as the CommonJS entry is not a second copy.
            if (file !== resolved && existsSync(file)) entries.add(file);
          }
          if (manifest.type === 'module' || resolved.endsWith('.mjs')) entries.add(resolved);
          break;
        }
      } catch {
        // an unreadable manifest is not an error
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return [...entries];
}

/** The `exports` entry for a subpath: an exact key, or a `./*` pattern with the match substituted. */
function exportFor(exportsField: unknown, subpath: string): unknown {
  if (typeof exportsField !== 'object' || exportsField === null) return subpath === '.' ? exportsField : undefined;
  const table = exportsField as Record<string, unknown>;
  // Conditions at the top level describe the root entry.
  if (!Object.keys(table).some((key) => key.startsWith('.'))) return subpath === '.' ? table : undefined;
  if (subpath in table) return table[subpath];
  for (const [pattern, value] of Object.entries(table)) {
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length) continue;
    return substitute(value, subpath.slice(prefix.length, subpath.length - suffix.length));
  }
  return undefined;
}

function substitute(value: unknown, match: string): unknown {
  if (typeof value === 'string') return value.replace('*', match);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, substitute(entry, match)]));
}

export interface ModuleCopies {
  /** CommonJS copies, available now. */
  commonjs: unknown[];
  /** ES-module copies; resolves to [] when there are none. Never rejects. */
  esm: Promise<unknown[]>;
}

/**
 * Every loadable copy of a package: the CommonJS build synchronously, the
 * ES-module build asynchronously (a dynamic `import()` is the only way to reach
 * it). A package that is not installed yields nothing and logs at debug level.
 */
export function loadModuleCopies(name: string): ModuleCopies {
  const commonjs: unknown[] = [];
  const esmUrls = new Set<string>();

  for (const resolver of resolvers()) {
    let resolved: string;
    try {
      resolved = resolver.resolve(name);
    } catch {
      continue;
    }
    try {
      const loaded: unknown = resolver(name);
      if (!commonjs.includes(loaded)) commonjs.push(loaded);
    } catch (error) {
      // An ES-module-only package on a Node that cannot require() one: reached through import() below.
      logger.debug(`Could not load the CommonJS build of ${name}: ${String(error)}`);
    }
    for (const entry of esmEntries(name, resolved)) esmUrls.add(pathToFileURL(entry).href);
  }
  if (commonjs.length === 0 && esmUrls.size === 0) logger.debug(`${name} is not installed, instrumentation will be skipped`);

  const esm = (async (): Promise<unknown[]> => {
    const loaded: unknown[] = [];
    for (const url of esmUrls) {
      try {
        const module: unknown = await import(url);
        if (!loaded.includes(module)) loaded.push(module);
      } catch (error) {
        logger.debug(`Could not load the ES-module build of ${name}: ${String(error)}`);
      }
    }
    return loaded;
  })();

  return { commonjs, esm };
}

export { exportedClass, prototypeDefining, unwrapMethod, wrapMethod } from './wrap';
