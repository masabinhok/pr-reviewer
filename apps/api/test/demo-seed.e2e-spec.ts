import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  parseDemo,
  seedDemo,
  stringifyDemo,
  type DemoData,
} from '../src/scripts/demo-data.js';
import { truncateAll } from './helpers/db.js';

const at = new Date('2026-09-15T10:00:00.000Z');

function review(id: string, prNumber: number, headSha: string) {
  return {
    id,
    repoId: 'local-repo-id',
    prNumber,
    baseSha: 'base',
    headSha,
    status: 'COMPLETED' as const,
    startedAt: at,
    completedAt: at,
    error: null,
    skipReason: null,
    agentResult: { run: { model: 'pr-reviewer:qwen2.5-7b' } },
    promptTokens: 10,
    completionTokens: 5,
    costCents: null,
    checkRunId: 9007199254740993n, // past Number.MAX_SAFE_INTEGER: must survive as a BigInt
    githubReviewId: null,
  };
}

function finding(id: string, reviewId: string, repeatOfId: string | null) {
  return {
    id,
    reviewId,
    filePath: 'src/auth.ts',
    line: 3,
    side: 'RIGHT' as const,
    status: 'OPEN' as const,
    severity: 'HIGH' as const,
    category: 'security',
    summary: 'Compares signatures with ===.',
    whyItBreaks: 'Timing leak.',
    suggestedFix: null,
    fingerprint: 'fp',
    githubCommentId: repeatOfId ? null : 42n,
    verdict: 'CONFIRMED' as const,
    verdictReason: 'Read the file.',
    demotedFrom: null,
    anchors: ['a1'],
    repeatOfId,
    resolvedAt: null,
    resolvedBy: null,
    reactionsEtag: null,
    commentGoneAt: null,
  };
}

const data: DemoData = {
  exportedAt: at,
  repos: [
    {
      githubId: 1351192640n,
      fullName: 'masabinhok/pr-reviewer-testbed',
      reviews: [
        {
          ...review('r1', 6, 'sha1'),
          findings: [
            {
              ...finding('f1', 'r1', null),
              feedbacks: [
                {
                  id: 'fb1',
                  findingId: 'f1',
                  signal: 'DOWN',
                  githubUserId: 161845983n,
                  reactedAt: at,
                },
              ],
            },
          ],
        },
        // The next push: the same finding, not posted again.
        {
          ...review('r2', 6, 'sha2'),
          findings: [{ ...finding('f2', 'r2', 'f1'), feedbacks: [] }],
        },
      ],
    },
    { githubId: 7n, fullName: 'someone/not-installed', reviews: [] },
  ],
};

describe('demo data (e2e)', () => {
  const prisma = new PrismaService();
  let repoId: string;

  beforeAll(async () => {
    await truncateAll(prisma);
    const installation = await prisma.installation.create({
      data: { githubId: 181260678n, accountLogin: 'demo', accountType: 'User' },
    });
    // The repo as the demo App's own installation recorded it: a different row id.
    repoId = (
      await prisma.repo.create({
        data: {
          githubId: 1351192640n,
          fullName: 'masabinhok/pr-reviewer-testbed',
          installationId: installation.id,
          private: false,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('survives its own JSON encoding, BigInts and Dates included', () => {
    expect(parseDemo(stringifyDemo(data))).toEqual(data);
  });

  it('loads under the target repo, links repeats, and skips repos the App is not on', async () => {
    const result = await seedDemo(prisma, parseDemo(stringifyDemo(data)));

    expect(result.skipped).toEqual(['someone/not-installed']);
    const reviews = await prisma.review.findMany({ orderBy: { id: 'asc' } });
    expect(reviews.map((r) => [r.id, r.repoId, r.checkRunId])).toEqual([
      ['r1', repoId, 9007199254740993n],
      ['r2', repoId, 9007199254740993n],
    ]);
    expect(reviews[0].agentResult).toEqual({
      run: { model: 'pr-reviewer:qwen2.5-7b' },
    });
    const repeat = await prisma.finding.findUniqueOrThrow({
      where: { id: 'f2' },
    });
    expect(repeat.repeatOfId).toBe('f1');
    expect(await prisma.feedback.count()).toBe(1);
  });

  it('changes nothing when run again', async () => {
    await seedDemo(prisma, data);

    expect(await prisma.review.count()).toBe(2);
    expect(await prisma.finding.count()).toBe(2);
    expect(await prisma.feedback.count()).toBe(1);
  });
});
