import type { DiffFile, Side } from '../diff/diff.types.js';
import type { LineMap } from '../diff/line-map.js';

/**
 * The seam the review agent plugs into. Weeks 3–4 put a deterministic stub behind it;
 * weeks 5–6 replace the stub with the LangGraph agent, and nothing on either side of this
 * interface has to change.
 */
export interface Reviewer {
  review(context: ReviewContext): Promise<ReviewerResult>;
}

/** What a reviewer hands back: its findings, and — for an LLM reviewer — how the run went. */
export interface ReviewerResult {
  findings: ProposedFinding[];
  run?: ReviewerRun;
  /** Findings the agent's second look refuted — never stored as findings, shown in the Check Run. */
  dropped?: DroppedFinding[];
}

export interface DroppedFinding {
  finding: ProposedFinding;
  /** The checker's reason, quoting the code that refutes the finding. */
  reason: string;
}

/** An LLM reviewer's run: which model answered, how it finished, and what it cost. */
export interface ReviewerRun {
  model: string;
  /** submitted, refused, budget, no-submission, or truncated — see the agent. */
  outcome: string;
  turns: number;
  toolCalls: number;
  /** Verdicts the second look asked for; absent on answers stored before it existed. */
  verifyCalls?: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUsd: number | null;
  };
}

/** Nest injection token for the active Reviewer implementation. */
export const REVIEWER = Symbol('REVIEWER');

/** Everything a reviewer may look at. Only files that survived filtering are included. */
export interface ReviewContext {
  /**
   * GitHub's installation ID — an LLM reviewer reads the repository with its token. Null only
   * in the evaluation, for a public repository the App isn't installed on: read without one.
   */
  installationId: bigint | null;
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  files: DiffFile[];
  lines: LineMap;
}

/**
 * A finding as a reviewer proposes it — the roadmap's agent output schema. Nothing is
 * trusted yet: `validateFindings` checks it against the diff before it is stored.
 */
export interface ProposedFinding {
  file: string;
  line: number;
  side: Side;
  severity: 'high' | 'medium' | 'low';
  category: string;
  /** One sentence stating the defect. */
  summary: string;
  /** Concrete inputs or state, then the wrong output or crash. Required to be stored. */
  whyItBreaks: string;
  suggestedFix?: string;
  /** How the agent's second look went; absent from the stub and when the check is off. */
  verification?: FindingVerification;
}

export interface FindingVerification {
  /** Refuted findings never get here: the agent drops them. */
  verdict: 'confirmed' | 'unsure' | 'unverified';
  reason: string;
  /** The severity before an unconfirmed finding was demoted to low. */
  demotedFrom: 'high' | 'medium' | 'low' | null;
}
