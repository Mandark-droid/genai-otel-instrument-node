#!/usr/bin/env node
/**
 * The browser and React Native entries must run where there is no Node.
 *
 * For each built entry this:
 *   1. bundles it with esbuild for `platform: 'browser'`, dependencies included.
 *      esbuild cannot resolve a Node built-in on that platform, so an import of
 *      `fs`, `node:net`, ... anywhere in the graph fails the build;
 *   2. scans the bundle for a surviving `node:` specifier or a `require()` of a
 *      built-in;
 *   3. scans OUR built file (dependencies external) for `process.` and, for
 *      React Native, for DOM globals.
 *
 * Usage: node scripts/check-browser-bundle.mjs        (after `npm run build`)
 * Exits 1 on any finding.
 */
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILTINS = builtinModules.filter((name) => !name.startsWith('_'));

export const TARGETS = [
  {
    name: 'browser',
    file: 'dist/index.browser.mjs',
    conditions: ['browser', 'import'],
    mainFields: ['browser', 'module', 'main'],
    forbidDom: false,
  },
  {
    name: 'react-native',
    file: 'dist/index.react-native.js',
    conditions: ['react-native', 'browser', 'require'],
    mainFields: ['react-native', 'browser', 'main'],
    forbidDom: true,
  },
];

/** Strip comments and string/template literals, so prose and data cannot trip the scans. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
}

/**
 * @param {{name: string, file: string, conditions: string[], mainFields: string[], forbidDom: boolean}} target
 * @returns {Promise<string[]>} findings; empty when the entry is clean
 */
export async function checkEntry(target) {
  const findings = [];
  const entry = resolve(ROOT, target.file);
  let own;
  try {
    own = readFileSync(entry, 'utf8');
  } catch {
    return [`${target.file} does not exist: run \`npm run build\` first`];
  }

  let bundled = '';
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      conditions: target.conditions,
      mainFields: target.mainFields,
      logLevel: 'silent',
    });
    bundled = result.outputFiles[0].text;
  } catch (error) {
    for (const problem of error.errors ?? [{ text: String(error) }]) {
      const where = problem.location ? ` (${problem.location.file}:${problem.location.line})` : '';
      findings.push(`cannot be bundled for a browser: ${problem.text}${where}`);
    }
    return findings;
  }

  const specifiers = new Set();
  for (const match of bundled.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)) {
    specifiers.add(match[1]);
  }
  for (const specifier of specifiers) {
    if (specifier.startsWith('node:') || BUILTINS.includes(specifier)) {
      findings.push(`the bundle still imports the Node built-in "${specifier}"`);
    }
  }

  const code = codeOnly(own);
  if (/\bprocess\s*\.\s*[A-Za-z_]/.test(code)) findings.push(`${target.file} reads \`process\``);
  if (/\b__dirname\b|\b__filename\b/.test(code)) findings.push(`${target.file} uses __dirname / __filename`);
  if (target.forbidDom) {
    const dom = code.match(/\b(document|window|navigator|localStorage|sessionStorage)\s*\./);
    if (dom) findings.push(`${target.file} uses the DOM global \`${dom[1]}\``);
  }
  return findings;
}

async function main() {
  let failed = false;
  for (const target of TARGETS) {
    const findings = await checkEntry(target);
    if (findings.length === 0) {
      console.log(`PASS ${target.name}: ${target.file} has no Node built-in, no process${target.forbidDom ? ', no DOM' : ''}`);
    } else {
      failed = true;
      for (const finding of findings) console.error(`FAIL ${target.name}: ${finding}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
