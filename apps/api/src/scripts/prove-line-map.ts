import { config } from 'dotenv';

config({ path: '../../.env' });

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { AppJwtService } from '../github/app-jwt.service.js';
import { GithubApiService } from '../github/github-api.service.js';
import { GithubApiError } from '../github/github-api.errors.js';
import { parseDiff } from '../diff/parse-diff.js';
import { LineMap } from '../diff/line-map.js';
import type { DiffFile, Side } from '../diff/diff.types.js';

/**
 * Milestone 11's proof, with GitHub as the judge. For a handful of lines, ask GitHub
 * whether a review comment may go there — by creating a *pending* review carrying just
 * that comment, then deleting it — and check the LineMap gives the same answer.
 *
 * Pending reviews are visible only to their author (the App) and send no notification;
 * each is deleted straight away. This is the exact call weeks 5–6 make to post findings.
 *
 * Usage: npm run prove:line-map <owner/repo> <pr-number>
 */

const [repo = 'masabinhok/pr-reviewer-testbed', prArg] = process.argv.slice(2);

interface Probe {
  label: string;
  path: string;
  line: number;
  side: Side;
}

/** Picks lines of every kind from the parsed diff, plus lines that must be refused. */
function probes(files: DiffFile[]): Probe[] {
  const picked: Probe[] = [];
  const first = (pred: (f: DiffFile) => boolean) =>
    files.find((f) => pred(f) && f.hunks.length > 0);

  for (const f of files) {
    for (const hunk of f.hunks) {
      for (const l of hunk.lines) {
        const want = (label: string, line: number, side: Side) => {
          if (!picked.some((p) => p.label === label))
            picked.push({ label, path: f.path, line, side });
        };
        if (l.kind === 'add' && f.status === 'modified')
          want('added line', l.newLine!, 'RIGHT');
        if (l.kind === 'del' && f.status === 'modified')
          want('deleted line', l.oldLine!, 'LEFT');
        if (l.kind === 'context') {
          want('context line, new side', l.newLine!, 'RIGHT');
          want('context line, old side', l.oldLine!, 'LEFT');
        }
      }
    }
  }

  const renamed = first((f) => f.status === 'renamed');
  if (renamed) {
    picked.push({
      label: 'renamed file, new side',
      path: renamed.path,
      line: renamed.hunks[0].newStart,
      side: 'RIGHT',
    });
    picked.push({
      label: 'renamed file, old side',
      path: renamed.path,
      line: renamed.hunks[0].oldStart,
      side: 'LEFT',
    });
    picked.push({
      label: 'renamed file, old path',
      path: renamed.oldPath,
      line: renamed.hunks[0].oldStart,
      side: 'LEFT',
    });
    picked.push({
      label: 'renamed, old path, new',
      path: renamed.oldPath,
      line: renamed.hunks[0].newStart,
      side: 'RIGHT',
    });
  }
  const removed = first((f) => f.status === 'removed');
  if (removed) {
    picked.push({
      label: 'removed file, old side',
      path: removed.path,
      line: 1,
      side: 'LEFT',
    });
    picked.push({
      label: 'removed file, new side',
      path: removed.path,
      line: 1,
      side: 'RIGHT',
    });
  }
  const multi = files.find((f) => f.hunks.length > 1);
  if (multi) {
    const gap = multi.hunks[0].newStart + multi.hunks[0].newLines; // first line after hunk 1
    picked.push({
      label: 'between two hunks',
      path: multi.path,
      line: gap,
      side: 'RIGHT',
    });
  }
  const pureRename = files.find(
    (f) => f.status === 'renamed' && f.hunks.length === 0,
  );
  if (pureRename)
    picked.push({
      label: 'rename without changes',
      path: pureRename.path,
      line: 1,
      side: 'RIGHT',
    });
  const binary = files.find((f) => f.binary);
  if (binary)
    picked.push({
      label: 'binary file',
      path: binary.path,
      line: 1,
      side: 'RIGHT',
    });

  return picked;
}

async function main() {
  const number = Number(prArg);
  if (!Number.isInteger(number) || number < 1)
    throw new Error('usage: npm run prove:line-map <owner/repo> <pr-number>');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  try {
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
    const files = parseDiff(
      await github.getDiff(installationId, repo, pr.base.sha, pr.head.sha),
    );
    const map = new LineMap(files);

    console.log('');
    let disagreements = 0;
    for (const probe of probes(files)) {
      const ours = map.canComment(probe.path, probe.line, probe.side);
      const theirs = await githubAccepts(
        github,
        installationId,
        number,
        pr.head.sha,
        probe,
      );
      const agree = ours === theirs;
      if (!agree) disagreements++;
      console.log(
        `${agree ? 'agree   ' : 'DISAGREE'}  ${probe.label.padEnd(24)} ${`${probe.path}:${probe.line} ${probe.side}`.padEnd(34)}` +
          ` map ${ours ? 'yes' : 'no '}  GitHub ${theirs ? 'accepts' : 'rejects (422)'}`,
      );
    }
    const { length: leftover } = (
      await github.json<{ state: string }[]>(
        installationId,
        `/repos/${repo}/pulls/${number}/reviews`,
      )
    ).filter((r) => r.state === 'PENDING');
    console.log(
      `\npending reviews left by the probes (seen as the App): ${leftover}`,
    );
    console.log(
      `\n${disagreements === 0 ? 'the line map agrees with GitHub on every probe' : `${disagreements} disagreement(s)`}\n`,
    );
    if (disagreements > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

/** Create a pending review with one comment; true if GitHub took it. Always cleans up. */
async function githubAccepts(
  github: GithubApiService,
  installationId: number,
  number: number,
  headSha: string,
  probe: Probe,
): Promise<boolean> {
  try {
    const review = await github.json<{ id: number }>(
      installationId,
      `/repos/${repo}/pulls/${number}/reviews`,
      {
        method: 'POST',
        // No `event`: the review stays PENDING — unsubmitted, visible only to the App.
        body: {
          commit_id: headSha,
          comments: [
            {
              path: probe.path,
              line: probe.line,
              side: probe.side,
              body: 'line-map probe (deleted immediately)',
            },
          ],
        },
      },
    );
    await github.request(
      installationId,
      `/repos/${repo}/pulls/${number}/reviews/${review.id}`,
      { method: 'DELETE' },
    );
    return true;
  } catch (e) {
    if (e instanceof GithubApiError && e.status === 422) return false;
    throw e;
  }
}

await main();
