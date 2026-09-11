import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma, ReviewStatus } from '../generated/prisma/client.js';
import type { PullRequestPayload } from './pull-request-payload.js';
import { retryOnUniqueViolation } from '../prisma/unique-violation.js';
import { REVIEW_QUEUE, reviewJobId, type ReviewJobData } from './review-queue.js';

export type PullRequestOutcome =
  | 'enqueued'
  | 'already-reviewing'
  | 'draft'
  | 'unknown-installation';

/**
 * Turns a `pull_request` webhook into a queued review. Everything slow happens in the
 * worker; this runs inside the webhook request, so it only writes rows and enqueues.
 * Which actions reach it is decided by the dispatch table in WebhooksService.
 */
@Injectable()
export class PullRequestsService {
  private readonly logger = new Logger(PullRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(REVIEW_QUEUE) private readonly queue: Queue<ReviewJobData>,
  ) {}

  async handle(payload: PullRequestPayload, deliveryId: string): Promise<PullRequestOutcome> {
    const { number: prNumber, pull_request: pr, repository } = payload;
    const where = `[${deliveryId}] ${repository.full_name}#${prNumber}`;

    // Drafts are recorded (the delivery row) but not reviewed; `ready_for_review`
    // arrives when the author un-drafts it, and that enqueues.
    if (pr.draft) {
      this.logger.log(`${where}: draft, not reviewing until ready_for_review`);
      return 'draft';
    }

    const installation = payload.installation
      ? await this.prisma.installation.findUnique({
          where: { githubId: BigInt(payload.installation.id) },
        })
      : null;
    if (!installation) {
      // The pull_request payload carries only the installation's ID, not its account, so
      // there is not enough here to create the row. installation.created does that.
      this.logger.warn(
        `${where}: installation ${payload.installation?.id ?? '(none)'} is not recorded — reinstall the App to record it`,
      );
      return 'unknown-installation';
    }

    // Two deliveries for a repo the app has never seen can race here; see the helper.
    const repo = await retryOnUniqueViolation(() => this.prisma.repo.upsert({
      where: { githubId: BigInt(repository.id) },
      create: {
        githubId: BigInt(repository.id),
        installationId: installation.id,
        fullName: repository.full_name,
        private: repository.private,
        defaultBranch: repository.default_branch,
      },
      // The first place the app learns a repo's default branch: installation payloads
      // don't carry it (see the Repo.defaultBranch entry in docs/decisions.md).
      update: {
        installationId: installation.id,
        fullName: repository.full_name,
        private: repository.private,
        defaultBranch: repository.default_branch,
        deletedAt: null,
      },
    }));

    const review = await this.createReview(repo.id, prNumber, pr.base.sha, pr.head.sha);
    if (review.existing && review.status !== ReviewStatus.PENDING) {
      this.logger.log(`${where}: ${short(pr.head.sha)} already reviewed (${review.status})`);
      return 'already-reviewing';
    }

    // Also runs for an existing PENDING review: if an earlier attempt wrote the row but
    // failed to enqueue, this repairs it — and if the job does exist, BullMQ ignores the
    // add, because the job ID is derived from the review.
    await this.queue.add('review', { reviewId: review.id }, { jobId: reviewJobId(review.id) });

    this.logger.log(
      `${where}: ${review.existing ? 're-enqueued pending' : 'enqueued'} review ${review.id} for ${short(pr.head.sha)}`,
    );
    return review.existing ? 'already-reviewing' : 'enqueued';
  }

  /**
   * Insert-first, like WebhookDelivery: `@@unique([repoId, prNumber, headSha])` decides
   * whether this commit is already being reviewed, so two deliveries about the same push
   * (say `opened` and `synchronize` racing) can't both create a review.
   */
  private async createReview(repoId: string, prNumber: number, baseSha: string, headSha: string) {
    try {
      const created = await this.prisma.review.create({
        data: { repoId, prNumber, baseSha, headSha, status: ReviewStatus.PENDING },
      });
      return { id: created.id, status: created.status, existing: false };
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;

      const found = await this.prisma.review.findUniqueOrThrow({
        where: { repoId_prNumber_headSha: { repoId, prNumber, headSha } },
      });
      return { id: found.id, status: found.status, existing: true };
    }
  }
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
