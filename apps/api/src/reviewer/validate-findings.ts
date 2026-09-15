import { createHash } from 'node:crypto';
import type { LineMap } from '../diff/line-map.js';
import type { Side } from '../diff/diff.types.js';
import { Severity, Verdict } from '../generated/prisma/client.js';
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
  /** The agent's second look: null when there was none (the stub, or the check turned off). */
  verdict: Verdict | null;
  verdictReason: string | null;
  demotedFrom: Severity | null;
  /** See `anchor()`: what dedupe across pushes compares. */
  anchor: string | null;
}

export type DropReason = 'outside-diff' | 'no-failure-scenario' | 'duplicate-line';

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
 * - `duplicate-line` — another finding in the same review already points at that line. One
 *   comment per line: a model that reports one problem twice under two categories (seen on
 *   the local model, which filed the same `verify` defect as both correctness and security)
 *   would otherwise put two identical comments on the pull request. The most severe of the
 *   duplicates is the one kept.
 *
 * The severity gate (POST_MIN_SEVERITY decides what gets posted) is not applied here — every valid
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
    const at = `${path}:${finding.line}:${finding.side}`;
    const existing = accepted.findIndex((f) => `${f.path}:${f.line}:${f.side}` === at);
    if (existing >= 0) {
      // Keep the more severe of the two, and drop the other — whichever arrived first.
      if (RANK[SEVERITY[finding.severity]] <= RANK[accepted[existing].severity]) {
        dropped.push({ finding, reason: 'duplicate-line' });
        continue;
      }
      dropped.push({ finding: proposedOf(accepted[existing]), reason: 'duplicate-line' });
      accepted.splice(existing, 1);
    }
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
      verdict: finding.verification ? VERDICT[finding.verification.verdict] : null,
      verdictReason: finding.verification?.reason ?? null,
      demotedFrom: finding.verification?.demotedFrom ? SEVERITY[finding.verification.demotedFrom] : null,
      anchor: anchor(path, finding.side, target.content),
    });
  }

  return { accepted, dropped };
}

const VERDICT: Record<NonNullable<ProposedFinding['verification']>['verdict'], Verdict> = {
  confirmed: Verdict.CONFIRMED,
  unsure: Verdict.UNSURE,
  unverified: Verdict.UNVERIFIED,
};

const RANK: Record<Severity, number> = { [Severity.HIGH]: 3, [Severity.MEDIUM]: 2, [Severity.LOW]: 1 };

/** A kept finding back in the reviewer's own shape, so a drop reads the same either way. */
function proposedOf(finding: ValidFinding): ProposedFinding {
  return {
    file: finding.path,
    line: finding.line,
    side: finding.side,
    severity: finding.severity.toLowerCase() as ProposedFinding['severity'],
    category: finding.category,
    summary: finding.summary,
    whyItBreaks: finding.whyItBreaks,
    suggestedFix: finding.suggestedFix ?? undefined,
  };
}

/**
 * What makes two findings on different pushes of a PR the same one, for dedupe: the file, the
 * side, and the code on the line, whitespace collapsed.
 *
 * - No line number: a push that adds lines above an unchanged problem moves it without making
 *   it new.
 * - No category: the local model filed one defect as correctness on one run and security on
 *   the next (docs/decisions.md). `fingerprint` keeps the category, for grouping; this is the
 *   narrower question "have we already commented on this code?".
 * - The side stays: the same text deleted and added is two different situations.
 *
 * A line with no identifier at least three characters long — `}`, `});`, a blank — gives
 * null: such lines repeat all over a file, and matching on them would silence a new finding
 * because of an unrelated old one.
 */
export function anchor(path: string, side: Side, content: string): string | null {
  const code = content.trim().replace(/\s+/g, ' ');
  if (!/[A-Za-z0-9_]{3,}/.test(code)) return null;
  return createHash('sha256').update(`${path}\n${side}\n${code}`).digest('hex');
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
