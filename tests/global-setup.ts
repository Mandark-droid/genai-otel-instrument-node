/**
 * Build the package once before the test run.
 *
 * `tests/e2e/*` run the example programs as child processes; those import the
 * package by name, which resolves to `dist/`. Building here, once, rather than
 * in each test file keeps two files from rebuilding `dist/` under each other.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export default function setup(): void {
  const root = resolve(__dirname, '..');
  execFileSync(process.execPath, [resolve(root, 'scripts/generate-contract-code.mjs')], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, [resolve(root, 'node_modules/tsup/dist/cli-default.js'), '--silent'], {
    cwd: root,
    stdio: 'inherit',
  });
}
