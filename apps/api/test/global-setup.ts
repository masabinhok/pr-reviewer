import { execSync } from 'node:child_process';
import { testDatabaseUrl } from './helpers/test-env.js';

/** Runs once before the e2e suite: bring the test database's schema up to date. */
export default function setup() {
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'pipe',
  });
}
