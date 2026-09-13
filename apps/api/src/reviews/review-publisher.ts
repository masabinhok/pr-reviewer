import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { GithubApiService, type ReviewCommentInput } from '../github/github-api.service.js';
import { GithubApiError } from '../github/github-api.errors.js';
import { Severity, type Finding } from '../generated/prisma/client.js';
import type { ReviewTarget } from './review.processor.js';

export const SEVERITY_RANK: Record<Severity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

export interface Publication {
  /** Comments in the posted (or adopted) review; 0 when nothing met the severity gate. */
  posted: number;
  url: string | null;
  /** The gate that applied: the least severe finding that is posted. */
  minSeverity: Severity;
}

/**
 * Turns stored findings into one GitHub review on the PR — once.
 *
 * - **Severity gate**: findings at or above POST_MIN_SEVERITY (high, by default) become
 *   inline comments; the rest are stored and shown only in the Check Run.
 * - **One review**, `event: COMMENT`, with every comment in it: one notification, not twelve.
 * - **Posted once**: `Review.githubReviewId` is stored right after posting, and a retry that
 *   finds it posts nothing. For the gap between posting and storing (a crash in between),
 *   the review body carries a hidden marker with our review ID, and a retry first looks for
 *   a review with that marker on the PR and adopts it instead of posting a second one.
 */
@Injectable()
export class ReviewPublisher {
  private readonly logger = new Logger(ReviewPublisher.name);

  private readonly minSeverity: Severity;

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubApiService,
    config: ConfigService,
  ) {
    this.minSeverity = config.getOrThrow<Severity>('posting.minSeverity');
  }

  async publish(target: ReviewTarget, findings: Finding[]): Promise<Publication> {
    const { installationId, repo, prNumber, reviewId } = target;
    const bar = this.minSeverity;
    const postable = findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[bar]);

    const review = await this.prisma.review.findUniqueOrThrow({
      where: { id: reviewId },
      select: { githubReviewId: true },
    });
    if (review.githubReviewId !== null) {
      this.logger.log(`review ${reviewId}: already posted as GitHub review ${review.githubReviewId}`);
      return { posted: postable.length, url: null, minSeverity: bar };
    }
    if (postable.length === 0) {
      return { posted: 0, url: null, minSeverity: bar };
    }

    const marker = reviewMarker(reviewId);
    const existing = (await this.github.listReviews(installationId, repo, prNumber)).find((r) => r.body?.includes(marker));

    let posted: { id: number; html_url: string };
    if (existing) {
      this.logger.warn(`review ${reviewId}: found GitHub review ${existing.id} from an earlier attempt; adopting it`);
      posted = existing;
    } else {
      try {
        posted = await this.github.createReview(installationId, repo, prNumber, {
          commitId: target.headSha,
          body: reviewBody(postable, findings.length - postable.length, marker),
          comments: postable.map(toComment),
        });
      } catch (e) {
        // Every comment was validated against the diff, so a 422 here is a bug in that
        // validation — the same request will be refused again. Don't retry it.
        if (e instanceof GithubApiError && e.status === 422) throw new UnrecoverableError(e.message);
        throw e;
      }
    }

    await this.prisma.review.update({ where: { id: reviewId }, data: { githubReviewId: BigInt(posted.id) } });
    await this.recordCommentIds(target, BigInt(posted.id), postable);

    this.logger.log(`review ${reviewId}: posted ${postable.length} comment(s) as GitHub review ${posted.id}`);
    return { posted: postable.length, url: posted.html_url, minSeverity: bar };
  }

  /** Links each posted finding to its comment — weeks 7–8 read reactions off these. */
  private async recordCommentIds(target: ReviewTarget, githubReviewId: bigint, postable: Finding[]) {
    const comments = await this.github.listReviewComments(target.installationId, target.repo, target.prNumber, githubReviewId);
    const unclaimed = [...comments];

    for (const finding of postable) {
      const index = unclaimed.findIndex(
        (c) => c.path === finding.filePath && c.line === finding.line && (c.side ?? 'RIGHT') === finding.side,
      );
      if (index === -1) continue;
      const [comment] = unclaimed.splice(index, 1);
      await this.prisma.finding.update({ where: { id: finding.id }, data: { githubCommentId: BigInt(comment.id) } });
    }
  }
}

export function reviewMarker(reviewId: string): string {
  return `<!-- pr-reviewer review:${reviewId} -->`;
}

const SEVERITY_LABEL: Record<Severity, string> = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

export function commentBody(finding: Pick<Finding, 'severity' | 'category' | 'summary' | 'whyItBreaks' | 'suggestedFix'>): string {
  const parts = [`**${SEVERITY_LABEL[finding.severity]}** · ${finding.category} — ${finding.summary}`, finding.whyItBreaks];
  if (finding.suggestedFix) parts.push(`**Suggested fix:** ${finding.suggestedFix}`);
  return parts.join('\n\n');
}

export function reviewBody(postable: Finding[], lowCount: number, marker: string): string {
  const high = postable.filter((f) => f.severity === Severity.HIGH).length;
  const medium = postable.length - high;
  const counts = [high && `${high} high`, medium && `${medium} medium`].filter(Boolean).join(', ');
  const low = lowCount ? ` ${lowCount} lower-severity note${lowCount === 1 ? ' is' : 's are'} in the pr-reviewer check.` : '';
  return `pr-reviewer found ${postable.length} issue${postable.length === 1 ? '' : 's'} (${counts}).${low}\n\n${marker}`;
}

function toComment(finding: Finding): ReviewCommentInput {
  return { path: finding.filePath, line: finding.line, side: finding.side, body: commentBody(finding) };
}
