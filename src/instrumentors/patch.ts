/**
 * Locating and patching the client libraries.
 *
 * The provider SDKs ship as CommonJS and as ES modules, and the two builds
 * define separate class objects: `require('openai').OpenAI` is not the class
 * `import('openai')` gives. Patching one silently leaves an application that
 * uses the other untraced, so both are located and both are patched.
 *
 * Methods are patched on the resource class prototype, so a client constructed
 * before `instrument()` ran is traced too.
 *
 * Nothing is loaded in order to be patched (Node 20 and later): a library is
 * patched when the application loads it, or at once if it already has. An
 * application does not pay for the libraries it has installed and never uses.
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
          // An ES-module-only package's single entry is the ES module; a `.cjs` file never is.
          if ((manifest.type === 'module' && !resolved.endsWith('.cjs')) || resolved.endsWith('.mjs')) entries.add(resolved);
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
  /** Hear of each CommonJS copy loaded from now on. Returns a function that stops listening. */
  whenLoaded(listener: (module: unknown) => void): () => void;
}

/**
 * Whether the application's entry point is an ES module: by its extension,
 * else by the `type` of the nearest package.json; `--input-type=module` for
 * code given on the command line.
 */
export function applicationIsEsModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return process.execArgv.some((arg) => arg === '--input-type=module');
  if (/\.mjs$|\.mts$/i.test(entry)) return true;
  if (/\.cjs$|\.cts$/i.test(entry)) return false;
  let dir = dirname(entry);
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        return (JSON.parse(readFileSync(manifest, 'utf8')) as { type?: unknown }).type === 'module';
      } catch {
        return false;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** `require()` refused because the package, or the entry asked for, is an ES module. */
const REQUIRE_OF_ESM: ReadonlySet<string> = new Set(['ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE', 'ERR_PACKAGE_PATH_NOT_EXPORTED']);

// --- patching on load ----------------------------------------------------------------

type LoadListener = (module: unknown) => void;

/** Who wants to hear of a package being loaded: by the name the application requires, and by resolved file. */
const byRequest = new Map<string, Set<LoadListener>>();
const byFile = new Map<string, Set<LoadListener>>();
let hookInstalled = false;

/** Packages currently watched. For tests. */
export function watchedPackageCount(): number {
  return byRequest.size;
}

interface ModuleInternals {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
}

/**
 * One hook on CommonJS loading, installed once. Every `require()` - and every
 * ES-module `import` of a CommonJS package, which Node routes through the same
 * function (checked on Node 18, 20, 22 and 24) - passes through it; a load of a
 * watched package is announced after it completed. Nothing else is changed:
 * the module the application gets is the one it would have got.
 */
function installLoadHook(): void {
  if (hookInstalled) return;
  const Module = createRequire(import.meta.url)('node:module') as ModuleInternals;
  const original = Module._load;
  Module._load = function load(this: unknown, request: string, _parent: unknown, _isMain: boolean): unknown {
    // eslint-disable-next-line prefer-rest-params
    const exported = original.apply(this, arguments as unknown as [string, unknown, boolean]);
    if (byRequest.size > 0) {
      const listeners = byRequest.get(request) ?? byFile.get(request);
      if (listeners) {
        for (const listener of [...listeners]) {
          try {
            listener(exported);
          } catch (error) {
            logger.debug(`Patching ${request} on load failed: ${String(error)}`);
          }
        }
      }
    }
    return exported;
  };
  hookInstalled = true;
}

function listen(table: Map<string, Set<LoadListener>>, key: string, listener: LoadListener): () => void {
  let set = table.get(key);
  if (!set) table.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    const current = table.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) table.delete(key);
  };
}

/**
 * Node 18 cannot be lazy safely: an ES-module import of a library that fails
 * on it (anything built for a newer Node) surfaces as an unhandled rejection,
 * and the CommonJS load done first is what tells such a library apart.
 */
const EAGER = Number(process.versions.node.split('.')[0]) < 20;

