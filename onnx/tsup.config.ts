import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  target: 'node18',
  // The runtime is the application's to install with this package; never bundled.
  external: ['onnxruntime-node'],
});
