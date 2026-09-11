import type { DiffFile, Side } from '../diff/diff.types.js';
import type { LineMap } from '../diff/line-map.js';

/**
 * The seam the review agent plugs into. Weeks 3–4 put a deterministic stub behind it;
 * weeks 5–6 replace the stub with the LangGraph agent, and nothing on either side of this
 * interface has to change.
 */
export interface Reviewer {
  review(context: ReviewContext): Promise<ProposedFinding[]>;
}

/** Nest injection token for the active Reviewer implementation. */
export const REVIEWER = Symbol('REVIEWER');

/** Everything a reviewer may look at. Only files that survived filtering are included. */
export interface ReviewContext {
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
}
