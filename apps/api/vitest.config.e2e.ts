import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { TEST_WEBHOOK_SECRET, testDatabaseUrl } from './test/helpers/test-env.js';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Set before any test file loads, so these win over .env everywhere — in
    // PrismaService, in ConfigModule, and in the signing helper.
    env: {
      DATABASE_URL: testDatabaseUrl(),
      GITHUB_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    },
    // One database, shared by every file: run files one at a time so one file's
    // truncate can never land in the middle of another file's test.
    fileParallelism: false,
  },
});
