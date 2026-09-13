import { config } from 'dotenv';

config({ path: '../../.env' });

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { GithubApiService } from '../github/github-api.service.js';
import { AppJwtService } from '../github/app-jwt.service.js';
import { filterDiffFiles, filterFileList } from '../filters/review-filter.js';
import { parseDiff } from '../diff/parse-diff.js';
import { LineMap } from '../diff/line-map.js';
import { REVIEWER, type Reviewer } from '../reviewer/reviewer.js';
import { validateFindings } from '../reviewer/validate-findings.js';

/**
 * Milestone 21's tuning loop: one real review of a real PR, printed — and nothing else.
 * It runs the pipeline's reading half (list files, filter, fetch the diff by SHA, parse,
 * filter, ask the reviewer, validate) but writes no Review row, completes no Check Run and
 * posts nothing. So a model, a prompt or a budget can be changed and measured again on the
 * same pull request, as often as you like, without touching the PR or the database.
 *
 * Which model answers is the agent's own setting (AGENT_MODEL, AGENT_PROVIDER): restart the
 * agent with a different one and run this again.
 *
 * A third argument keeps only the files whose path contains it, to see what the model makes
 * of one file on its own.
 *
 * Usage: npm run try:review <owner/repo> <pr-number> [path-substring]
 */

const [repo = 'masabinhok/pr-reviewer-testbed', prArg, only] = process.argv.slice(2);

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((cell, i) => (cell ?? '').padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

async function installationFor(jwt: AppJwtService, fullName: string): Promise<bigint> {
  const response = await fetch(`https://api.github.com/repos/${fullName}/installation`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt.mint()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pr-reviewer',
    },
  });
  if (!response.ok) throw new Error(`the App is not installed on ${fullName} (GitHub answered ${response.status})`);
  return BigInt(((await response.json()) as { id: number }).id);
}

async function main() {
  const number = Number(prArg);
  if (!Number.isInteger(number) || number < 1) throw new Error('usage: npm run try:review <owner/repo> <pr-number>');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const github = app.get(GithubApiService);
    const reviewer = app.get<Reviewer>(REVIEWER);

    // The installation the App has on this repository, asked of GitHub rather than the
    // database: the database only knows what webhooks told it, and misses a repository added
    // while nothing was running — or still links one to an installation since removed.
    const installationId = await installationFor(app.get(AppJwtService), repo);

    const pr = await github.getPullRequest(installationId, repo, number);
    const files = await github.listPullRequestFiles(installationId, repo, number);
    const listed = filterFileList(files);
    if (listed.tooLarge) throw new Error(`too large to review: ${listed.tooLarge}`);

    const diff = await github.getDiff(installationId, repo, pr.base.sha, pr.head.sha);
    const parsed = filterDiffFiles(parseDiff(diff), new Set(listed.kept.map((f) => f.filename)));
    if (only) parsed.kept = parsed.kept.filter((f) => f.path.includes(only));
    const lines = new LineMap(parsed.kept);

    console.log(`\n${repo}#${number} "${pr.title}" at ${pr.head.sha.slice(0, 7)}`);
    console.log(`${parsed.kept.length} file(s) reviewed, ${listed.skipped.length + parsed.skipped.length} skipped\n`);

    // DUMP_REQUEST=path writes the agent's request (minus the token, which is a secret) and
    // stops: that file replays this pull request offline, with the diff edited however you
    // like, without GitHub in the loop.
    if (process.env.DUMP_REQUEST) {
      const { writeFileSync } = await import('node:fs');
      const body = {
        repo,
        prNumber: number,
        title: pr.title,
        body: pr.body ?? '',
        baseSha: pr.base.sha,
        headSha: pr.head.sha,
        files: parsed.kept,
      };
      writeFileSync(process.env.DUMP_REQUEST, JSON.stringify(body, null, 2) + '\n');
      console.log(`wrote ${process.env.DUMP_REQUEST} (no installation token in it)`);
      return;
    }

    const started = Date.now();
    const answer = await reviewer.review({
      installationId,
      repo,
      prNumber: number,
      title: pr.title,
      body: pr.body ?? '',
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      files: parsed.kept,
      lines,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    const { accepted, dropped } = validateFindings(answer.findings, lines);
    const run = answer.run;
    if (run) {
      const u = run.usage;
      const cached = u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
      console.log(
        `${run.model} — ${run.outcome} in ${seconds}s, ${run.turns} turn(s), ${run.toolCalls} tool call(s), ` +
          `${cached.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out` +
          (u.costUsd === null ? '' : `, $${u.costUsd.toFixed(4)}`),
      );
    } else {
      console.log(`the reviewer answered in ${seconds}s (no run details: this is the stub)`);
    }

    console.log(`\n${accepted.length} finding(s) kept, ${dropped.length} dropped\n`);
    if (accepted.length > 0) {
      console.log(
        table([
          ['severity', 'where', 'posted?', 'summary'],
          ...accepted.map((f) => [
            f.severity,
            `${f.path}:${f.line} ${f.side}`,
            f.severity === 'HIGH' || f.severity === 'MEDIUM' ? 'yes' : 'no',
            f.summary,
          ]),
        ]),
      );
      console.log();
      for (const f of accepted) console.log(`${f.path}:${f.line} — ${f.whyItBreaks}`);
    }
    for (const { finding, reason } of dropped) {
      console.log(`dropped ${finding.file}:${finding.line} ${finding.side} (${reason}): ${finding.summary}`);
    }
    console.log();
  } finally {
    await app.close();
  }
}

await main();
