import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The Nest module reaches SES through a self-referencing dynamic import
      // so the AWS SDK is never loaded unless SES is actually configured.
      // In source mode there is no installed package to resolve it against.
      'sendrail/ses': fileURLToPath(new URL('./src/ses.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // Report on every source file, not just the ones a test happened to
      // import — otherwise an entirely untested module is invisible rather than
      // showing as 0%.
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        // Barrels: re-exports with no behaviour of their own.
        'src/**/index.ts',
        'src/index.ts',
        'src/ses.ts',
        'src/nest.ts',
        'src/express.ts',
        'src/testing.ts',
        // Declaration-only modules. These compile to an empty file, so v8
        // reports them as 0% covered no matter what — counting them would make
        // the threshold measure how many interfaces we have.
        'src/ports/delivery-log.store.ts',
        'src/ports/suppression.store.ts',
        'src/ports/transport.ts',
        'src/feedback/parser.ts',
        'src/nest/email-module-options.ts',
      ],
      reporter: ['text', 'html'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
