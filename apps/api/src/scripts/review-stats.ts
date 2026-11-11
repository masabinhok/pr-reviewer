import { config } from 'dotenv';

config({ path: '../../.env' });

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ReviewerResult } from '../reviewer/reviewer.js';

/**
 * What reviews cost and how they ran — milestone 21's measurements, from what the pipeline
 * already stores on each Review. One row per review, newest first.
 *
 * Usage: npm run review:stats [how-many]
 */

const limit = Number(process.argv[2] ?? 20);

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  try {
    const reviews = await app.get(PrismaService).review.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: {
        repo: true,
        findings: { select: { severity: true, githubCommentId: true } },
      },
    });

    const rows = reviews.map((r) => {
      const run = (r.agentResult as ReviewerResult | null)?.run;
      const u = run?.usage;
      const promptTotal = u
        ? u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens
        : null;
      const seconds = r.completedAt
        ? Math.round((r.completedAt.getTime() - r.startedAt.getTime()) / 1000)
        : null;
      return {
        when: r.startedAt.toISOString().slice(0, 16).replace('T', ' '),
        review: `${r.repo.fullName}#${r.prNumber}@${r.headSha.slice(0, 7)}`,
        status: r.status,
        reviewer: run
          ? `${run.model} ${run.outcome}`
          : r.agentResult
            ? 'stub'
            : '—',
        time: seconds === null ? '—' : `${seconds}s`,
        turns: run ? `${run.turns}/${run.toolCalls}` : '—',
        'in (cached%)':
          promptTotal === null
            ? '—'
            : `${promptTotal.toLocaleString('en-US')} (${pct(u!.cacheReadInputTokens, promptTotal)})`,
        out: u ? u.outputTokens.toLocaleString('en-US') : '—',
        cost: u?.costUsd == null ? '—' : `$${u.costUsd.toFixed(3)}`,
        findings: `${r.findings.length} / ${r.findings.filter((f) => f.githubCommentId !== null).length} posted`,
      };
    });

    if (rows.length === 0) {
      console.log('No reviews yet.');
      return;
    }
    printTable(rows);

    const priced = reviews
      .map((r) => (r.agentResult as ReviewerResult | null)?.run?.usage.costUsd)
      .filter((c): c is number => typeof c === 'number');
    if (priced.length > 0) {
      const total = priced.reduce((a, b) => a + b, 0);
      console.log(
        `\n${priced.length} agent review(s): $${total.toFixed(3)} total, $${(total / priced.length).toFixed(3)} each on average`,
      );
    }
  } finally {
    await app.close();
  }
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`;
}

function printTable(rows: Record<string, string>[]) {
  const columns = Object.keys(rows[0]);
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => r[c].length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  console.log(line(columns));
  console.log(line(widths.map((w) => '─'.repeat(w))));
  for (const row of rows) console.log(line(columns.map((c) => row[c])));
}

await main();
