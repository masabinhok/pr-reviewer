import { config } from 'dotenv';

config({ path: '../../.env' });

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { AppJwtService } from '../github/app-jwt.service.js';
import { GithubApiService } from '../github/github-api.service.js';
import { filterDiffFiles, filterFileList } from '../filters/review-filter.js';
import { parseDiff } from '../diff/parse-diff.js';

/**
 * Milestone 10's proof, against the real API: fetch a PR, its files and its diff the way
 * the worker will, and check the SHA-pinned diff matches the PR's own.
 *
 * Usage: npm run prove:diff <owner/repo> <pr-number> [fixture-name]
 *
 * With a fixture name it also writes the diff and the files list to
 * test/fixtures/diffs/<name>.diff and <name>.files.json, so tests run on a diff GitHub
 * actually produced. (Positional, not a --flag: `npm run` would swallow the flag.)
 */

const [repo = 'masabinhok/pr-reviewer-testbed', prArg, saveAs] =
  process.argv.slice(2);

async function main() {
  const number = Number(prArg);
  if (!Number.isInteger(number) || number < 1)
    throw new Error('usage: npm run prove:diff <owner/repo> <pr-number>');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    // Which installation covers this repo — one of the few calls an App JWT makes itself.
    const found = await fetch(
      `https://api.github.com/repos/${repo}/installation`,
      {
        headers: {
          Authorization: `Bearer ${app.get(AppJwtService).mint()}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'pr-reviewer',
        },
      },
    );
    if (!found.ok)
      throw new Error(`the App is not installed on ${repo} (${found.status})`);
    const { id: installationId } = (await found.json()) as { id: number };

    const github = app.get(GithubApiService);
    const pr = await github.getPullRequest(installationId, repo, number);
    const files = await github.listPullRequestFiles(
      installationId,
      repo,
      number,
    );
    const diff = await github.getDiff(
      installationId,
      repo,
      pr.base.sha,
      pr.head.sha,
    );

    // The PR's own diff, fetched the way the worker must NOT: by number. With no push in
    // between, the two must be identical — that is what proves compare base...head is the
    // same diff the "Files changed" tab shows.
    const byNumber = await (
      await github.request(installationId, `/repos/${repo}/pulls/${number}`, {
        accept: 'application/vnd.github.diff',
      })
    ).text();

    const { resources } = await github.json<{
      resources: { core: { remaining: number; limit: number; reset: number } };
    }>(installationId, '/rate_limit');

    const sum = (key: 'additions' | 'deletions') =>
      files.reduce((n, f) => n + f[key], 0);
    const noPatch = files
      .filter((f) => f.patch === undefined)
      .map((f) => f.filename);

    console.log('');
    console.log(`pull request      ${repo}#${number}  "${pr.title}"`);
    console.log(
      `commits           ${pr.base.sha.slice(0, 7)}...${pr.head.sha.slice(0, 7)}  (${pr.base.ref} ← ${pr.head.ref})`,
    );
    console.log(
      `files             ${files.length}  (+${sum('additions')} −${sum('deletions')})${noPatch.length ? `, no patch: ${noPatch.join(', ')}` : ''}`,
    );
    console.log(
      `diff              ${Buffer.byteLength(diff)} bytes, ${diff.split('\n').length} lines`,
    );
    console.log(
      `matches PR diff   ${diff === byNumber ? 'yes — identical to /pulls/' + number : 'NO — differs from /pulls/' + number}`,
    );
    console.log(
      `rate limit        ${resources.core.remaining}/${resources.core.limit} left, resets ${new Date(resources.core.reset * 1000).toISOString()}`,
    );
    // What the reviewer would be given: both filter stages, as the worker runs them.
    const listed = filterFileList(files);
    const parsed = filterDiffFiles(
      parseDiff(diff),
      new Set(listed.kept.map((f) => f.filename)),
    );
    console.log(
      `review            ${listed.tooLarge ? `SKIPPED — ${listed.tooLarge}` : `${parsed.kept.length} file(s): ${parsed.kept.map((f) => f.path).join(', ')}`}`,
    );
    for (const { path, reason } of [...listed.skipped, ...parsed.skipped]) {
      console.log(`  skipped         ${path} (${reason})`);
    }

    console.log('');
    console.log(diff.split('\n').slice(0, 20).join('\n'));
    console.log('');

    if (saveAs) {
      const dir = join(process.cwd(), 'test', 'fixtures', 'diffs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${saveAs}.diff`), diff);
      writeFileSync(
        join(dir, `${saveAs}.files.json`),
        JSON.stringify(files, null, 2) + '\n',
      );
      console.log(
        `saved test/fixtures/diffs/${saveAs}.diff and ${saveAs}.files.json`,
      );
    }

    if (diff !== byNumber) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

await main();
