import type { PrismaService } from '../prisma/prisma.service.js';
import { FeedbackSignal, type Prisma } from '../generated/prisma/client.js';

export interface FeedbackRate {
  /** Findings with a comment on GitHub that still exists. */
  posted: number;
  /** Of those, how many anyone reacted 👍 or 👎 to. */
  withFeedback: number;
  /** Findings with at least one 👍 / at least one 👎 — one finding can be in both. */
  upvoted: number;
  downvoted: number;
}

/**
 * How the App's comments are received — defined once, here, so the dashboard and anything
 * else report the same numbers. `where` narrows the findings (a repository, a time range).
 */
export async function feedbackRate(
  prisma: PrismaService,
  where: Prisma.FindingWhereInput = {},
): Promise<FeedbackRate> {
  const posted = {
    ...where,
    githubCommentId: { not: null },
    commentGoneAt: null,
  };
  const [total, withFeedback, upvoted, downvoted] = await Promise.all([
    prisma.finding.count({ where: posted }),
    prisma.finding.count({ where: { ...posted, feedbacks: { some: {} } } }),
    prisma.finding.count({
      where: { ...posted, feedbacks: { some: { signal: FeedbackSignal.UP } } },
    }),
    prisma.finding.count({
      where: {
        ...posted,
        feedbacks: { some: { signal: FeedbackSignal.DOWN } },
      },
    }),
  ]);
  return { posted: total, withFeedback, upvoted, downvoted };
}
