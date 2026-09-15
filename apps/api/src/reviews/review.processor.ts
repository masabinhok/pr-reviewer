import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { FindingStatus, ReviewStatus } from '../generated/prisma/client.js';
import { REVIEW_QUEUE, type ReviewJobData } from './review-queue.js';
import { GithubRateLimitError } from '../github/github-api.errors.js';
import { GithubApiService } from '../github/github-api.service.js';
import { CHECK_RUN_NAME, renderCheck, type CheckResult } from './check-summary.js';
import type { ReviewOutcome } from './review-outcome.js';
import { ReviewPipeline } from './review-pipeline.js';
import { ReviewPublisher, type Publication } from './review-publisher.js';
import type { ValidFinding } from '../reviewer/validate-findings.js';
import type { Finding } from '../generated/prisma/client.js';
import { PullRequestLock } from './pull-request-lock.js';

/** How long a review waits before trying again when another review of its PR is settling. */
const BUSY_RETRY_MS = 2_000;

/** Another review of the same PR holds the settle lock; not a failure, a wait. */
export class PullRequestBusyError extends Error {}

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
    private readonly lock: PullRequestLock,
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
      if (e instanceof PullRequestBusyError) {
        await this.waitForPullRequest(job, token);
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
   *    recorded on them) instead of rewriting them. A finding already commented on in an
   *    earlier review of the PR is written as a repeat of it, and is not posted again;
   * 2. the review is posted on the PR once (ReviewPublisher);
   * 3. the Check Run is completed — *before* the row settles, because a row that says
   *    COMPLETED makes a retry skip the review, and the spinner would never stop;
   * 4. the row is marked COMPLETED, last.
   *
   * Steps 1 and 2 hold the PR's settle lock (PullRequestLock), so two reviews of one PR never
   * decide what is a repeat at the same moment.
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

    const release = await this.lock.acquire(target.repo, target.prNumber);
    if (!release) throw new PullRequestBusyError(`${target.repo}#${target.prNumber} is being settled by another review`);
    let publication: Publication;
    let findings: Finding[];
    try {
      findings = await this.storeFindings(target, outcome.findings);
      publication = await this.publisher.publish(target, findings);
    } finally {
      await release();
    }

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

  /**
   * The review's Finding rows: written the first time, returned as they are after that.
   *
   * Each new finding whose anchor matches an open finding that an earlier review of this PR
   * posted is written as a repeat of that one (`repeatOfId`), and the publisher skips it. A
   * resolved finding that comes back is not a match: it is new again, and is posted.
   */
  private storeFindings(target: ReviewTarget, findings: ValidFinding[]): Promise<Finding[]> {
    const { reviewId } = target;
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.finding.findMany({ where: { reviewId }, orderBy: [{ filePath: 'asc' }, { line: 'asc' }] });
      if (existing.length > 0) return existing;

      const anchors = [...new Set(findings.map((f) => f.anchor).filter((a): a is string => a !== null))];
      const commented = anchors.length
        ? await tx.finding.findMany({
            where: {
              anchor: { in: anchors },
              githubCommentId: { not: null },
              status: FindingStatus.OPEN,
              reviewId: { not: reviewId },
              review: { prNumber: target.prNumber, repo: { fullName: target.repo } },
            },
            orderBy: { review: { startedAt: 'asc' } },
            select: { id: true, anchor: true },
          })
        : [];
      // The first comment on that code is the one a repeat points at.
      const original = new Map<string, string>();
      for (const c of commented) if (c.anchor && !original.has(c.anchor)) original.set(c.anchor, c.id);

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
          anchor: f.anchor,
          repeatOfId: (f.anchor && original.get(f.anchor)) || null,
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
  /** Another review of this PR is storing or posting: try again shortly, spending no attempt. */
  private async waitForPullRequest(job: Job<ReviewJobData>, token: string | undefined): Promise<never> {
    await job.moveToDelayed(Date.now() + BUSY_RETRY_MS, token);
    this.logger.log(`review ${job.data.reviewId}: another review of this PR is settling — waiting`);
    throw new DelayedError();
  }

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
