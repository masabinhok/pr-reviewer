import { config } from 'dotenv';

config({ path: '../../.env' });

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GithubApiService } from '../github/github-api.service.js';
import { parseDiff } from '../diff/parse-diff.js';
import { LineMap } from '../diff/line-map.js';

/**
 * Milestone 14's proof. Takes the latest review of a PR from the database and asks GitHub,
 * for every stored finding, where a review comment on it would land: each one is posted as
 * a *pending* review comment (visible only to the App, deleted at once), and the last line
 * of the `diff_hunk` GitHub attaches — the line the comment sits on — is compared with the
 * code the finding points at.
 *
 * Usage: npm run prove:findings <owner/repo> <pr-number>
 */

const [repo = 'masabinhok/pr-reviewer-testbed', prArg] = process.argv.slice(2);

async function main() {
  const number = Number(prArg);
  if (!Number.isInteger(number) || number < 1) throw new Error('usage: npm run prove:findings <owner/repo> <pr-number>');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });

  try {
    const prisma = app.get(PrismaService);
    const github = app.get(GithubApiService);

    const review = await prisma.review.findFirst({
      where: { repo: { fullName: repo }, prNumber: number },
      orderBy: { startedAt: 'desc' },
      include: { findings: { orderBy: [{ filePath: 'asc' }, { line: 'asc' }] }, repo: { include: { installation: true } } },
    });
    if (!review) throw new Error(`no review recorded for ${repo}#${number}`);

    const installationId = review.repo.installation.githubId;
    const lines = new LineMap(parseDiff(await github.getDiff(installationId, repo, review.baseSha, review.headSha)));

    console.log(`\nreview ${review.id}  ${review.status}  ${review.headSha.slice(0, 7)}  ${review.findings.length} finding(s)\n`);

    let mismatches = 0;
    for (const f of review.findings) {
      const ours = lines.lineAt(f.filePath, f.line, f.side)?.content;
      const created = await github.json<{ id: number }>(installationId, `/repos/${repo}/pulls/${number}/reviews`, {
        method: 'POST',
        body: {
          commit_id: review.headSha,
          comments: [{ path: f.filePath, line: f.line, side: f.side, body: 'finding probe (deleted immediately)' }],
        },
      });
      const [comment] = await github.json<{ diff_hunk: string }[]>(
        installationId,
        `/repos/${repo}/pulls/${number}/reviews/${created.id}/comments`,
      );
      await github.request(installationId, `/repos/${repo}/pulls/${number}/reviews/${created.id}`, { method: 'DELETE' });

      // The hunk GitHub shows ends at the commented line; strip its +/-/space prefix.
      const theirs = comment.diff_hunk.split('\n').at(-1)!.slice(1);
      const same = ours === theirs;
      if (!same) mismatches++;
      console.log(`${same ? 'same line' : 'MISMATCH '}  ${f.severity.padEnd(6)} ${`${f.filePath}:${f.line} ${f.side}`.padEnd(28)} ${theirs.trim()}`);
      if (!same) console.log(`           ours: ${ours ?? '(not in the diff)'}`);
    }

    console.log(`\n${mismatches === 0 ? 'every finding lands on the line it describes' : `${mismatches} mismatch(es)`}\n`);
    if (mismatches > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

await main();
