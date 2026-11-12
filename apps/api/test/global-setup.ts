import { execSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { testDatabaseUrl, testRedisUrl } from './helpers/test-env.js';

/**
 * Runs once before the e2e suite: bring the test database's schema up to date, and start
 * from an empty test Redis — no queued jobs or cached tokens left by an earlier run.
 */
export default async function setup() {
  // Both: prisma7.config.ts prefers DIRECT_DATABASE_URL, which in a .env may be a hosted database.
  const url = testDatabaseUrl();
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
    stdio: 'pipe',
  });

  const redis = new Redis(testRedisUrl());
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}