/**
 * The copies of a package this process has or will have, without loading any
 * of them on Node 20 and later:
 *
 * - `commonjs`: the CommonJS copies the application already loaded;
 * - `whenLoaded(listener)`: called with each CommonJS copy the application
 *   loads from now on - by `require()`, or by an `import` of a CommonJS
 *   package. Returns a function that stops listening;
 * - `esm`: for an ES-module application, the package's ES-module build,
 *   imported - an application that `import`s the package has it loaded
 *   already, so this costs it nothing; a CommonJS application only reaches
 *   that build through a dynamic `import()`, and it is not loaded for it.
 *
 * On Node 18 both builds are loaded at once, as before.
 */
export function loadModuleCopies(name: string, options: { single?: boolean } = {}): ModuleCopies {
  if (EAGER) return loadEagerly(name, options);
  const commonjs: unknown[] = [];
  const files = new Set<string>();
  const esmUrls = new Set<string>();
  const esmApplication = applicationIsEsModule();
  for (const resolver of resolvers()) {
    let resolved: string;
    try {
      resolved = resolver.resolve(name);
    } catch {
      continue;
    }
    files.add(resolved);
    const cached = resolver.cache[resolved];
    if (cached?.loaded && !commonjs.includes(cached.exports)) commonjs.push(cached.exports);
    if (esmApplication) for (const entry of esmEntries(name, resolved)) esmUrls.add(pathToFileURL(entry).href);
  }
  if (files.size === 0) {
    logger.debug(`${name} is not installed, instrumentation will be skipped`);
    return { commonjs, esm: Promise.resolve([]), whenLoaded: () => () => undefined };
  }
  // `single`: a library that refuses to be loaded both ways; only the application's own copy.
  const esm = options.single && !esmApplication ? Promise.resolve([]) : importAll(name, esmUrls);
  return {
    commonjs,
    esm,
    whenLoaded(listener) {
      installLoadHook();
      const disposers = [listen(byRequest, name, listener), ...[...files].map((file) => listen(byFile, file, listener))];
      return () => {
        for (const dispose of disposers) dispose();
      };
    },
  };
}

function importAll(name: string, urls: Set<string>): Promise<unknown[]> {
  return (async (): Promise<unknown[]> => {
    const loaded: unknown[] = [];
    for (const url of urls) {
      try {
        const module: unknown = await import(url);
        if (!loaded.includes(module)) loaded.push(module);
      } catch (error) {
        logger.debug(`Could not load the ES-module build of ${name}: ${String(error)}`);
      }
    }
    return loaded;
  })();
}

/** Node 18: load every copy now. Exported for tests. */
export function loadEagerly(name: string, options: { single?: boolean } = {}): ModuleCopies {
  const commonjs: unknown[] = [];
  const esmUrls = new Set<string>();
  // `single`: the library refuses to be loaded both ways in one process, so
  // only the copy the application itself uses is loaded.
  const esmOnly = options.single === true && applicationIsEsModule();

  for (const resolver of resolvers()) {
    let resolved: string;
    try {
      resolved = resolver.resolve(name);
    } catch {
      continue;
    }
    if (esmOnly) {
      const entries = esmEntries(name, resolved);
      for (const entry of entries) esmUrls.add(pathToFileURL(entry).href);
      // A package with no ES-module build is the CommonJS one to an ES-module application too.
      if (entries.length > 0) continue;
    }
    try {
      const loaded: unknown = resolver(name);
      if (!commonjs.includes(loaded)) commonjs.push(loaded);
    } catch (error) {
      logger.debug(`Could not load the CommonJS build of ${name}: ${String(error)}`);
      // An ES-module-only package on a Node that cannot require() one is reached
      // through import() below. Anything else is the library failing to run on
      // this runtime (built for a newer Node, say): its ES-module build would
      // fail the same way, and on Node 18 that failure can surface as an
      // unhandled rejection in the application. It is left alone.
      if (!REQUIRE_OF_ESM.has(String((error as { code?: unknown } | null)?.code))) continue;
    }
    if (options.single && commonjs.length > 0) continue;
    for (const entry of esmEntries(name, resolved)) esmUrls.add(pathToFileURL(entry).href);
  }
  if (commonjs.length === 0 && esmUrls.size === 0) logger.debug(`${name} is not installed, instrumentation will be skipped`);
  return { commonjs, esm: importAll(name, esmUrls), whenLoaded: () => () => undefined };
}

export { exportedClass, prototypeDefining, unwrapMethod, wrapMethod } from './wrap';
