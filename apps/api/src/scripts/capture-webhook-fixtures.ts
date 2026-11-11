import { config } from 'dotenv';

config({ path: '../../.env' });

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { AppJwtService } from '../github/app-jwt.service.js';

/**
 * Copies real webhook payloads from the App's delivery history into test/fixtures/, so
 * the e2e suite runs on what GitHub actually sends rather than what we assume it sends.
 * It is the API behind App settings → Advanced → Recent Deliveries.
 *
 * Usage: npm run capture:fixtures
 * GitHub keeps only a few days of history, so trigger the events first — e.g. uninstall
 * and reinstall the App on the testbed for installation.deleted / installation.created.
 */

const WANTED = [
  'ping',
  'installation.created',
  'installation.deleted',
  'pull_request.opened',
  'pull_request.synchronize',
  'check_suite.requested',
];

const OUT_DIR = join(process.cwd(), 'test', 'fixtures');

interface DeliverySummary {
  id: string;
  event: string;
  action: string | null;
  redelivery: boolean;
  delivered_at: string;
}

/**
 * Delivery IDs are larger than 2^53, so plain JSON.parse silently rounds them and the
 * follow-up GET 404s. The reviver's third argument exposes the original source text
 * (Node 21+), which keeps them exact as strings.
 */
function parseKeepingBigIds<T>(text: string): T {
  return JSON.parse(text, (key, value, context?: { source?: string }) =>
    key === 'id' && typeof value === 'number' && !Number.isSafeInteger(value)
      ? context?.source
      : value,
  ) as T;
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const jwt = app.get(AppJwtService).mint();
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pr-reviewer',
    };

    // Newest first. Keep the newest original (not a redelivery) of each wanted kind.
    const newest = new Map<string, DeliverySummary>();
    let url: string | null =
      'https://api.github.com/app/hook/deliveries?per_page=100';
    while (url) {
      const response: Response = await fetch(url, { headers });
      if (!response.ok)
        throw new Error(`listing deliveries → ${response.status}`);

      for (const d of parseKeepingBigIds<DeliverySummary[]>(
        await response.text(),
      )) {
        const name = d.action ? `${d.event}.${d.action}` : d.event;
        if (WANTED.includes(name) && !d.redelivery && !newest.has(name))
          newest.set(name, d);
      }

      url =
        /<([^>]+)>;\s*rel="next"/.exec(
          response.headers.get('link') ?? '',
        )?.[1] ?? null;
    }

    mkdirSync(OUT_DIR, { recursive: true });

    for (const name of WANTED) {
      const summary = newest.get(name);
      if (!summary) {
        console.log(
          `missing   ${name}  (no delivery in GitHub's history — trigger one and rerun)`,
        );
        continue;
      }

      const response = await fetch(
        `https://api.github.com/app/hook/deliveries/${summary.id}`,
        { headers },
      );
      if (!response.ok)
        throw new Error(`fetching delivery ${summary.id} → ${response.status}`);
      const delivery = (await response.json()) as {
        request: { payload: unknown };
      };

      const file = join(OUT_DIR, `${name}.json`);
      writeFileSync(
        file,
        JSON.stringify(delivery.request.payload, null, 2) + '\n',
      );
      console.log(`captured  ${name}  from ${summary.delivered_at}`);
    }
  } finally {
    await app.close();
  }
}

await main();
