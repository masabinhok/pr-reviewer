import type { SkippedFile } from '../filters/review-filter.js';
import type { ValidFinding } from '../reviewer/validate-findings.js';
import type { ReviewerRun } from '../reviewer/reviewer.js';

/** The part of a finding the Check Run summary shows. */
export type FindingSummary = Pick<ValidFinding, 'path' | 'line' | 'severity' | 'summary'>;

/**
 * What the pipeline hands back to the worker when it finishes without throwing. A thrown
 * error is the third outcome, handled separately because only the final attempt's error
 * settles the review.
 */
export type ReviewOutcome =
  | {
      kind: 'completed';
      reviewed: string[];
      skipped: SkippedFile[];
      findings: ValidFinding[];
      /** How an LLM reviewer's run went; absent for the stub. */
      reviewer?: ReviewerRun;
    }
  | { kind: 'skipped'; reason: string; skipped: SkippedFile[] };
