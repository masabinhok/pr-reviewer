import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReviewStatus } from '../generated/prisma/client.js';
import { REVIEW_QUEUE, type ReviewJobData } from './review-queue.js';
import { GithubRateLimitError } from '../github/github-api.errors.js';
import { GithubApiService } from '../github/github-api.service.js';
import { CHECK_RUN_NAME, renderCheck, type CheckResult } from './check-summary.js';
import type { ReviewOutcome } from './review-outcome.js';
import { ReviewPipeline } from './review-pipeline.js';
import { ReviewPublisher, type Publication } from './review-publisher.js';
import type { ValidFinding } from '../reviewer/validate-findings.js';
import type { Finding } from '../generated/prisma/client.js';

/** Everything the pipeline needs to know about the review it is running. */
export interface ReviewTarget {
  reviewId: string;
  installationId: bigint;
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
}

/**
 * The review worker. It runs inside the API process for now (see docs/decisions.md);
 * moving it to its own process later changes where this class is registered, nothing
 * in it.
 *
 * Around the pipeline it keeps two records in step: the Review row, and the Check Run on
 * the PR's head commit — created once per review, reused by retries, and always completed
 * when the review settles, so the PR never shows a spinner for a review that is over.
 */
@Processor(REVIEW_QUEUE, { concurrency: 2 })
export class ReviewProcessor extends WorkerHost {
  private readonly logger = new Logger(ReviewProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubApiService,
    private readonly pipeline: ReviewPipeline,
    private readonly publisher: ReviewPublisher,
  ) {
    super();
  }

