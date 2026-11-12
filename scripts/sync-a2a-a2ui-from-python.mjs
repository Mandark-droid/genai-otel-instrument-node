#!/usr/bin/env node
/**
 * Vendor the A2A and A2UI names from the Python reference implementation as a SCOPED
 * addition to the contract (decision A2UI-D8).
 *
 * The rest of `contract/` is pinned to one Python tag (scripts/sync-from-python.mjs). The A2A
 * and A2UI instrumentation first shipped in Python 1.47.0 and 1.48.0, after that pin, and a full
 * re-pin would also bring in unrelated 1.46.x to 1.48.0 changes. So this script reads ONLY the
 * attribute modules (`genai_otel/a2a_semconv/attributes.py`, `genai_otel/a2ui_semconv/attributes.py`),
 * the instrumentor's span names and the two configuration fields from one Python commit, and
 * writes `contract/a2a-a2ui.json`. `npm run generate` turns that file into
 * `src/a2a-a2ui.generated.ts`; nothing in the A2A / A2UI code types an attribute name by hand.
 *
 *   node scripts/sync-a2a-a2ui-from-python.mjs [--from <python repo>] [--rev <commit or tag>]
 *   node scripts/sync-a2a-a2ui-from-python.mjs --check
 *
 * `--check` verifies the vendored file against its own recorded hash (a hand edit is caught
 * where the Python repository does not exist, e.g. CI), and, when the Python repository is
 * present, that the pinned commit still produces exactly what is vendored.
 *
 * Python repository: `--from`, else `$GENAI_PYTHON_REPO`, else `../genai_otel_instrument`.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Python commit this addition was taken from (the 1.48.0 release commit). */
export const PYTHON_REV = '7762b71';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'contract', 'a2a-a2ui.json');

const SOURCES = {
  a2a: 'genai_otel/a2a_semconv/attributes.py',
  a2ui: 'genai_otel/a2ui_semconv/attributes.py',
  a2uiInstrumentor: 'genai_otel/a2ui_semconv/instrumentor.py',
  config: 'genai_otel/config.py',
};

function parseArgs(argv) {
  const args = { check: false, from: undefined, rev: PYTHON_REV };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--from') args.from = argv[(i += 1)];
    else if (arg === '--rev') args.rev = argv[(i += 1)];
    else throw new Error(`unknown argument: ${arg}`);
  }
  args.from = resolve(args.from ?? process.env.GENAI_PYTHON_REPO ?? join(ROOT, '..', 'genai_otel_instrument'));
  return args;
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** `  NAME: Final[str] = "value"` lines of a block, in order. */
function stringConstants(text) {
  const out = {};
  for (const match of text.matchAll(/^[ \t]*([A-Z][A-Z0-9_]*):\s*Final\[str\]\s*=\s*"([^"]*)"/gm)) out[match[1]] = match[2];
  return out;
}

