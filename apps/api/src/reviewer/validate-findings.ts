import { createHash } from 'node:crypto';
import type { LineMap } from '../diff/line-map.js';
import type { Side } from '../diff/diff.types.js';
import { Severity } from '../generated/prisma/client.js';
import type { ProposedFinding } from './reviewer.js';

/** A finding that passed validation, in the shape it is stored. */
export interface ValidFinding {
  path: string;
  line: number;
  side: Side;
  severity: Severity;
  category: string;
  summary: string;
  whyItBreaks: string;
  suggestedFix: string | null;
  fingerprint: string;
}

export type DropReason = 'outside-diff' | 'no-failure-scenario';

export interface DroppedFinding {
  finding: ProposedFinding;
  reason: DropReason;
}

const SEVERITY: Record<ProposedFinding['severity'], Severity> = {
  high: Severity.HIGH,
  medium: Severity.MEDIUM,
  low: Severity.LOW,
};

/**
 * The gate between a reviewer and the database. A finding is dropped if:
 *
 * - `outside-diff` — its path, line and side are not a line GitHub would accept a comment
 *   on. That is a reviewer bug, and posting it in weeks 5–6 would fail the whole review.
 * - `no-failure-scenario` — it has no concrete "why it breaks". The roadmap's rule: a
 *   finding without a failure scenario is an opinion, and opinions are noise.
 *
 * The severity gate (only high and medium get posted) is not applied here — every valid
 * finding is stored, and posting decides what to show.
 */
export function validateFindings(
  proposed: ProposedFinding[],
  lines: LineMap,
): { accepted: ValidFinding[]; dropped: DroppedFinding[] } {
  const accepted: ValidFinding[] = [];
  const dropped: DroppedFinding[] = [];

  for (const finding of proposed) {
    const target = lines.lineAt(finding.file, finding.line, finding.side);
    if (!target) {
      dropped.push({ finding, reason: 'outside-diff' });
      continue;
    }
    if (!finding.whyItBreaks?.trim()) {
      dropped.push({ finding, reason: 'no-failure-scenario' });
      continue;
    }

    const path = lines.resolvePath(finding.file);
    accepted.push({
      path,
      line: finding.line,
      side: finding.side,
      severity: SEVERITY[finding.severity],
      category: finding.category,
      summary: finding.summary.trim(),
      whyItBreaks: finding.whyItBreaks.trim(),
      suggestedFix: finding.suggestedFix?.trim() || null,
      fingerprint: fingerprint(path, target.content, finding.category),
    });
  }

  return { accepted, dropped };
}

/**
 * Identifies "the same problem" across pushes, for weeks 7–8's dedupe: the file, the code
 * on the line, and the kind of problem. Deliberately *not* the line number — a push that
 * adds lines above an unchanged problem moves it down without making it a new finding.
 * Whitespace is collapsed so reindenting the line doesn't either.
 */
export function fingerprint(path: string, content: string, category: string): string {
  const code = content.trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(`${path}\n${code}\n${category}`).digest('hex');
}