  async process(job: Job<ReviewJobData>, token?: string): Promise<void> {
    const { reviewId } = job.data;
    const attempt = `attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1}`;

    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      include: { repo: { include: { installation: true } } },
    });
    if (!review) {
      this.logger.warn(`review ${reviewId}: row is gone, nothing to do`);
      return;
    }
    if (SETTLED.has(review.status)) {
      this.logger.log(`review ${reviewId}: already ${review.status}, skipping`);
      return;
    }

    const target: ReviewTarget = {
      reviewId,
      installationId: review.repo.installation.githubId,
      repo: review.repo.fullName,
      prNumber: review.prNumber,
      baseSha: review.baseSha,
      headSha: review.headSha,
    };

    await this.prisma.review.update({
      where: { id: reviewId },
      data: { status: ReviewStatus.RUNNING, startedAt: new Date(), error: null },
    });
    this.logger.log(`review ${reviewId}: running (${attempt})`);

    // A retry reuses the Check Run its first attempt created, rather than adding a second.
    let checkRunId = review.checkRunId;

    try {
      checkRunId ??= await this.startCheckRun(target);
      const outcome = await this.run(target);
      await this.settle(target, checkRunId, outcome);
    } catch (e) {
      if (e instanceof GithubRateLimitError) {
        await this.waitForRateLimit(job, token, e);
      }

      const message = e instanceof Error ? e.message : String(e);

      // Only the last attempt settles the row. Earlier failures leave it RUNNING and let
      // BullMQ retry; marking it FAILED then would make the retry skip it. The Check Run
      // keeps spinning meanwhile — the review really is still going.
      // UnrecoverableError makes BullMQ fail the job now, retries or not — so it is the
      // final attempt too, and must settle the row and stop the spinner like one.
      if (isFinalAttempt(job) || e instanceof UnrecoverableError) {
        await this.completeCheckRunQuietly(target, checkRunId, {
          kind: 'failed',
          error: message,
          attempts: job.attemptsMade + 1,
        });
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
  }

  /** The review itself — see ReviewPipeline. Separate so the lifecycle here can be tested alone. */
  protected async run(target: ReviewTarget): Promise<ReviewOutcome> {
    return this.pipeline.run(target);
  }

  private async startCheckRun(target: ReviewTarget): Promise<bigint> {
    const { id } = await this.github.createCheckRun(target.installationId, target.repo, {
      name: CHECK_RUN_NAME,
      headSha: target.headSha,
      externalId: target.reviewId,
    });
    const checkRunId = BigInt(id);
    await this.prisma.review.update({ where: { id: target.reviewId }, data: { checkRunId } });
    return checkRunId;
  }

  /**
   * Settling a completed review, in an order where every step is safe to repeat — a retry
   * after any of them failing redoes nothing that was already done:
   *
   * 1. findings are written once per review; a retry keeps the rows (and the comment IDs
   *    recorded on them) instead of rewriting them;
   * 2. the review is posted on the PR once (ReviewPublisher);
   * 3. the Check Run is completed — *before* the row settles, because a row that says
   *    COMPLETED makes a retry skip the review, and the spinner would never stop;
   * 4. the row is marked COMPLETED, last.
   */
  private async settle(target: ReviewTarget, checkRunId: bigint, outcome: ReviewOutcome): Promise<void> {
    if (outcome.kind === 'skipped') {
      await this.github.completeCheckRun(target.installationId, target.repo, checkRunId, renderCheck(outcome, target.headSha));
      await this.prisma.review.update({
        where: { id: target.reviewId },
        data: { status: ReviewStatus.SKIPPED, skipReason: outcome.reason, completedAt: new Date() },
      });
      this.logger.log(`review ${target.reviewId}: skipped — ${outcome.reason}`);
      return;
    }

    const findings = await this.storeFindings(target.reviewId, outcome.findings);
    const publication: Publication = await this.publisher.publish(target, findings);

    await this.github.completeCheckRun(
      target.installationId,
      target.repo,
      checkRunId,
      renderCheck(outcome, target.headSha, publication),
    );
    await this.prisma.review.update({
      where: { id: target.reviewId },
      data: { status: ReviewStatus.COMPLETED, completedAt: new Date() },
    });
    this.logger.log(
      `review ${target.reviewId}: completed — ${outcome.reviewed.length} file(s), ${findings.length} finding(s), ${publication.posted} posted`,
    );
  }

  /** The review's Finding rows: written the first time, returned as they are after that. */
  private storeFindings(reviewId: string, findings: ValidFinding[]): Promise<Finding[]> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.finding.findMany({ where: { reviewId }, orderBy: [{ filePath: 'asc' }, { line: 'asc' }] });
      if (existing.length > 0) return existing;

      await tx.finding.createMany({
        data: findings.map((f) => ({
          reviewId,
          filePath: f.path,
          line: f.line,
          side: f.side,
          severity: f.severity,
          category: f.category,
          summary: f.summary,
          whyItBreaks: f.whyItBreaks,
          suggestedFix: f.suggestedFix,
          fingerprint: f.fingerprint,
          verdict: f.verdict,
          verdictReason: f.verdictReason,
          demotedFrom: f.demotedFrom,
        })),
      });
      return tx.finding.findMany({ where: { reviewId }, orderBy: [{ filePath: 'asc' }, { line: 'asc' }] });
    });
  }

  /**
   * Completing the Check Run on the failure path must not mask the error that got us
   * here: if GitHub is the thing that's down, log it and move on to recording FAILED.
   */
  private async completeCheckRunQuietly(target: ReviewTarget, checkRunId: bigint | null, result: CheckResult): Promise<void> {
    if (checkRunId === null) return; // creating it was what failed
    try {
      await this.github.completeCheckRun(target.installationId, target.repo, checkRunId, renderCheck(result, target.headSha));
    } catch (e) {
      this.logger.error(`review ${target.reviewId}: could not complete Check Run ${checkRunId}: ${e instanceof Error ? e.message : e}`);
    }
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
}

/** A review in one of these states is finished; a stray job for it does nothing. */
const SETTLED = new Set<ReviewStatus>([ReviewStatus.COMPLETED, ReviewStatus.FAILED, ReviewStatus.SKIPPED]);

function isFinalAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}