/** The text of `class <name>:` up to the next top-level statement. */
function classBlock(text, name) {
  const start = text.search(new RegExp(`^class ${name}\\b`, 'm'));
  if (start < 0) throw new Error(`class ${name} not found`);
  const rest = text.slice(start).split('\n');
  const body = [rest[0]];
  for (const line of rest.slice(1)) {
    if (line !== '' && !/^[ \t#]/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/** `NAME = frozenset({ClassName.A, ClassName.B})` as ['A', 'B']. */
function contentKeys(text, className) {
  const match = text.match(/^CONTENT_KEYS\s*=\s*frozenset\(\s*\{([\s\S]*?)\}\s*\)/m);
  if (!match) throw new Error('CONTENT_KEYS not found');
  return [...match[1].matchAll(new RegExp(`${className}\\.([A-Z0-9_]+)`, 'g'))].map((m) => m[1]);
}

function moduleConstants(text) {
  // Module-level (unindented) string constants only.
  const out = {};
  for (const match of text.matchAll(/^([A-Z][A-Z0-9_]*):\s*Final\[str\]\s*=\s*"([^"]*)"/gm)) out[match[1]] = match[2];
  return out;
}

function tupleOfStrings(text, name) {
  const match = text.match(new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, 'm'));
  if (!match) throw new Error(`${name} not found`);
  return [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

function configField(text, env) {
  const at = text.indexOf(`os.getenv("${env}"`);
  if (at < 0) throw new Error(`${env} not found in config.py`);
  const start = text.lastIndexOf('\n', text.lastIndexOf('field(', at)) + 1;
  const end = text.indexOf('\n    )', at) + 6;
  const block = text.slice(start, end);
  const field = block.match(/^\s*([a-z0-9_]+):\s*bool/m)?.[1];
  const expression = block.match(/os\.getenv\("[A-Z0-9_]+",\s*"([^"]*)"\)([^\n]*)/);
  if (!field || !expression) throw new Error(`cannot read the field for ${env}`);
  return { env, field, type: 'bool', default: expression[1], expression: `os.getenv("${env}", "${expression[1]}")${expression[2].trim()}` };
}

function build(repo, rev) {
  const commit = git(repo, 'rev-parse', '--verify', `${rev}^{commit}`).trim();
  const show = (path) => git(repo, 'show', `${commit}:${path}`);
  const files = {};
  const text = {};
  for (const [key, path] of Object.entries(SOURCES)) {
    const content = show(path);
    text[key] = content;
    files[path] = sha256(content.replace(/\r\n/g, '\n'));
  }
  let describe = '';
  try {
    describe = git(repo, 'describe', '--tags', '--exact-match', commit).trim();
  } catch {
    describe = '';
  }

  const a2aText = text.a2a;
  const a2uiText = text.a2ui;
  const a2aModule = moduleConstants(a2aText);
  const a2uiModule = moduleConstants(a2uiText);
  const spanNames = [
    ...new Set(
      [...text.a2uiInstrumentor.matchAll(/(?:start_(?:as_current_)?span\(\s*|name = )f?"(a2ui\.[a-z_]+)[ "]/g)].map((m) => m[1]),
    ),
  ].sort();
  const swallowedEvent = text.a2uiInstrumentor.match(/^SWALLOWED_EVENT\s*=\s*"([^"]+)"/m)?.[1];
  const propagate = configField(text.config, 'GENAI_A2A_PROPAGATE');
  const enabled = configField(text.config, 'GENAI_A2UI_ENABLED');
  const defaults = text.config.match(/DEFAULT_INSTRUMENTORS[\s\S]*?\n\]/)?.[0] ?? '';
  const instrumentorIds = ['a2a', 'a2ui'].filter((id) => defaults.includes(`"${id}"`));

  const names = {
    a2a: {
      attributes: stringConstants(classBlock(a2aText, 'A2AAttributes')),
      content_keys: contentKeys(a2aText, 'A2AAttributes'),
      bindings: {
        jsonrpc: a2aModule.BINDING_JSONRPC,
        grpc: a2aModule.BINDING_GRPC,
        http_json: a2aModule.BINDING_HTTP_JSON,
      },
      operation_invoke_agent: a2aModule.OPERATION_INVOKE_AGENT,
    },
    a2ui: {
      attributes: stringConstants(classBlock(a2uiText, 'A2UIAttributes')),
      content_keys: contentKeys(a2uiText, 'A2UIAttributes'),
      extension_uri: a2uiModule.EXTENSION_URI,
      extension_uri_prefix: a2uiModule.EXTENSION_URI_PREFIX,
      mime_types: [a2uiModule.MIME_TYPE, a2uiModule.DEPRECATED_MIME_TYPE],
      capabilities_keys: tupleOfStrings(a2uiText, 'CAPABILITIES_KEYS'),
      error_event: a2uiModule.ERROR_EVENT,
      sides: { agent: a2uiModule.SIDE_AGENT, renderer: a2uiModule.SIDE_RENDERER },
      validation: { valid: a2uiModule.VALIDATION_VALID, invalid: a2uiModule.VALIDATION_INVALID },
      span_names: spanNames,
      validation_failed_event: swallowedEvent,
    },
    config: [propagate, enabled],
    instrumentor_ids: instrumentorIds,
  };
  for (const [group, value] of Object.entries(names)) {
    if (value === undefined || (typeof value === 'object' && Object.keys(value).length === 0)) throw new Error(`${group}: nothing read`);
  }
  if (names.instrumentor_ids.length !== 2) throw new Error('a2a and a2ui are not both in DEFAULT_INSTRUMENTORS at this commit');
  return {
    scoped_addition: 'A2A + A2UI names (decision A2UI-D8). Not part of MANIFEST.json; recorded in SDK_ADDITIONS.md.',
    python_commit: commit,
    python_tag: describe || null,
    source_sha256: files,
    names_sha256: sha256(JSON.stringify(names)),
    ...names,
  };
}

function stableSerialise(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const args = parseArgs(process.argv.slice(2));

if (args.check) {
  if (!existsSync(OUT)) {
    console.error(`${OUT} is missing`);
    process.exit(1);
  }
  const vendored = JSON.parse(readFileSync(OUT, 'utf8'));
  const { scoped_addition, python_commit, python_tag, source_sha256, names_sha256, ...names } = vendored;
  void scoped_addition;
  void python_tag;
  void source_sha256;
  let failed = false;
  if (sha256(JSON.stringify(names)) !== names_sha256) {
    console.error('contract/a2a-a2ui.json was edited by hand: its names no longer match the recorded hash');
    failed = true;
  }
  if (!/^[0-9a-f]{40}$/.test(python_commit)) {
    console.error('contract/a2a-a2ui.json does not record a full Python commit');
    failed = true;
  }
  if (existsSync(join(args.from, '.git'))) {
    try {
      // The tag may be cut after the commit was vendored, so it is not compared.
      const { python_tag: freshTag, ...fresh } = build(args.from, python_commit);
      void freshTag;
      const { python_tag: vendoredTag, ...rest } = vendored;
      void vendoredTag;
      if (stableSerialise(fresh) !== stableSerialise(rest)) {
        console.error(`the Python repository at ${python_commit} no longer produces what is vendored`);
        failed = true;
      }
    } catch (error) {
      console.error(`could not compare with the Python repository: ${error.message}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(`contract/a2a-a2ui.json is consistent (Python ${python_commit.slice(0, 7)})`);
} else {
  if (!existsSync(join(args.from, '.git'))) {
    console.error(`no Python repository at ${args.from}; pass --from or set GENAI_PYTHON_REPO`);
    process.exit(1);
  }
  const result = build(args.from, args.rev);
  writeFileSync(OUT, stableSerialise(result));
  console.log(`wrote contract/a2a-a2ui.json from Python ${result.python_commit.slice(0, 7)}`);
}
