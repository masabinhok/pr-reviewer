import { Test } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FeedbackPoller } from '../src/feedback/feedback-poller.js';
import { feedbackRate } from '../src/feedback/feedback-rate.js';
import { FindingSide, ReviewStatus, Severity } from '../src/generated/prisma/client.js';
import { truncateAll } from './helpers/db.js';
import { fakeGithub, type FakeReaction } from './helpers/github-fake.js';

/**
 * Reactions polled from GitHub into Feedback rows, on the real database. GitHub is faked at
 * fetch, and honours If-None-Match with a 304 as the real one does.
 */
describe('Feedback from reactions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let poller: FeedbackPoller;
  let reactions: Map<number, FakeReaction[]>;
  let github: ReturnType<typeof fakeGithub>;

  const NOW = new Date('2026-09-17T12:00:00Z');
  const PERSON = { id: 161845983, type: 'User' as const };
  const OTHER = { id: 42, type: 'User' as const };
  const react = (content: string, user: FakeReaction['user'], minute = 0): FakeReaction => ({
    content,
    created_at: `2026-09-17T11:${String(minute).padStart(2, '0')}:00Z`,
    user,
  });

  /** An installation, repo and completed review with one posted finding per comment ID. */
  async function seed(commentIds: number[], { completedAt = NOW, suspended = false } = {}) {
    const installation = await prisma.installation.create({
      data: { githubId: 160831076n, accountLogin: 'masabinhok', accountType: 'User', suspendedAt: suspended ? NOW : null },
    });
    const repo = await prisma.repo.create({
      data: { githubId: 1n, installationId: installation.id, fullName: 'masabinhok/pr-reviewer', private: false, defaultBranch: 'main' },
    });
    const review = await prisma.review.create({
      data: { repoId: repo.id, prNumber: 33, baseSha: 'b', headSha: 'h', status: ReviewStatus.COMPLETED, completedAt },
    });
    for (const [i, commentId] of commentIds.entries()) {
      await prisma.finding.create({
        data: {
          reviewId: review.id, filePath: 'src/a.ts', line: 10 + i, side: FindingSide.RIGHT, severity: Severity.HIGH,
          category: 'correctness', summary: `finding ${i}`, whyItBreaks: 'x', fingerprint: `f${i}`, githubCommentId: BigInt(commentId),
        },
      });
    }
  }

  const feedbackOn = (commentId: number) =>
    prisma.feedback.findMany({ where: { finding: { githubCommentId: BigInt(commentId) } }, orderBy: { githubUserId: 'asc' } });
  const reactionCalls = () => github.calls.filter((c) => c.path.endsWith('/reactions')).length;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prisma = app.get(PrismaService);
    poller = app.get(FeedbackPoller);
    for (const level of ['log', 'warn'] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await app.close();
  });

  beforeEach(async () => {
    reactions = new Map();
    github = fakeGithub({ pulls: {}, reactions });
    vi.stubGlobal('fetch', github.fetch);
    await truncateAll(prisma);
  });

  it('stores a 👎 as DOWN feedback, from the person, with when', async () => {
    await seed([991]);
    reactions.set(991, [react('-1', PERSON, 50)]);

    const summary = await poller.pollOnce(NOW);

    expect(summary).toMatchObject({ checked: 1, updated: 1 });
    expect(await feedbackOn(991)).toEqual([
      expect.objectContaining({ signal: 'DOWN', githubUserId: 161845983n, reactedAt: new Date('2026-09-17T11:50:00Z') }),
    ]);
  });

  // The point of the ETag: a quiet comment costs a 304, and the rows stay as they were.
  it('asks again with the ETag, and a 304 changes nothing', async () => {
    await seed([991]);
    reactions.set(991, [react('-1', PERSON)]);
    await poller.pollOnce(NOW);

    const summary = await poller.pollOnce(NOW);

    expect(summary).toMatchObject({ checked: 1, unchanged: 1, updated: 0 });
    expect(await feedbackOn(991)).toHaveLength(1);
    const [, second] = github.calls.filter((c) => c.path.endsWith('/reactions'));
    expect(second).toBeDefined();
  });

  it('follows a person who changes their mind, and one who takes it back', async () => {
    await seed([991]);
    reactions.set(991, [react('+1', PERSON, 1), react('+1', OTHER, 2)]);
    await poller.pollOnce(NOW);

    reactions.set(991, [react('+1', PERSON, 1), react('-1', PERSON, 9)]); // PERSON adds 👎 later; OTHER removes 👍
    await poller.pollOnce(NOW);

    expect((await feedbackOn(991)).map((f) => [f.githubUserId, f.signal])).toEqual([[161845983n, 'DOWN']]);
  });

  it('ignores reactions that are not 👍 or 👎, and bots', async () => {
    await seed([991]);
    reactions.set(991, [react('heart', PERSON), react('rocket', OTHER), react('+1', { id: 7, type: 'Bot' })]);

    await poller.pollOnce(NOW);

    expect(await feedbackOn(991)).toEqual([]);
  });

  it('marks a deleted comment gone and stops asking about it', async () => {
    await seed([991]); // no reactions entry: the fake answers 404

    expect(await poller.pollOnce(NOW)).toMatchObject({ gone: 1 });
    const calls = reactionCalls();
    await poller.pollOnce(NOW);

    expect(reactionCalls()).toBe(calls);
    expect(await prisma.finding.findFirst()).toMatchObject({ commentGoneAt: NOW });
  });

  it('does not poll comments from reviews older than the window, or a suspended installation', async () => {
    await seed([991], { completedAt: new Date('2026-08-01T00:00:00Z') });
    reactions.set(991, [react('-1', PERSON)]);

    expect(await poller.pollOnce(NOW)).toMatchObject({ checked: 0 });

    await truncateAll(prisma);
    await seed([992], { suspended: true });
    reactions.set(992, [react('-1', PERSON)]);
    expect(await poller.pollOnce(NOW)).toMatchObject({ checked: 0 });
  });

  it('reports the feedback rate over the comments that still exist', async () => {
    await seed([991, 992, 993, 994]);
    reactions.set(991, [react('-1', PERSON)]);
    reactions.set(992, [react('+1', PERSON), react('-1', OTHER)]);
    reactions.set(993, []);
    // 994 was deleted on GitHub.
    await poller.pollOnce(NOW);

    expect(await feedbackRate(prisma)).toEqual({ posted: 3, withFeedback: 2, upvoted: 1, downvoted: 2 });
  });
});
