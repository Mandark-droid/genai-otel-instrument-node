import { defineConfig } from 'tsup';

const shared = {
  target: 'node18',
  platform: 'node',
  dts: true,
  sourcemap: true,
  // import.meta.url in the CJS build, __dirname in the ESM build.
  shims: true,
  // Each entry is self-contained. Module state that must be shared between the
  // two entries (and between the CJS and ESM copies of this package) lives on a
  // global-symbol registry, see src/state.ts.
  splitting: false,
} as const;

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts', register: 'src/register.ts' },
    format: ['cjs'],
    clean: true,
  },
  {
    ...shared,
    // The ESM register hook uses top-level await, which CommonJS cannot express.
    entry: { index: 'src/index.ts', register: 'src/register.esm.ts' },
    format: ['esm'],
    clean: false,
  },
  {
    // Browser: ES modules only, so a bundler can tree-shake it.
    entry: { 'index.browser': 'src/index.browser.ts' },
    format: ['esm'],
    platform: 'browser',
    target: 'es2020',
    dts: true,
    sourcemap: true,
    splitting: false,
    clean: false,
  },
  {
    // React Native: CommonJS, which Metro resolves without configuration.
    entry: { 'index.react-native': 'src/index.react-native.ts' },
    format: ['cjs'],
    platform: 'neutral',
    // Optional modules of the app, required at run time (see optionalModule).
    external: ['react-native', 'cactus-react-native'],
    target: 'es2020',
    dts: true,
    sourcemap: true,
    splitting: false,
    clean: false,
  },
]);
