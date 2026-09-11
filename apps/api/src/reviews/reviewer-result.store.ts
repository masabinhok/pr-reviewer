import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ReviewerResult } from '../reviewer/reviewer.js';

/**
 * Keeps a reviewer's answer on the Review row the moment it arrives.
 *
 * A review job can fail *after* the reviewer answered — completing the Check Run, writing
 * the findings — and the retry runs the pipeline again. Without this, it would pay the
 * agent a second time for the same commit. With it, the retry finds the stored answer and
 * uses that. It is the one write the pipeline makes, because it is the one step that
 * spends money.
 */
@Injectable()
export class ReviewerResultStore {
  constructor(private readonly prisma: PrismaService) {}

  async load(reviewId: string): Promise<ReviewerResult | null> {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: { agentResult: true },
    });
    return (review?.agentResult as ReviewerResult | null | undefined) ?? null;
  }

  async save(reviewId: string, result: ReviewerResult): Promise<void> {
    const usage = result.run?.usage;
    await this.prisma.review.update({
      where: { id: reviewId },
      data: {
        agentResult: JSON.parse(JSON.stringify(result)),
        // Everything the model read, cached or not, is prompt; cost is in whole cents.
        promptTokens: usage ? usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens : null,
        completionTokens: usage?.outputTokens ?? null,
        costCents: usage?.costUsd == null ? null : Math.round(usage.costUsd * 100),
      },
    });
  }
}
