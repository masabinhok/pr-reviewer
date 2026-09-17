import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { TEST_WEBHOOK_SECRET, testDatabaseUrl, testRedisUrl } from './test/helpers/test-env.js';

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
      // Test jobs go to their own Redis keys, never to the queue a running dev server
      // is consuming — and a dev server's worker never picks up a test's job.
      QUEUE_PREFIX: 'pr-reviewer-test',
      REDIS_URL: testRedisUrl(),
      REVIEW_RETRY_DELAY_MS: '50',
      // Deterministic, free, offline. The agent path has its own tests.
      REVIEWER: 'stub',
      // The flows assert that high and medium are posted and low is not.
      POST_MIN_SEVERITY: 'medium',
      // Tests poll reactions by hand, when they choose.
      FEEDBACK_POLL_MS: '0',
    },
    // One database, shared by every file: run files one at a time so one file's
    // truncate can never land in the middle of another file's test.
    fileParallelism: false,
  },
});
