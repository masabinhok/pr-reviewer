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
import type { PullRequestPayload } from '../src/reviews/pull-request-payload.js';
import { fixtureJson } from './helpers/fixtures.js';
import { truncateAll } from './helpers/db.js';

/**
 * The queue path against real Postgres and a real Redis, with the worker running:
 * a pull_request becomes one Review row and one job, and the worker settles it.
 */
const opened = fixtureJson<PullRequestPayload>('pull_request.opened');

function withHead(sha: string, overrides: Partial<PullRequestPayload['pull_request']> = {}): PullRequestPayload {
  return { ...opened, pull_request: { ...opened.pull_request, head: { sha }, ...overrides } };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Review queue (real Postgres, Redis and worker)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: PullRequestsService;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], envFilePath: '../../.env' }),
        PrismaModule,
        ReviewsModule,
      ],
    }).compile();
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
    await queue.obliterate({ force: true });
    await truncateAll(prisma);
    await prisma.installation.create({
      data: { githubId: BigInt(opened.installation!.id), accountLogin: 'masabinhok', accountType: 'User' },
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
  });

  // Two different deliveries about the same commit — e.g. `opened` and a `synchronize`
  // for the same head racing each other.
  it('creates one review and one job when two deliveries race about the same commit', async () => {
    const results = await Promise.all([service.handle(opened, 'd-2'), service.handle(opened, 'd-3')]);

    expect(results.sort()).toEqual(['already-reviewing', 'enqueued']);
    expect(await prisma.review.count()).toBe(1);
    expect((await queue.getJobs(['waiting', 'active', 'completed', 'delayed'])).length).toBe(1);
  });

  it('creates a second review when a push moves the head to a new commit', async () => {
    await service.handle(opened, 'd-4');
    await service.handle(withHead('1111111111111111111111111111111111111111'), 'd-5');

    const heads = (await prisma.review.findMany()).map((r) => r.headSha).sort();
    expect(heads).toEqual(['1111111111111111111111111111111111111111', opened.pull_request.head.sha].sort());
  });

  it('records the default branch the installation payload never had', async () => {
    await service.handle(opened, 'd-6');

    const repo = await prisma.repo.findUniqueOrThrow({ where: { githubId: BigInt(opened.repository.id) } });
    expect(repo.defaultBranch).toBe(opened.repository.default_branch);
  });

  // The job has 3 attempts. Being rate limited 3 times and still completing proves the
  // waits did not spend them — against real BullMQ, not a mocked job.
  it('waits out rate limits without spending the job’s attempts', async () => {
    const processor = module.get(ReviewProcessor) as unknown as { run: () => Promise<void> };
    const limited = () => new GithubRateLimitError('secondary', new Date(Date.now() + 200), '/x');
    const run = vi
      .spyOn(processor, 'run')
      .mockRejectedValueOnce(limited())
      .mockRejectedValueOnce(limited())
      .mockRejectedValueOnce(limited())
      .mockResolvedValueOnce(undefined);

    await service.handle(opened, 'd-8');
    const review = await prisma.review.findFirstOrThrow();

    const settled = await until(
      () => prisma.review.findUniqueOrThrow({ where: { id: review.id } }),
      (r) => r.status === ReviewStatus.COMPLETED || r.status === ReviewStatus.FAILED,
      10_000,
    );
    expect(settled.status).toBe(ReviewStatus.COMPLETED);
    expect(run).toHaveBeenCalledTimes(4);
    run.mockRestore();
  });

  it('does not create a review for a draft', async () => {
    await service.handle(withHead(opened.pull_request.head.sha, { draft: true }), 'd-7');

    expect(await prisma.review.count()).toBe(0);
  });
});
