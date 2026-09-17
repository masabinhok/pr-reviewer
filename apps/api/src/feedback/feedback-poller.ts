import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { GithubApiService, type Reaction } from '../github/github-api.service.js';
import { GithubRateLimitError } from '../github/github-api.errors.js';
import { FeedbackSignal } from '../generated/prisma/client.js';

/** Comments are polled for this long after their review finished; reactions come early. */
export const FEEDBACK_WINDOW_DAYS = 14;

export interface PollSummary {
  checked: number;
  unchanged: number;
  updated: number;
  gone: number;
  /** Installations skipped for the rest of this round because GitHub rate-limited them. */
  rateLimited: number;
}

/**
 * 👍 and 👎 on the App's comments, collected as feedback.
 *
 * GitHub has **no webhook for reactions**, so this is polled (FeedbackProcessor runs it on a
 * schedule). Politely: each comment is asked with the ETag from last time, and an unchanged
 * one answers 304, which GitHub doesn't count against the rate limit. So a quiet PR costs
 * nothing, and only a comment someone reacted to costs a request.
 *
 * What counts:
 * - `+1` is UP and `-1` is DOWN; every other reaction is not feedback on whether the comment
 *   was right, and is ignored.
 * - Bots don't vote — including this App.
 * - One signal per person per finding. GitHub lets someone leave both 👍 and 👎; their latest
 *   one is what they think now.
 * - A reaction taken back removes the feedback; the Feedback rows always match the comment.
 * - A comment deleted on GitHub (404) is marked gone and never polled again.
 */
@Injectable()
export class FeedbackPoller {
  private readonly logger = new Logger(FeedbackPoller.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubApiService,
  ) {}

  async pollOnce(now = new Date()): Promise<PollSummary> {
    const since = new Date(now.getTime() - FEEDBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const findings = await this.prisma.finding.findMany({
      where: {
        githubCommentId: { not: null },
        commentGoneAt: null,
        review: {
          completedAt: { gte: since },
          repo: { deletedAt: null, installation: { deletedAt: null, suspendedAt: null } },
        },
      },
      select: {
        id: true,
        githubCommentId: true,
        reactionsEtag: true,
        review: { select: { repo: { select: { fullName: true, installation: { select: { githubId: true } } } } } },
      },
    });

    const summary: PollSummary = { checked: 0, unchanged: 0, updated: 0, gone: 0, rateLimited: 0 };
    const limited = new Set<bigint>();

    for (const finding of findings) {
      const installationId = finding.review.repo.installation.githubId;
      if (limited.has(installationId)) continue;

      let answer;
      try {
        answer = await this.github.listCommentReactions(installationId, finding.review.repo.fullName, finding.githubCommentId!, finding.reactionsEtag);
      } catch (e) {
        if (e instanceof GithubRateLimitError) {
          // Stop asking for this installation until the next round; the rest can go on.
          limited.add(installationId);
          summary.rateLimited++;
          continue;
        }
        throw e;
      }
      summary.checked++;

      if (answer.kind === 'unchanged') {
        summary.unchanged++;
      } else if (answer.kind === 'gone') {
        await this.prisma.finding.update({ where: { id: finding.id }, data: { commentGoneAt: now } });
        summary.gone++;
      } else {
        await this.apply(finding.id, answer.reactions, answer.etag);
        summary.updated++;
      }
    }

    if (summary.updated || summary.gone || summary.rateLimited) {
      this.logger.log(
        `feedback: ${summary.checked} comment(s) checked, ${summary.updated} with new reactions, ${summary.gone} gone, ${summary.unchanged} unchanged` +
          (summary.rateLimited ? `, ${summary.rateLimited} installation(s) rate-limited` : ''),
      );
    }
    return summary;
  }

  /** Makes the finding's Feedback rows say exactly what the comment's reactions say now. */
  private async apply(findingId: string, reactions: Reaction[], etag: string | null): Promise<void> {
    const signals = signalsByUser(reactions);

    await this.prisma.$transaction(async (tx) => {
      await tx.feedback.deleteMany({ where: { findingId, githubUserId: { notIn: [...signals.keys()] } } });
      for (const [githubUserId, { signal, reactedAt }] of signals) {
        await tx.feedback.upsert({
          where: { findingId_githubUserId: { findingId, githubUserId } },
          create: { findingId, githubUserId, signal, reactedAt },
          update: { signal, reactedAt },
        });
      }
      await tx.finding.update({ where: { id: findingId }, data: { reactionsEtag: etag } });
    });
  }
}

/** Each person's latest 👍 or 👎; everything else — other reactions, bots — dropped. */
export function signalsByUser(reactions: Reaction[]): Map<bigint, { signal: FeedbackSignal; reactedAt: Date }> {
  const signals = new Map<bigint, { signal: FeedbackSignal; reactedAt: Date }>();
  for (const reaction of reactions) {
    const signal = reaction.content === '+1' ? FeedbackSignal.UP : reaction.content === '-1' ? FeedbackSignal.DOWN : null;
    if (!signal || reaction.user.type === 'Bot') continue;
    const current = signals.get(reaction.user.id);
    if (!current || reaction.createdAt > current.reactedAt) {
      signals.set(reaction.user.id, { signal, reactedAt: reaction.createdAt });
    }
  }
  return signals;
}
