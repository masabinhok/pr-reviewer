import { Test } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FeedbackSignal, FindingSide, FindingStatus, ResolvedBy, ReviewStatus, Severity, Verdict } from '../src/generated/prisma/client.js';
import { truncateAll } from './helpers/db.js';

/**
 * The dashboard API over real HTTP and the real database, with rows seeded to look like the
 * reviews the pipeline writes: an agent review with verdicts, feedback, a repeat and a
 * resolved finding; a stub review; a failed one.
 */
describe('Dashboard API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const TOKEN = 'e2e-dashboard-token';
  const get = (path: string, token: string | null = TOKEN) => {
    const r = request(app.getHttpServer()).get(`/api/dashboard${path}`);
    return token === null ? r : r.set('Authorization', `Bearer ${token}`);
  };

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prisma = app.get(PrismaService);
    for (const level of ['log', 'warn'] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);

    await truncateAll(prisma);
    const installation = await prisma.installation.create({ data: { githubId: 160831076n, accountLogin: 'masabinhok', accountType: 'User' } });
    const repo = await prisma.repo.create({
      data: { githubId: 1351385826n, installationId: installation.id, fullName: 'masabinhok/pr-reviewer', private: false, defaultBranch: 'main' },
    });
    const testbed = await prisma.repo.create({
      data: { githubId: 2n, installationId: installation.id, fullName: 'masabinhok/pr-reviewer-testbed', private: false, defaultBranch: 'main' },
    });

    const at = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);
    const agentResult = {
      findings: [],
      run: {
        model: 'pr-reviewer:qwen2.5-7b', outcome: 'submitted', turns: 6, toolCalls: 4, verifyCalls: 3,
        usage: { inputTokens: 20_000, outputTokens: 1_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 },
      },
      dropped: [
        {
          finding: { file: 'src/config.ts', line: 3, side: 'RIGHT', severity: 'high', category: 'correctness', summary: 'Not validated.', whyItBreaks: 'x' },
          reason: 'Line 5 validates it.',
        },
      ],
    };
    const agentReview = await prisma.review.create({
      data: {
        repoId: repo.id, prNumber: 33, baseSha: 'base333', headSha: 'head333', status: ReviewStatus.COMPLETED,
        startedAt: at(3), completedAt: new Date(at(3).getTime() + 130_000), checkRunId: 9_876_543_210n, agentResult,
      },
    });
    const earlier = await prisma.review.create({
      data: { repoId: repo.id, prNumber: 33, baseSha: 'b', headSha: 'head332', status: ReviewStatus.COMPLETED, startedAt: at(5), completedAt: at(4.9) },
    });
    const failed = await prisma.review.create({
      data: { repoId: testbed.id, prNumber: 6, baseSha: 'b', headSha: 'head6', status: ReviewStatus.FAILED, startedAt: at(1), completedAt: at(0.9), error: 'agent unreachable' },
    });
    Object.assign(ids, { agentReview: agentReview.id, earlier: earlier.id, failed: failed.id });

    const finding = (reviewId: string, line: number, extra: Record<string, unknown> = {}) =>
      prisma.finding.create({
        data: {
          reviewId, filePath: 'src/auth.ts', line, side: FindingSide.RIGHT, severity: Severity.HIGH, category: 'security',
          summary: `finding at ${line}`, whyItBreaks: 'it breaks', fingerprint: `fp${line}`, ...extra,
        },
      });
    const original = await finding(earlier.id, 23, { githubCommentId: 4012380781n, status: FindingStatus.RESOLVED, resolvedBy: ResolvedBy.PERSON, resolvedAt: at(4) });
    const posted = await finding(agentReview.id, 23, { githubCommentId: 3999465159n, verdict: Verdict.CONFIRMED, verdictReason: 'Line 23 compares with ===.' });
    await finding(agentReview.id, 30, { severity: Severity.LOW, verdict: Verdict.UNSURE, verdictReason: 'Cannot tell.', demotedFrom: Severity.MEDIUM });
    await finding(agentReview.id, 40, { repeatOfId: original.id, verdict: Verdict.CONFIRMED, verdictReason: 'Still there.' });
    await prisma.feedback.create({ data: { findingId: posted.id, githubUserId: 161845983n, signal: FeedbackSignal.DOWN, reactedAt: at(2) } });
    ids.posted = posted.id;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe('its lock', () => {
    it('refuses a request without the token', async () => {
      await get('/overview', null).expect(401);
    });

    it('refuses the wrong token', async () => {
      await get('/overview', 'not-the-token').expect(401);
    });
  });

  it('gives an overview of reviews, findings, the second look, feedback and the agent', async () => {
    const { body } = await get('/overview').expect(200);

    expect(body.reviews).toEqual({ total: 3, completed: 2, failed: 1, skipped: 0, inProgress: 0 });
    expect(body.findings).toEqual({
      total: 4,
      bySeverity: { high: 3, medium: 0, low: 1 },
      posted: 2,
      repeats: 1,
      resolved: { byApp: 0, byPerson: 1 },
      verdicts: { confirmed: 2, unsure: 1, unverified: 0 },
      droppedOnSecondLook: 1,
    });
    expect(body.feedback).toEqual({ posted: 2, withFeedback: 1, upvoted: 0, downvoted: 1 });
    expect(body.agent).toEqual({ reviews: 1, averageSeconds: 130, averageTurns: 6, tokensIn: 20_000, tokensOut: 1_000, costUsd: 0 });
    expect(body.perDay).toHaveLength(30);
    const today = body.perDay.at(-1);
    expect(today.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it('lists installations with their repositories and review counts, IDs as strings', async () => {
    const { body } = await get('/installations').expect(200);

    expect(body).toEqual([
      expect.objectContaining({
        githubId: '160831076',
        account: 'masabinhok',
        repos: [
          expect.objectContaining({ fullName: 'masabinhok/pr-reviewer', reviews: 2 }),
          expect.objectContaining({ fullName: 'masabinhok/pr-reviewer-testbed', reviews: 1 }),
        ],
      }),
    ]);
  });

  describe('the review list', () => {
    it('is newest first, one page at a time', async () => {
      const first = await get('/reviews?limit=2').expect(200);
      expect(first.body.items.map((r: { id: string }) => r.id)).toEqual([ids.failed, ids.agentReview]);
      expect(first.body.nextCursor).toBe(ids.agentReview);

      const second = await get(`/reviews?limit=2&cursor=${first.body.nextCursor}`).expect(200);
      expect(second.body.items.map((r: { id: string }) => r.id)).toEqual([ids.earlier]);
      expect(second.body.nextCursor).toBeNull();
    });

    it('filters by repository and by status', async () => {
      const byRepo = await get('/reviews?repo=masabinhok/pr-reviewer-testbed').expect(200);
      const byStatus = await get('/reviews?status=COMPLETED').expect(200);

      expect(byRepo.body.items.map((r: { id: string }) => r.id)).toEqual([ids.failed]);
      expect(byStatus.body.items).toHaveLength(2);
    });

    it('summarises each review, run and all', async () => {
      const { body } = await get('/reviews?status=COMPLETED&limit=1').expect(200);

      expect(body.items[0]).toMatchObject({
        repo: 'masabinhok/pr-reviewer',
        prNumber: 33,
        prUrl: 'https://github.com/masabinhok/pr-reviewer/pull/33',
        status: 'COMPLETED',
        seconds: 130,
        model: 'pr-reviewer:qwen2.5-7b',
        turns: 6,
        verifyCalls: 3,
        tokensIn: 20_000,
        findings: 3,
        posted: 1,
        droppedOnSecondLook: 1,
      });
    });
  });

  describe('one review', () => {
    it('has its findings with their verdicts, feedback, repeats and links', async () => {
      const { body } = await get(`/reviews/${ids.agentReview}`).expect(200);

      expect(body.checkRunUrl).toBe('https://github.com/masabinhok/pr-reviewer/runs/9876543210');
      expect(body.findings).toEqual([
        expect.objectContaining({
          line: 23, posted: true, verdict: 'CONFIRMED', verdictReason: 'Line 23 compares with ===.',
          commentUrl: 'https://github.com/masabinhok/pr-reviewer/pull/33#discussion_r3999465159',
          feedback: { up: 0, down: 1 },
        }),
        expect.objectContaining({ line: 30, posted: false, verdict: 'UNSURE', demotedFrom: 'MEDIUM', severity: 'LOW' }),
        expect.objectContaining({ line: 40, posted: false, repeatOf: expect.any(String) }),
      ]);
      expect(body.dropped).toEqual([
        { path: 'src/config.ts', line: 3, severity: 'high', summary: 'Not validated.', reason: 'Line 5 validates it.' },
      ]);
    });

    it('answers 404 for a review that does not exist', async () => {
      await get('/reviews/nope').expect(404);
    });
  });

  it('never writes', async () => {
    await request(app.getHttpServer()).post('/api/dashboard/overview').set('Authorization', `Bearer ${TOKEN}`).expect(404);
  });
});
