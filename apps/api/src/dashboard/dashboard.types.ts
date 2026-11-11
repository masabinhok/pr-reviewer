import type { FeedbackRate } from '../feedback/feedback-rate.js';

/**
 * What the dashboard API answers. IDs from GitHub are strings on the wire (see jsonSafe) and
 * dates are ISO strings; the types below describe the objects *before* that step, with the
 * fields the dashboard reads named for it rather than for the database.
 */

export interface Overview {
  reviews: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    inProgress: number;
  };
  findings: {
    total: number;
    bySeverity: { high: number; medium: number; low: number };
    posted: number;
    /** Not posted because an earlier review already commented on that code. */
    repeats: number;
    resolved: { byApp: number; byPerson: number };
    verdicts: { confirmed: number; unsure: number; unverified: number };
    /** Refuted by the agent's second look — never stored as findings, counted from the answers. */
    droppedOnSecondLook: number;
  };
  feedback: FeedbackRate;
  agent: {
    /** Reviews an LLM reviewer answered (the stub's have no run). */
    reviews: number;
    averageSeconds: number | null;
    averageTurns: number | null;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
  /** The last 30 days, oldest first, one entry per day (days with nothing included). */
  perDay: { day: string; reviews: number; findings: number; posted: number }[];
}

export interface InstallationSummary {
  id: string;
  githubId: bigint;
  account: string;
  accountType: string;
  suspendedAt: Date | null;
  deletedAt: Date | null;
  repos: {
    id: string;
    fullName: string;
    private: boolean;
    deletedAt: Date | null;
    reviews: number;
    lastReviewAt: Date | null;
  }[];
}

export interface ReviewSummary {
  id: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  seconds: number | null;
  error: string | null;
  skipReason: string | null;
  /** The LLM run, when there was one. */
  model: string | null;
  outcome: string | null;
  turns: number | null;
  toolCalls: number | null;
  verifyCalls: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  findings: number;
  posted: number;
  droppedOnSecondLook: number;
}

export interface ReviewPage {
  items: ReviewSummary[];
  /** Pass back as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
}

export interface FindingDetail {
  id: string;
  path: string;
  line: number;
  side: string;
  severity: string;
  category: string;
  summary: string;
  whyItBreaks: string;
  suggestedFix: string | null;
  verdict: string | null;
  verdictReason: string | null;
  demotedFrom: string | null;
  status: string;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  posted: boolean;
  commentUrl: string | null;
  repeatOf: string | null;
  feedback: { up: number; down: number };
}

/** A review in full: the summary's finding count is replaced by the findings themselves. */
export type ReviewDetail = Omit<ReviewSummary, 'findings'> & {
  baseSha: string;
  checkRunUrl: string | null;
  findings: FindingDetail[];
  /** What the agent's second look refuted, with the checker's reasons. */
  dropped: {
    path: string;
    line: number;
    severity: string;
    summary: string;
    reason: string;
  }[];
};
