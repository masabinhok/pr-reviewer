import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { GithubApiService } from '../github/github-api.service.js';
import { FindingStatus, ResolvedBy, type Finding } from '../generated/prisma/client.js';
import type { ReviewTarget } from './review.processor.js';

/**
 * Comments whose problem is gone.
 *
 * After a review of a pull request, an earlier review's comment is done with when **both**
 * are true:
 *
 * - **the code it pointed at has changed** — GitHub's `isOutdated` on the thread, which is
 *   its own answer to that question and needs no guessing on our side; and
 * - **this review didn't find it again** — no finding of this review is a repeat of it
 *   (M24's `repeatOfId`).
 *
 * Both, because either alone is wrong. A model that simply didn't repeat itself is not
 * evidence a bug was fixed — the local model's findings vary run to run — and code that
 * changed may still have the defect, which is exactly the case where the review finds it
 * again.
 *
 * Resolved means `status = RESOLVED` here, and the comment **collapsed as outdated** on
 * GitHub. Resolving the thread itself would be better, but `resolveReviewThread` is refused
 * for an installation token unless the App may write repository contents, which a reviewer
 * should not have (docs/decisions.md). Collapsing is best-effort: the database is the record,
 * and a failure to collapse is logged, never fatal to the review.
 */
@Injectable()
export class StaleFindings {
  private readonly logger = new Logger(StaleFindings.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubApiService,
  ) {}

  /** Resolves what this review made stale. Returns how many. */
  async resolve(target: ReviewTarget, findings: Finding[]): Promise<number> {
    const open = await this.prisma.finding.findMany({
      where: {
        status: FindingStatus.OPEN,
        githubCommentId: { not: null },
        reviewId: { not: target.reviewId },
        review: { prNumber: target.prNumber, repo: { fullName: target.repo } },
      },
      select: { id: true, githubCommentId: true, filePath: true, line: true },
    });
    if (open.length === 0) return 0;

    const foundAgain = new Set(findings.map((f) => f.repeatOfId).filter((id): id is string => id !== null));
    const candidates = open.filter((f) => !foundAgain.has(f.id));
    if (candidates.length === 0) return 0;

    const threads = await this.github.listReviewThreads(target.installationId, target.repo, target.prNumber);
    const outdated = new Map(threads.filter((t) => t.isOutdated).map((t) => [String(t.commentId), t]));

    const stale = candidates.filter((f) => outdated.has(String(f.githubCommentId)));
    if (stale.length === 0) return 0;

    await this.prisma.finding.updateMany({
      where: { id: { in: stale.map((f) => f.id) } },
      data: { status: FindingStatus.RESOLVED, resolvedAt: new Date(), resolvedBy: ResolvedBy.APP },
    });

    for (const finding of stale) {
      const thread = outdated.get(String(finding.githubCommentId))!;
      if (thread.isMinimized) continue;
      try {
        await this.github.minimizeComment(target.installationId, thread.commentNodeId);
      } catch (e) {
        // The row already says resolved; a comment left expanded is untidy, not wrong.
        this.logger.warn(`review ${target.reviewId}: could not collapse the comment on ${finding.filePath}:${finding.line}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    this.logger.log(
      `review ${target.reviewId}: resolved ${stale.length} earlier finding(s) whose code changed: ${stale.map((f) => `${f.filePath}:${f.line}`).join(', ')}`,
    );
    return stale.length;
  }

  /**
   * Someone resolved or reopened a thread on GitHub. Their decision wins over ours: a
   * resolved thread's findings are RESOLVED, and reopening one puts them back to OPEN.
   */
  async setResolvedByPerson(commentIds: bigint[], resolved: boolean): Promise<number> {
    if (commentIds.length === 0) return 0;
    const { count } = await this.prisma.finding.updateMany({
      where: { githubCommentId: { in: commentIds } },
      data: resolved
        ? { status: FindingStatus.RESOLVED, resolvedAt: new Date(), resolvedBy: ResolvedBy.PERSON }
        : { status: FindingStatus.OPEN, resolvedAt: null, resolvedBy: null },
    });
    return count;
  }
}
