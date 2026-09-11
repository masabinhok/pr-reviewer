import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReviewStatus } from '../generated/prisma/client.js';
import { REVIEW_QUEUE, type ReviewJobData } from './review-queue.js';

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

  async process(job: Job<ReviewJobData>): Promise<void> {
    const { reviewId } = job.data;
    const attempt = `attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1}`;

    const review = await this.prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) {
      this.logger.warn(`review ${reviewId}: row is gone, nothing to do`);
      return;
    }
    if (review.status === ReviewStatus.COMPLETED || review.status === ReviewStatus.FAILED) {
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
   * The pipeline. A skeleton until milestones 10–14 fill it in: fetch the diff, parse it,
   * filter it, run the reviewer, store findings, report through a Check Run.
   */
  protected async run(_reviewId: string): Promise<void> {}
}

function isFinalAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}
