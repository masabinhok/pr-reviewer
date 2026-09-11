import { execSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { testDatabaseUrl, testRedisUrl } from './helpers/test-env.js';

/**
 * Runs once before the e2e suite: bring the test database's schema up to date, and start
 * from an empty test Redis — no queued jobs or cached tokens left by an earlier run.
 */
export default async function setup() {
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'pipe',
  });

  const redis = new Redis(testRedisUrl());
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}
