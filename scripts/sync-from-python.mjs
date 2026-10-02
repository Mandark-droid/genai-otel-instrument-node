#!/usr/bin/env node
/**
 * Vendor the cross-language contract and the pricing table from the Python
 * reference implementation (genai_otel_instrument).
 *
 * THE PIN LIVES HERE AND NOWHERE ELSE. Bumping the Python reference is: change
 * PYTHON_TAG, run `npm run sync`, run the tests, fix what broke.
 *
 *   node scripts/sync-from-python.mjs            copy from the source directory
 *   node scripts/sync-from-python.mjs --check    verify, exit 1 on drift
 *
 * Options:
 *   --from <dir>   contract source directory. Default: $GENAI_SDK_CONTRACT_DIR,
 *                  else ../_staging/sdk-contract-<tag> next to this repository.
 *   --dest <dir>   repository root to write into (tests use this).
 *
 * The source directory is produced by scripts/generate_sdk_contract.py in the
 * Python repository at the pinned tag. It holds the contract files listed in
 * MANIFEST.json, MANIFEST.json itself, SCHEMA.md and llm_pricing.json.
 *
 * `--check` verifies three things:
 *   1. the vendored MANIFEST was generated from the pinned tag;
 *   2. every vendored file still hashes to what that MANIFEST recorded, so a
 *      hand edit to contract/* or to the pricing file is caught even where the
 *      source directory does not exist (CI);
 *   3. when the source directory IS present, that it has not moved on from what
 *      is vendored.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PYTHON_TAG = 'v1.30.0';

const PRICING_FILE = 'llm_pricing.json';
const MANIFEST_FILE = 'MANIFEST.json';
/** Carried along for the reader; hashed only if the manifest lists it. */
const OPTIONAL_FILES = ['SCHEMA.md', 'PORTING_NOTES.md', 'SDK_ADDITIONS.md'];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseArgs(argv) {
  const args = { check: false, from: undefined, dest: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--from') args.from = argv[(i += 1)];
    else if (arg === '--dest') args.dest = resolve(argv[(i += 1)]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  args.from = resolve(
    args.from ?? process.env.GENAI_SDK_CONTRACT_DIR ?? join(REPO_ROOT, '..', '_staging', `sdk-contract-${PYTHON_TAG}`),
  );
  return args;
}

function readManifest(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || typeof manifest.sha256 !== 'object' || manifest.sha256 === null) {
    throw new Error(`${path}: not a contract manifest (no "sha256" map)`);
  }
  return manifest;
}

/** Where a file named in the manifest lands inside the repository. */
function vendoredPath(dest, name) {
  return name === PRICING_FILE ? join(dest, 'src', 'pricing', PRICING_FILE) : join(dest, 'contract', name);
}

/** [name, expected sha256] for everything the manifest pins, pricing included. */
function pinnedFiles(manifest) {
  const pinned = new Map(Object.entries(manifest.sha256));
  if (typeof manifest.pricing_sha256 === 'string') pinned.set(PRICING_FILE, manifest.pricing_sha256);
  return [...pinned.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function verifyTag(manifest, where, problems) {
  if (manifest.python_tag !== PYTHON_TAG) {
    problems.push(`${where}: generated from ${manifest.python_tag}, but this repository pins ${PYTHON_TAG}`);
  }
}

function sync({ from, dest }) {
  const problems = [];
  const manifestPath = join(from, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `contract source not found: ${manifestPath}\n` +
        `Generate it in the Python repository at ${PYTHON_TAG} (scripts/generate_sdk_contract.py), ` +
        'or pass --from <dir> / set GENAI_SDK_CONTRACT_DIR.',
    );
  }
  const manifest = readManifest(manifestPath);
  verifyTag(manifest, manifestPath, problems);

  // Verify the source against its own manifest BEFORE copying anything, so a
  // half-written staging directory never lands in the repository.
  for (const [name, expected] of pinnedFiles(manifest)) {
    const source = join(from, name);
    if (!existsSync(source)) problems.push(`${name}: listed in the manifest but missing from ${from}`);
    else if (sha256(source) !== expected) problems.push(`${name}: source does not match its manifest sha256`);
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));

  mkdirSync(join(dest, 'contract'), { recursive: true });
  mkdirSync(join(dest, 'src', 'pricing'), { recursive: true });
  const copied = [];
  for (const [name] of pinnedFiles(manifest)) {
    copyFileSync(join(from, name), vendoredPath(dest, name));
    copied.push(name);
  }
  for (const name of OPTIONAL_FILES) {
    if (existsSync(join(from, name)) && !copied.includes(name)) {
      copyFileSync(join(from, name), join(dest, 'contract', name));
      copied.push(name);
    }
  }
  copyFileSync(manifestPath, join(dest, 'contract', MANIFEST_FILE));
  copied.push(MANIFEST_FILE);
  console.log(`synced ${copied.length} files from ${from} (${PYTHON_TAG}): ${copied.join(', ')}`);
}

function check({ from, dest }) {
  const problems = [];
  const vendoredManifestPath = join(dest, 'contract', MANIFEST_FILE);
  if (!existsSync(vendoredManifestPath)) {
    throw new Error(`contract/${MANIFEST_FILE} is missing: nothing has been vendored. Run \`npm run sync\`.`);
  }
  const vendored = readManifest(vendoredManifestPath);
  verifyTag(vendored, `contract/${MANIFEST_FILE}`, problems);

  for (const [name, expected] of pinnedFiles(vendored)) {
    const path = vendoredPath(dest, name);
    if (!existsSync(path)) problems.push(`${name}: vendored file is missing`);
    else if (sha256(path) !== expected) {
      problems.push(`${name}: vendored file does not match contract/${MANIFEST_FILE} (edited by hand?)`);
    }
  }

  const sourceManifestPath = join(from, MANIFEST_FILE);
  if (existsSync(sourceManifestPath)) {
    const source = readManifest(sourceManifestPath);
    verifyTag(source, sourceManifestPath, problems);
    const want = new Map(pinnedFiles(source));
    const have = new Map(pinnedFiles(vendored));
    for (const name of new Set([...want.keys(), ...have.keys()])) {
      if (want.get(name) !== have.get(name)) problems.push(`${name}: drift between ${from} and the vendored copy`);
    }
  } else {
    console.log(`source ${from} not available; checked the vendored tree against its own manifest only`);
  }

  if (problems.length > 0) throw new Error(problems.join('\n'));
  console.log(`contract and pricing match ${PYTHON_TAG} (${pinnedFiles(vendored).length} files)`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) check(args);
  else sync(args);
} catch (error) {
  console.error(`sync-from-python: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
