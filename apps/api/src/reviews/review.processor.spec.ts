import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ReviewProcessor } from './review.processor.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ReviewStatus } from '../generated/prisma/client.js';
import { DelayedError } from 'bullmq';
import { GithubRateLimitError } from '../github/github-api.errors.js';
import type { ReviewJobData } from './review-queue.js';

function job(attemptsMade = 0, attempts = 3) {
  return {
    data: { reviewId: 'rev-1' },
    attemptsMade,
    opts: { attempts },
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<ReviewJobData> & { moveToDelayed: ReturnType<typeof vi.fn> };
}

describe('ReviewProcessor', () => {
  let prisma: { review: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } };
  let processor: ReviewProcessor;
  let run: ReturnType<typeof vi.spyOn>;

  const statuses = () => prisma.review.update.mock.calls.map(([arg]) => arg.data.status);

  beforeEach(() => {
    prisma = {
      review: {
        findUnique: vi.fn().mockResolvedValue({ id: 'rev-1', status: ReviewStatus.PENDING }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    processor = new ReviewProcessor(prisma as unknown as PrismaService);
    // `run` is the pipeline; here only its outcome matters.
    run = vi.spyOn(processor as unknown as { run: () => Promise<void> }, 'run').mockResolvedValue();
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it('moves a review PENDING → RUNNING → COMPLETED', async () => {
    await processor.process(job());

    expect(run).toHaveBeenCalledWith('rev-1');
    expect(statuses()).toEqual([ReviewStatus.RUNNING, ReviewStatus.COMPLETED]);
  });

  it('does nothing when the review row no longer exists', async () => {
    prisma.review.findUnique.mockResolvedValue(null);

    await processor.process(job());

    expect(run).not.toHaveBeenCalled();
    expect(prisma.review.update).not.toHaveBeenCalled();
  });

  it.each([ReviewStatus.COMPLETED, ReviewStatus.FAILED, ReviewStatus.SKIPPED])('skips a review that is already %s', async (status) => {
    prisma.review.findUnique.mockResolvedValue({ id: 'rev-1', status });

    await processor.process(job());

    expect(run).not.toHaveBeenCalled();
  });

  // A retried attempt finds the row RUNNING from the attempt before — that must not stop it.
  it('runs a review left RUNNING by an earlier attempt', async () => {
    prisma.review.findUnique.mockResolvedValue({ id: 'rev-1', status: ReviewStatus.RUNNING });

    await processor.process(job(1));

    expect(statuses()).toEqual([ReviewStatus.RUNNING, ReviewStatus.COMPLETED]);
  });

  // Marking it FAILED here would make the retry skip it — only the last attempt settles it.
  it('leaves the review RUNNING and rethrows when an attempt fails with retries left', async () => {
    run.mockRejectedValue(new Error('GitHub 502'));

    await expect(processor.process(job(0, 3))).rejects.toThrow('GitHub 502');

    expect(statuses()).toEqual([ReviewStatus.RUNNING]);
  });

  // Even on the last attempt: waiting for GitHub is not a failure of the review.
  it('reschedules a rate-limited attempt for the reset time instead of failing it', async () => {
    const retryAt = new Date(Date.now() + 30 * 60_000);
    run.mockRejectedValue(new GithubRateLimitError('primary', retryAt, '/repos/o/r/pulls/1/files'));
    const finalAttempt = job(2, 3);

    await expect(processor.process(finalAttempt, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    expect(finalAttempt.moveToDelayed).toHaveBeenCalledWith(retryAt.getTime(), 'lock-token');
    expect(statuses()).toEqual([ReviewStatus.RUNNING, ReviewStatus.PENDING]);
  });

  it('marks the review FAILED with the error on the final attempt, and still rethrows', async () => {
    run.mockRejectedValue(new Error('GitHub 502'));

    await expect(processor.process(job(2, 3))).rejects.toThrow('GitHub 502');

    expect(statuses()).toEqual([ReviewStatus.RUNNING, ReviewStatus.FAILED]);
    expect(prisma.review.update.mock.calls[1][0].data).toMatchObject({ error: 'GitHub 502' });
  });
});
