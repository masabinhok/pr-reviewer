import { config } from 'dotenv';

config({ path: '../../.env', quiet: true });

/**
 * The e2e suite runs against its own database, `pr_reviewer_test` (created by
 * init.sql on the first `docker compose up`), so truncating tables between tests can
 * never touch what you have recorded through smee. Same server and credentials as
 * DATABASE_URL, different database name — or set TEST_DATABASE_URL to override.
 */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — copy .env.example to .env at the repo root');
  }
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/pr_reviewer_test';
  return url.toString();
}

/**
 * A fixed secret for the suite, so signatures in tests never depend on — or leak — the
 * real one. ConfigModule gives already-set process.env values precedence over .env.
 */
export const TEST_WEBHOOK_SECRET = 'e2e-webhook-secret';
