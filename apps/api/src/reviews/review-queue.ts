import type { DefaultJobOptions } from 'bullmq';

export const REVIEW_QUEUE = 'review-pr';

/**
 * The whole job payload. The worker loads everything else — repo, PR, SHAs — from the
 * database when it runs, so a job that waits in Redis never carries stale PR data.
 */
export interface ReviewJobData {
  reviewId: string;
}

/**
 * One job per Review row. Adding a job whose ID already exists is a no-op in BullMQ, so
 * enqueueing the same review twice — a retried webhook, a race — produces one job.
 */
export function reviewJobId(reviewId: string): string {
  return `review-${reviewId}`;
}

export const REVIEW_JOB_ATTEMPTS = 3;

export function reviewJobOptions(retryDelayMs: number): DefaultJobOptions {
  return {
    attempts: REVIEW_JOB_ATTEMPTS,
    // By default 10s, then 20s: long enough for a GitHub blip or a restart to pass.
    backoff: { type: 'exponential', delay: retryDelayMs },
    // Keep finished jobs long enough to debug with, then let Redis forget them. The
    // Review row is the durable record; the job is just the transport.
    removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  };
}
