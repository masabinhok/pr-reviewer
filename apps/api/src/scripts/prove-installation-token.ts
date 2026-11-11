import { config } from 'dotenv';

config({ path: '../../.env' });

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { AppJwtService } from '../github/app-jwt.service.js';
import {
  InstallationTokenService,
  installationTokenCacheKey,
} from '../github/installation-token.service.js';
import { redactToken } from '../github/redact.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * Milestone 6's end-to-end proof, against the real App and the real GitHub API:
 *
 *   App JWT → which installation covers the repo → installation token (miss) →
 *   same token again (hit) → read the repo with it → report the cache TTL.
 *
 * Usage: npm run prove:token [owner/repo]
 */

const repo = process.argv[2] ?? 'masabinhok/pr-reviewer-testbed';

async function github<T>(path: string, bearer: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${bearer}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pr-reviewer',
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      `GET ${path} → ${response.status} ${body.message ?? response.statusText}`,
    );
  }
  return (await response.json()) as T;
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn', 'debug'],
  });

  try {
    const appJwt = app.get(AppJwtService);
    const tokens = app.get(InstallationTokenService);
    const redis = app.get(RedisService);

    // Installation rows arrive in Milestone 7. Until then, ask GitHub directly — this
    // endpoint is one of the few an App JWT can call on its own.
    const installation = await github<{
      id: number;
      account: { login: string };
    }>(`/repos/${repo}/installation`, appJwt.mint());
    const key = installationTokenCacheKey(installation.id);

    // Start cold so the run always shows a miss followed by a hit.
    await redis.del(key);

    const first = await tokens.getToken(installation.id);
    const second = await tokens.getToken(installation.id);

    const repository = await github<{
      full_name: string;
      private: boolean;
      default_branch: string;
    }>(`/repos/${repo}`, second);

    const ttl = await redis.ttl(key);

    console.log('');
    console.log(
      `installation      ${installation.id} (${installation.account.login})`,
    );
    console.log(`first call        ${redactToken(first)}  (minted)`);
    console.log(
      `second call       ${redactToken(second)}  (${first === second ? 'same token — served from cache' : 'DIFFERENT TOKEN — cache missed'})`,
    );
    console.log(
      `repo via token    ${repository.full_name}  private=${repository.private}  default=${repository.default_branch}`,
    );
    console.log(
      `redis TTL         ${ttl}s on ${key}  (expect ~3540, not 3600)`,
    );
    console.log('');

    if (first !== second) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

await main();
