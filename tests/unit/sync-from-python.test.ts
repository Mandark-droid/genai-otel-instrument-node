import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../scripts/sync-from-python.mjs');
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function run(args: string[]): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

describe('scripts/sync-from-python', () => {
  let staging: string;
  let dest: string;
  const files: Record<string, string> = {
    'semconv.json': '{"attributes":[]}\n',
    'metrics.json': '[]\n',
    'config.json': '[]\n',
  };
  const pricing = '{"chat":{"m":{"promptPrice":1,"completionPrice":2}}}\n';

  function writeStaging(tag = 'v1.30.0'): void {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(staging, name), text);
    writeFileSync(join(staging, 'llm_pricing.json'), pricing);
    writeFileSync(join(staging, 'SCHEMA.md'), '# schema\n');
    const manifest = {
      python_tag: tag,
      generated_at: '2026-10-02T00:00:00Z',
      sha256: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha(text)])),
      pricing_sha256: sha(pricing),
    };
    writeFileSync(join(staging, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  }

  beforeEach(() => {
    staging = mkdtempSync(join(tmpdir(), 'sync-src-'));
    dest = mkdtempSync(join(tmpdir(), 'sync-dest-'));
    mkdirSync(join(dest, 'contract'), { recursive: true });
    mkdirSync(join(dest, 'src', 'pricing'), { recursive: true });
    writeStaging();
  });

  afterEach(() => {
    rmSync(staging, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it('vendors the contract files and the pricing file byte for byte', () => {
    const { status, out } = run(['--from', staging, '--dest', dest]);
    expect(status, out).toBe(0);
    for (const [name, text] of Object.entries(files)) {
      expect(readFileSync(join(dest, 'contract', name), 'utf8')).toBe(text);
    }
    expect(readFileSync(join(dest, 'src', 'pricing', 'llm_pricing.json'), 'utf8')).toBe(pricing);
    expect(JSON.parse(readFileSync(join(dest, 'contract', 'MANIFEST.json'), 'utf8')).python_tag).toBe('v1.30.0');
    expect(readFileSync(join(dest, 'contract', 'SCHEMA.md'), 'utf8')).toBe('# schema\n');
  });

  it('--check passes on a clean vendored tree', () => {
    expect(run(['--from', staging, '--dest', dest]).status).toBe(0);
    const { status, out } = run(['--check', '--from', staging, '--dest', dest]);
    expect(status, out).toBe(0);
  });

  it('--check passes without the source directory (CI) when the vendored tree is self-consistent', () => {
    expect(run(['--from', staging, '--dest', dest]).status).toBe(0);
    const { status, out } = run(['--check', '--from', join(staging, 'does-not-exist'), '--dest', dest]);
    expect(status, out).toBe(0);
    expect(out).toMatch(/source .* not available/i);
  });

  it('--check exits non-zero when a vendored contract file was edited by hand', () => {
    expect(run(['--from', staging, '--dest', dest]).status).toBe(0);
    writeFileSync(join(dest, 'contract', 'metrics.json'), '[{"name":"hand.edited"}]\n');
    const { status, out } = run(['--check', '--from', staging, '--dest', dest]);
    expect(status).toBe(1);
    expect(out).toMatch(/metrics\.json/);
  });

  it('--check exits non-zero when the vendored pricing file was edited by hand', () => {
    expect(run(['--from', staging, '--dest', dest]).status).toBe(0);
    writeFileSync(join(dest, 'src', 'pricing', 'llm_pricing.json'), '{"chat":{}}\n');
    const { status, out } = run(['--check', '--from', staging, '--dest', dest]);
    expect(status).toBe(1);
    expect(out).toMatch(/llm_pricing\.json/);
  });

  it('--check exits non-zero when the source has moved on from what is vendored', () => {
    expect(run(['--from', staging, '--dest', dest]).status).toBe(0);
    files['metrics.json'] = '[{"name":"new.metric"}]\n';
    writeStaging();
    const { status, out } = run(['--check', '--from', staging, '--dest', dest]);
    expect(status).toBe(1);
    expect(out).toMatch(/drift/i);
    files['metrics.json'] = '[]\n';
  });

  it('--check exits non-zero when nothing has been vendored yet', () => {
    const { status, out } = run(['--check', '--from', staging, '--dest', dest]);
    expect(status).toBe(1);
    expect(out).toMatch(/MANIFEST\.json/);
  });

  it('refuses a source generated from a different Python tag', () => {
    writeStaging('v1.29.0');
    const { status, out } = run(['--from', staging, '--dest', dest]);
    expect(status).toBe(1);
    expect(out).toMatch(/v1\.29\.0/);
    expect(out).toMatch(/v1\.30\.0/);
  });

  it('refuses a source whose file does not match its own manifest hash', () => {
    writeFileSync(join(staging, 'config.json'), '[{"tampered":true}]\n');
    const { status, out } = run(['--from', staging, '--dest', dest]);
    expect(status).toBe(1);
    expect(out).toMatch(/config\.json/);
  });

  it('fails clearly when the source directory is missing on a sync', () => {
    const { status, out } = run(['--from', join(staging, 'nope'), '--dest', dest]);
    expect(status).toBe(1);
    expect(out).toMatch(/not found/i);
  });
});
