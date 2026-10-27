/**
 * The built browser and React Native entries contain no Node built-in, no
 * `process`, and (React Native) no DOM global - and the check that says so
 * does fail when one is there.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Target {
  name: string;
  file: string;
  conditions: string[];
  mainFields: string[];
  forbidDom: boolean;
}
interface Checker {
  TARGETS: Target[];
  checkEntry(target: Target): Promise<string[]>;
}

let checker: Checker;
let scratch: string;

beforeAll(async () => {
  const script = resolve(__dirname, '../../scripts/check-browser-bundle.mjs');
  checker = (await import(pathToFileURL(script).href)) as Checker;
  scratch = mkdtempSync(join(tmpdir(), 'genai-bundle-check-'));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function probe(name: string, source: string, forbidDom = false): Promise<string[]> {
  const file = join(scratch, name);
  writeFileSync(file, source);
  return checker.checkEntry({ name, file, conditions: ['browser'], mainFields: ['browser', 'module', 'main'], forbidDom });
}

describe('built entries for runtimes without Node', () => {
  it('covers the browser and the React Native entry', () => {
    expect(checker.TARGETS.map((target) => target.name)).toEqual(['browser', 'react-native']);
  });

  it.each(['browser', 'react-native'])('%s entry is clean', async (name) => {
    const target = checker.TARGETS.find((candidate) => candidate.name === name) as Target;
    expect(await checker.checkEntry(target)).toEqual([]);
  }, 60000);
});

describe('the check fails when it should', () => {
  it('an import of a Node built-in', async () => {
    expect((await probe('fs.mjs', "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n")).join('\n')).toMatch(/node:fs/);
    expect((await probe('net.mjs', "import net from 'net';\nexport const x = net;\n")).join('\n')).toMatch(/"net"/);
  });

  it('a read of process', async () => {
    expect(await probe('env.mjs', 'export const x = process.env.HOME;\n')).toEqual([expect.stringContaining('reads `process`')]);
  });

  it('the word in a comment or a string is not a read', async () => {
    expect(await probe('prose.mjs', "// process.env is not read here\nexport const x = 'process.env';\n")).toEqual([]);
  });

  it('a DOM global, where the DOM is forbidden', async () => {
    const source = 'export const x = () => document.title;\n';
    expect(await probe('dom.mjs', source, true)).toEqual([expect.stringContaining('`document`')]);
    expect(await probe('dom-ok.mjs', source, false)).toEqual([]);
  });

  it('an entry that was never built', async () => {
    const findings = await checker.checkEntry({ name: 'x', file: join(scratch, 'nope.mjs'), conditions: [], mainFields: [], forbidDom: false });
    expect(findings).toEqual([expect.stringContaining('does not exist')]);
  });
});

describe('conditional exports', () => {
  const load = (flags: string[], script: string): string => {
    const result = spawnSync(process.execPath, [...flags, '-e', script], { cwd: resolve(__dirname, '../..'), encoding: 'utf8' });
    return `${result.stdout}${result.stderr}`.trim();
  };
  const esm = "const m = await import('@traceverse/genai-otel-instrument-node'); console.log(typeof m.instrument, typeof m.traceGenAiCall, 'OpenAIInstrumentor' in m);";
  const cjs = "const m = require('@traceverse/genai-otel-instrument-node'); console.log(typeof m.instrument, typeof m.traceGenAiCall, 'OpenAIInstrumentor' in m);";

  it('Node gets the Node entry by default', () => {
    expect(load(['--input-type=module'], esm)).toBe('function undefined true');
    expect(load([], cjs)).toBe('function undefined true');
  });

  it('the browser condition gets the browser entry', () => {
    expect(load(['--conditions=browser', '--input-type=module'], esm)).toBe('function function false');
  });

  it('the react-native condition gets the React Native entry, ahead of browser', () => {
    expect(load(['--conditions=react-native', '--conditions=browser'], cjs)).toBe('function function false');
  });

  it('both are also reachable by subpath', () => {
    const script = "console.log(typeof require('@traceverse/genai-otel-instrument-node/react-native').traceGenAiCall);";
    expect(load([], script)).toBe('function');
  });
});
