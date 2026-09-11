import type { SkippedFile } from '../filters/review-filter.js';
import type { Severity } from '../generated/prisma/client.js';

/** A finding as the Check Run summary shows it. */
export interface FindingSummary {
  path: string;
  line: number;
  severity: Severity;
  summary: string;
}

/**
 * What the pipeline hands back to the worker when it finishes without throwing. A thrown
 * error is the third outcome, handled separately because only the final attempt's error
 * settles the review.
 */
export type ReviewOutcome =
  | { kind: 'completed'; reviewed: string[]; skipped: SkippedFile[]; findings: FindingSummary[] }
  | { kind: 'skipped'; reason: string; skipped: SkippedFile[] };
