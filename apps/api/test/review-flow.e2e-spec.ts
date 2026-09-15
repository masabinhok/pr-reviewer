import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ReviewStatus } from '../src/generated/prisma/client.js';
import { sign } from './helpers/sign.js';
import { fixture, fixtureJson } from './helpers/fixtures.js';
import { truncateAll } from './helpers/db.js';
import { fakeGithub } from './helpers/github-fake.js';

/**
 * The whole of weeks 3–4 over real HTTP: a signed pull_request delivery goes through the
 * guard, the webhook, the queue, the worker and the pipeline, and comes out as Review and
 * Finding rows plus a completed Check Run. Postgres (pr_reviewer_test), Redis (db 1),
 * BullMQ and the worker are all real; GitHub is replaced at the fetch boundary with
 * responses captured from the testbed (see helpers/github-fake.ts).
 */

const diffs = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/diffs/${name}`, import.meta.url)), 'utf8');

// Real deliveries: a push to the diff-shapes PR (#3), and the opening of a 60-file PR (#5).
const SYNC = fixture('pull_request.synchronize');
const sync = fixtureJson<{
  number: number;
  installation: { id: number };
  repository: { full_name: string };
  pull_request: { head: { sha: string } };
}>('pull_request.synchronize');
const OPENED_LARGE = fixture('pull_request.opened');
const REPO = sync.repository.full_name;

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Review flow: webhook → queue → worker → rows and Check Run (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let github: ReturnType<typeof fakeGithub>;

  function deliver(event: string, body: string, deliveryId = randomUUID()) {
    return request(app.getHttpServer())
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', event)
      .set('X-GitHub-Delivery', deliveryId)
      .set('X-Hub-Signature-256', sign(body))
      .send(body);
  }

  const settledReview = (headSha: string) =>
    until(
      () => prisma.review.findFirst({ where: { headSha }, include: { findings: true } }),
      (r) => r !== null && ([ReviewStatus.COMPLETED, ReviewStatus.FAILED, ReviewStatus.SKIPPED] as ReviewStatus[]).includes(r.status),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prisma = app.get(PrismaService);

    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await app.close();
  });

  beforeEach(async () => {
    github = fakeGithub({
      pulls: {
        [`${REPO}#3`]: { files: JSON.parse(diffs('pr3-synchronize.files.json')), diff: diffs('pr3-synchronize.diff'), title: 'Diff shapes' },
        [`${REPO}#5`]: { files: JSON.parse(diffs('pr5-too-large.files.json')), diff: diffs('pr5-too-large.diff') },
      },
    });
    vi.stubGlobal('fetch', github.fetch);

    await truncateAll(prisma);
    await prisma.installation.create({
      data: { githubId: BigInt(sync.installation.id), accountLogin: 'masabinhok', accountType: 'User' },
    });
  });

  it('answers the webhook fast, then reviews the push and stores its findings', async () => {
    const started = Date.now();
    await deliver('pull_request', SYNC).expect(200).expect({ ok: true, handled: true });
    // The webhook only records and enqueues; the review happens after the response.
    expect(Date.now() - started).toBeLessThan(1000);

    const review = await settledReview(sync.pull_request.head.sha);
    expect(review?.status).toBe(ReviewStatus.COMPLETED);
    expect(review!.findings.map((f) => [f.filePath, f.line, f.side, f.severity]).sort()).toEqual([
      ['src/auth.ts', 26, 'RIGHT', 'LOW'],
      ['src/auth.ts', 32, 'RIGHT', 'LOW'],
      ['src/helpers.ts', 10, 'RIGHT', 'LOW'],
      ['src/new-feature.ts', 2, 'RIGHT', 'MEDIUM'],
    ]);
  });

  it('posts one review, COMMENT only, with the findings that meet the severity gate', async () => {
    await deliver('pull_request', SYNC).expect(200);
    const review = await settledReview(sync.pull_request.head.sha);

    expect(github.reviews).toHaveLength(1);
    const [posted] = github.reviews;
    expect(posted.event).toBe('COMMENT');
    expect(posted.commitId).toBe(sync.pull_request.head.sha);
    // The stub's four findings are three low and one medium: only the medium is posted.
    expect(posted.comments.map((c) => [c.path, c.line, c.side])).toEqual([['src/new-feature.ts', 2, 'RIGHT']]);
    expect(posted.body).toContain('3 lower-severity notes are in the pr-reviewer check');

    const medium = review!.findings.find((f) => f.severity === 'MEDIUM');
    expect(medium?.githubCommentId).toBe(BigInt(posted.comments[0].id));
    expect(review!.findings.filter((f) => f.githubCommentId !== null)).toHaveLength(1);
  });

  // Posting is the visible step. A job that fails after it — here, GitHub refusing the
  // Check Run update once — must retry without posting a second review.
  it('does not post a second review when the job is retried after posting', async () => {
    const fetchWithOneCheckRunFailure = github.fetch;
    let failed = false;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
      if (!failed && (init.method ?? 'GET') === 'PATCH' && String(input).includes('/check-runs/')) {
        failed = true;
        return new Response(JSON.stringify({ message: 'Bad Gateway' }), { status: 502 });
      }
      return fetchWithOneCheckRunFailure(input, init);
    });

    await deliver('pull_request', SYNC).expect(200);
    const review = await settledReview(sync.pull_request.head.sha);

    expect(failed).toBe(true);
    expect(review?.status).toBe(ReviewStatus.COMPLETED);
    expect(github.reviews).toHaveLength(1);
    expect(review?.githubReviewId).toBe(BigInt(github.reviews[0].id));
  });

  it('opens a Check Run on the head commit and completes it with the findings', async () => {
    await deliver('pull_request', SYNC).expect(200);
    await settledReview(sync.pull_request.head.sha);

    expect(github.createdCheckRuns()).toEqual([expect.objectContaining({ name: 'pr-reviewer', head_sha: sync.pull_request.head.sha, status: 'in_progress' })]);
    const [completed] = github.completedCheckRuns();
    expect(completed.conclusion).toBe('success');
    expect(completed.output.title).toBe('4 findings in 3 files');
    expect(completed.output.summary).toContain('Posted 1 comment on the pull request');
    expect(completed.output.summary).toContain('| `package-lock.json` | lockfile |');
  });

  it('fetches the diff by the pushed commit’s SHAs', async () => {
    await deliver('pull_request', SYNC).expect(200);
    await settledReview(sync.pull_request.head.sha);

    expect(github.calls.filter((c) => c.path.includes('/compare/')).map((c) => c.path)).toEqual([
      `/repos/${REPO}/compare/${fixtureJson<{ pull_request: { base: { sha: string } } }>('pull_request.synchronize').pull_request.base.sha}...${sync.pull_request.head.sha}`,
    ]);
  });

  it('does not review a redelivered delivery twice', async () => {
    const deliveryId = randomUUID();
    await deliver('pull_request', SYNC, deliveryId).expect(200);
    await settledReview(sync.pull_request.head.sha);

    await deliver('pull_request', SYNC, deliveryId).expect(200).expect({ ok: true, duplicate: true });

    expect(await prisma.review.count()).toBe(1);
    expect(github.createdCheckRuns()).toHaveLength(1);
  });

  it('creates a new review for a new head commit', async () => {
    await deliver('pull_request', SYNC).expect(200);
    await settledReview(sync.pull_request.head.sha);

    const next = JSON.parse(SYNC);
    next.pull_request.head.sha = '1234567890abcdef1234567890abcdef12345678';
    await deliver('pull_request', JSON.stringify(next)).expect(200);
    await settledReview(next.pull_request.head.sha);

    const heads = (await prisma.review.findMany()).map((r) => r.headSha).sort();
    expect(heads).toEqual([next.pull_request.head.sha, sync.pull_request.head.sha].sort());
  });

  // M24: a push reviews the new head from scratch; what was already commented on stays put.
  describe('a second push to the same pull request', () => {
    const SECOND = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const secondPush = () => {
      const next = JSON.parse(SYNC);
      next.pull_request.head.sha = SECOND;
      return JSON.stringify(next);
    };
    const pushTwice = async () => {
      await deliver('pull_request', SYNC).expect(200);
      await settledReview(sync.pull_request.head.sha);
      await deliver('pull_request', secondPush()).expect(200);
      return settledReview(SECOND);
    };

    it('does not post a comment already on the pull request, and says so in the Check Run', async () => {
      const second = await pushTwice();

      expect(second?.status).toBe(ReviewStatus.COMPLETED);
      expect(github.reviews).toHaveLength(1); // the first push's review, and no other
      const first = await prisma.review.findFirst({ where: { headSha: sync.pull_request.head.sha }, include: { findings: true } });
      const commented = first!.findings.find((f) => f.githubCommentId !== null)!;
      const repeat = second!.findings.find((f) => f.filePath === commented.filePath && f.line === commented.line)!;
      expect(repeat.repeatOfId).toBe(commented.id);
      expect(repeat.githubCommentId).toBeNull();

      const checks = github.completedCheckRuns();
      expect(checks.at(-1)!.output.summary).toContain('Nothing new to post. 1 was already commented on in an earlier review');
    });

    it('posts again when the code on that line changed', async () => {
      const original = diffs('pr3-synchronize.diff');
      github.pulls[`${REPO}#3`].diff = (_base: string, head: string) =>
        head === SECOND ? original.replace('+  debugger;', '+  debugger; // left in on purpose') : original;

      await pushTwice();

      expect(github.reviews).toHaveLength(2);
      expect(github.reviews[1].comments.map((c) => [c.path, c.line])).toEqual([['src/new-feature.ts', 2]]);
    });

    it('posts again a finding that had been resolved and came back', async () => {
      await deliver('pull_request', SYNC).expect(200);
      const first = await settledReview(sync.pull_request.head.sha);
      await prisma.finding.updateMany({ where: { reviewId: first!.id }, data: { status: 'RESOLVED' } });

      await deliver('pull_request', secondPush()).expect(200);
      await settledReview(SECOND);

      expect(github.reviews).toHaveLength(2);
    });
  });

  it('skips a PR over the size limit, with a skipped Check Run and no diff fetched', async () => {
    const opened = JSON.parse(OPENED_LARGE) as { pull_request: { head: { sha: string } } };

    await deliver('pull_request', OPENED_LARGE).expect(200);
    const review = await settledReview(opened.pull_request.head.sha);

    expect(review).toMatchObject({ status: ReviewStatus.SKIPPED, skipReason: '60 files to review, over the limit of 50' });
    expect(github.completedCheckRuns()[0].conclusion).toBe('skipped');
    expect(github.calls.some((c) => c.path.includes('/compare/'))).toBe(false);
  });

  it('retries a review that keeps failing, then records FAILED and a failure Check Run', async () => {
    github = fakeGithub({
      pulls: { [`${REPO}#3`]: { files: JSON.parse(diffs('pr3-synchronize.files.json')), diff: '' } },
      failCompare: { status: 502, message: 'Bad Gateway' },
    });
    vi.stubGlobal('fetch', github.fetch);

    await deliver('pull_request', SYNC).expect(200);
    const review = await settledReview(sync.pull_request.head.sha);

    expect(review?.status).toBe(ReviewStatus.FAILED);
    expect(review?.error).toContain('GitHub 502');
    expect(github.calls.filter((c) => c.path.includes('/compare/'))).toHaveLength(3); // every attempt
    expect(github.createdCheckRuns()).toHaveLength(1); // one spinner, reused by the retries
    expect(github.completedCheckRuns()).toEqual([expect.objectContaining({ conclusion: 'failure' })]);
  });
});
