import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import configuration from '../src/config/configuration.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ReviewsModule } from '../src/reviews/reviews.module.js';
import { PullRequestsService } from '../src/reviews/pull-requests.service.js';
import { REVIEW_QUEUE, reviewJobId } from '../src/reviews/review-queue.js';
import { ReviewStatus } from '../src/generated/prisma/client.js';
import { ReviewProcessor } from '../src/reviews/review.processor.js';
import { GithubRateLimitError } from '../src/github/github-api.errors.js';
import { GithubApiService } from '../src/github/github-api.service.js';
import { REVIEWER, type ReviewContext } from '../src/reviewer/reviewer.js';
import { StubReviewer } from '../src/reviewer/stub-reviewer.js';
import type { PullRequestPayload } from '../src/reviews/pull-request-payload.js';
import { fixtureJson } from './helpers/fixtures.js';
import { truncateAll } from './helpers/db.js';

/**
 * The queue path against real Postgres and a real Redis, with the worker running:
 * a pull_request becomes one Review row and one job, and the worker settles it.
 */
const opened = fixtureJson<PullRequestPayload>('pull_request.opened');

function withHead(
  sha: string,
  overrides: Partial<PullRequestPayload['pull_request']> = {},
): PullRequestPayload {
  return {
    ...opened,
    pull_request: { ...opened.pull_request, head: { sha }, ...overrides },
  };
}

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms = 5000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// GitHub is replaced with the real testbed PR's captured files and diff, so the worker runs
// the whole pipeline — filters, parser, stub reviewer, validation — and stores real findings.
const diffFixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/diffs/${name}`, import.meta.url)),
    'utf8',
  );
const github = {
  createCheckRun: vi.fn().mockResolvedValue({ id: 4242 }),
  completeCheckRun: vi.fn().mockResolvedValue(undefined),
  listPullRequestFiles: vi
    .fn()
    .mockResolvedValue(JSON.parse(diffFixture('diff-shapes.files.json'))),
  getDiff: vi.fn().mockResolvedValue(diffFixture('diff-shapes.diff')),
  getPullRequest: vi
    .fn()
    .mockResolvedValue({ title: 'Diff shapes', body: null }),
  listReviews: vi.fn().mockResolvedValue([]),
  createReview: vi.fn().mockResolvedValue({
    id: 7001,
    html_url: 'https://github.com/o/r/pull/1#pullrequestreview-7001',
  }),
  listReviewComments: vi.fn().mockResolvedValue([]),
};

const stub = new StubReviewer();
const reviewer = {
  review: vi.fn((context: ReviewContext) => stub.review(context)),
};

describe('Review queue (real Postgres, Redis and worker)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: PullRequestsService;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
          envFilePath: '../../.env',
        }),
        PrismaModule,
        ReviewsModule,
      ],
    })
      // The worker talks to GitHub for its Check Run. The queue, the rows and the worker
      // are real here; GitHub is not — only whether the worker called it is checked.
      .overrideProvider(GithubApiService)
      .useValue(github)
      // The stub, counted: how many times the pipeline asked for a review.
      .overrideProvider(REVIEWER)
      .useValue(reviewer)
      .compile();
    await module.init(); // starts the worker

    prisma = module.get(PrismaService);
    service = module.get(PullRequestsService);
    queue = module.get(getQueueToken(REVIEW_QUEUE));

    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    for (const fn of [
      github.createCheckRun,
      github.completeCheckRun,
      reviewer.review,
    ])
      fn.mockClear();
    await queue.obliterate({ force: true });
    await truncateAll(prisma);
    await prisma.installation.create({
      data: {
        githubId: BigInt(opened.installation!.id),
        accountLogin: 'masabinhok',
        accountType: 'User',
      },
    });
  });

  it('turns a pull_request into one review, one job, and the worker completes it', async () => {
    expect(await service.handle(opened, 'd-1')).toBe('enqueued');

    const review = await prisma.review.findFirstOrThrow();
    expect(review).toMatchObject({
      prNumber: opened.number,
      baseSha: opened.pull_request.base.sha,
      headSha: opened.pull_request.head.sha,
    });

    const job = await queue.getJob(reviewJobId(review.id));
    expect(job?.data).toEqual({ reviewId: review.id });

    const settled = await until(
      () => prisma.review.findUniqueOrThrow({ where: { id: review.id } }),
      (r) => r.status === ReviewStatus.COMPLETED,
    );
    expect(settled.status).toBe(ReviewStatus.COMPLETED);
    expect(settled.completedAt).toBeInstanceOf(Date);
    expect(settled.checkRunId).toBe(4242n);

    // The stub reviewer's three planted findings, stored against this review.
    const findings = await prisma.finding.findMany({
      where: { reviewId: review.id },
      orderBy: { filePath: 'asc' },
    });
    expect(
      findings.map((f) => [f.filePath, f.line, f.side, f.severity]),
    ).toEqual([
      ['src/auth.ts', 26, 'RIGHT', 'LOW'],
      ['src/helpers.ts', 10, 'RIGHT', 'LOW'],
      ['src/new-feature.ts', 2, 'RIGHT', 'MEDIUM'],
    ]);
    expect(github.completeCheckRun).toHaveBeenCalledWith(
      BigInt(opened.installation!.id),
      opened.repository.full_name,
      4242n,
      expect.objectContaining({ conclusion: 'success' }),
    );
  });

  // Two different deliveries about the same commit — e.g. `opened` and a `synchronize`
  // for the same head racing each other.
  it('creates one review and one job when two deliveries race about the same commit', async () => {
    const results = await Promise.all([
      service.handle(opened, 'd-2'),
      service.handle(opened, 'd-3'),
    ]);

    expect(results.sort()).toEqual(['already-reviewing', 'enqueued']);
    expect(await prisma.review.count()).toBe(1);
    expect(
      (await queue.getJobs(['waiting', 'active', 'completed', 'delayed']))
        .length,
    ).toBe(1);
  });

  it('creates a second review when a push moves the head to a new commit', async () => {
    await service.handle(opened, 'd-4');
    await service.handle(
      withHead('1111111111111111111111111111111111111111'),
      'd-5',
    );

    const heads = (await prisma.review.findMany()).map((r) => r.headSha).sort();
    expect(heads).toEqual(
      [
        '1111111111111111111111111111111111111111',
        opened.pull_request.head.sha,
      ].sort(),
    );
  });

  it('records the default branch the installation payload never had', async () => {
    await service.handle(opened, 'd-6');

    const repo = await prisma.repo.findUniqueOrThrow({
      where: { githubId: BigInt(opened.repository.id) },
    });
    expect(repo.defaultBranch).toBe(opened.repository.default_branch);
  });

  // The job has 3 attempts. Being rate limited 3 times and still completing proves the
  // waits did not spend them — against real BullMQ, not a mocked job.
  it('waits out rate limits without spending the job’s attempts', async () => {
    const processor = module.get(ReviewProcessor) as unknown as {
      run: () => Promise<unknown>;
    };
    const limited = () =>
      new GithubRateLimitError('secondary', new Date(Date.now() + 200), '/x');
    const run = vi
      .spyOn(processor, 'run')
      .mockRejectedValueOnce(limited())
      .mockRejectedValueOnce(limited())
      .mockRejectedValueOnce(limited())
      .mockResolvedValueOnce({
        kind: 'completed',
        reviewed: [],
        skipped: [],
        findings: [],
      });

    await service.handle(opened, 'd-8');
    const review = await prisma.review.findFirstOrThrow();

    const settled = await until(
      () => prisma.review.findUniqueOrThrow({ where: { id: review.id } }),
      (r) =>
        r.status === ReviewStatus.COMPLETED || r.status === ReviewStatus.FAILED,
      10_000,
    );
    expect(settled.status).toBe(ReviewStatus.COMPLETED);
    expect(run).toHaveBeenCalledTimes(4);
    run.mockRestore();
  });

  // The reviewer is the step that costs money. A job that fails after it answered —
  // here, GitHub refusing the Check Run update once — must not pay for it again on retry.
  it('does not call the reviewer again when a job is retried after it answered', async () => {
    github.completeCheckRun.mockRejectedValueOnce(
      new Error('GitHub 502 on /check-runs'),
    );

    await service.handle(opened, 'd-9');
    const review = await prisma.review.findFirstOrThrow();
    const settled = await until(
      () => prisma.review.findUniqueOrThrow({ where: { id: review.id } }),
      (r) =>
        r.status === ReviewStatus.COMPLETED || r.status === ReviewStatus.FAILED,
    );

    expect(settled.status).toBe(ReviewStatus.COMPLETED);
    expect(github.completeCheckRun).toHaveBeenCalledTimes(2); // failed once, then succeeded
    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect(settled.agentResult).toMatchObject({ findings: expect.any(Array) });
  });

  it('does not create a review for a draft', async () => {
    await service.handle(
      withHead(opened.pull_request.head.sha, { draft: true }),
      'd-7',
    );

    expect(await prisma.review.count()).toBe(0);
  });
});
