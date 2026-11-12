import { config } from 'dotenv';

config({ path: '../../.env' });

import { readFileSync } from 'node:fs';
import { PrismaService } from '../prisma/prisma.service.js';
import { DEMO_DATA_PATH, parseDemo, seedDemo } from './demo-data.js';

/**
 * Loads prisma/demo/data.json into DATABASE_URL. Install the App on the repos first: history
 * lands only under a repo the database already has. Safe to run again.
 *
 * Usage: npm run demo:seed
 */
async function main() {
  const prisma = new PrismaService();
  console.log(`seeding ${new URL(process.env.DATABASE_URL ?? '').host}`);
  try {
    const data = parseDemo(readFileSync(DEMO_DATA_PATH, 'utf8'));
    const { seeded, skipped } = await seedDemo(prisma, data);
    for (const line of seeded) console.log(line);
    for (const name of skipped)
      console.log(`skipped ${name}: the App isn't installed on it here`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
