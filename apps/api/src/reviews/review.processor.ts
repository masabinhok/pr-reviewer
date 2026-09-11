import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReviewStatus } from '../generated/prisma/client.js';
import { REVIEW_QUEUE, type ReviewJobData } from './review-queue.js';
import { GithubRateLimitError } from '../github/github-api.errors.js';

/**
 * The review worker. It runs inside the API process for now (see docs/decisions.md);
 * moving it to its own process later changes where this class is registered, nothing
 * in it.
 */
@Processor(REVIEW_QUEUE, { concurrency: 2 })
export class ReviewProcessor extends WorkerHost {
  private readonly logger = new Logger(ReviewProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<ReviewJobData>, token?: string): Promise<void> {
    const { reviewId } = job.data;
    const attempt = `attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1}`;

    const review = await this.prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) {
      this.logger.warn(`review ${reviewId}: row is gone, nothing to do`);
      return;
    }
    if (SETTLED.has(review.status)) {
      this.logger.log(`review ${reviewId}: already ${review.status}, skipping`);
      return;
    }

    await this.prisma.review.update({
      where: { id: reviewId },
      data: { status: ReviewStatus.RUNNING, startedAt: new Date(), error: null },
    });
    this.logger.log(`review ${reviewId}: running (${attempt})`);

    try {
      await this.run(review.id);
    } catch (e) {
      if (e instanceof GithubRateLimitError) {
        await this.waitForRateLimit(job, token, e);
      }

      const message = e instanceof Error ? e.message : String(e);

      // Only the last attempt settles the row. Earlier failures leave it RUNNING and let
      // BullMQ retry; marking it FAILED then would make the retry skip it.
      if (isFinalAttempt(job)) {
        await this.prisma.review.update({
          where: { id: reviewId },
          data: { status: ReviewStatus.FAILED, error: message, completedAt: new Date() },
        });
        this.logger.error(`review ${reviewId}: failed for good (${attempt}): ${message}`);
      } else {
        this.logger.warn(`review ${reviewId}: ${attempt} failed, will retry: ${message}`);
      }
      throw e;
    }

    await this.prisma.review.update({
      where: { id: reviewId },
      data: { status: ReviewStatus.COMPLETED, completedAt: new Date() },
    });
    this.logger.log(`review ${reviewId}: completed`);
  }

  /**
   * GitHub asked us to slow down. That is not a failure of the review, so it must not use
   * up one of the job's attempts: move the job to the delayed set until GitHub's reset
   * time and throw DelayedError, which BullMQ treats as "rescheduled", not "failed". The
   * review goes back to PENDING — it is waiting, not running.
   */
  private async waitForRateLimit(job: Job<ReviewJobData>, token: string | undefined, error: GithubRateLimitError): Promise<never> {
    // Never schedule into the past (clock skew), and never busy-loop on a reset "now".
    const until = Math.max(error.retryAt.getTime(), Date.now() + 1000);

    await this.prisma.review.update({
      where: { id: job.data.reviewId },
      data: { status: ReviewStatus.PENDING },
    });
    await job.moveToDelayed(until, token);
    this.logger.warn(
      `review ${job.data.reviewId}: GitHub ${error.kind} rate limit — waiting until ${new Date(until).toISOString()}`,
    );
    throw new DelayedError();
  }

  /**
   * The pipeline. A skeleton until milestones 10–14 fill it in: fetch the diff, parse it,
   * filter it, run the reviewer, store findings, report through a Check Run.
   */
  protected async run(_reviewId: string): Promise<void> {}
}

/** A review in one of these states is finished; a stray job for it does nothing. */
const SETTLED = new Set<ReviewStatus>([ReviewStatus.COMPLETED, ReviewStatus.FAILED, ReviewStatus.SKIPPED]);

function isFinalAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}
