import { config } from 'dotenv';

config({ path: '../../.env' });

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DEMO_DATA_PATH,
  SECRET_SHAPE,
  stringifyDemo,
  type DemoData,
} from './demo-data.js';

/**
 * Writes the review history of every *public* repository in DATABASE_URL to
 * prisma/demo/data.json, for `demo:seed` to load into the hosted demo. Visibility is asked of
 * GitHub now, not read from the Repo row, which only knows what it was at install time.
 *
 * Usage: DATABASE_URL=<your local database> npm run demo:export
 */
async function isPublic(fullName: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${fullName}`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${fullName}`);
  return !((await res.json()) as { private: boolean }).private;
}

async function main() {
  const prisma = new PrismaService();
  console.log(`reading ${new URL(process.env.DATABASE_URL ?? '').host}`);
  try {
    const reviewed = await prisma.repo.findMany({
      where: { reviews: { some: {} } },
      select: { fullName: true },
    });
    const names: string[] = [];
    for (const { fullName } of reviewed) {
      if (await isPublic(fullName)) names.push(fullName);
      else console.log(`left out (not public): ${fullName}`);
    }

    const repos = await prisma.repo.findMany({
      where: { fullName: { in: names } },
      orderBy: { fullName: 'asc' },
      select: {
        githubId: true,
        fullName: true,
        reviews: {
          orderBy: { startedAt: 'asc' },
          include: {
            findings: { orderBy: { id: 'asc' }, include: { feedbacks: true } },
          },
        },
      },
    });

    const text = stringifyDemo({ exportedAt: new Date(), repos } as DemoData);
    if (SECRET_SHAPE.test(text))
      throw new Error('something credential-shaped is in the export');

    const path = fileURLToPath(DEMO_DATA_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    for (const r of repos)
      console.log(`${r.fullName}: ${r.reviews.length} reviews`);
    console.log(`wrote ${path}`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
