// Type-check the optional ONNX add-on (onnx/) when its dependencies are installed
// (`cd onnx && npm ci`). It is a package of its own: a checkout without them skips it.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, 'onnx', 'node_modules', 'onnxruntime-node'))) {
  console.log('onnx/: dependencies not installed (cd onnx && npm ci); not type-checked');
  process.exit(0);
}
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', join(root, 'onnx', 'tsconfig.json')], { stdio: 'inherit' });
