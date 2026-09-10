import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    ses: 'src/ses.ts',
    nest: 'src/nest.ts',
    express: 'src/express.ts',
    testing: 'src/testing.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // Off deliberately. Splitting would let esbuild hoist the AWS require out of
  // the Nest module's lazy branch into a shared chunk loaded eagerly — the exact
  // thing the dynamic import exists to prevent.
  splitting: false,
  treeshake: true,
  target: 'node18',
  // Self-reference: the Nest module resolves `sendrail/ses` at runtime through
  // this package's own exports map, so it must not be bundled.
  external: ['sendrail'],
});
