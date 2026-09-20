import type { Bug, Fixture, Region } from './fixture.js';

/** A finding the reviewer kept, as the evaluation records it. */
export interface EvalFinding {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  category: string;
  summary: string;
  whyItBreaks: string;
  verdict: string | null;
  demotedFrom: string | null;
  /** Met the posting bar: a user would have seen it as a comment. */
  posted: boolean;
}

/** One review of one fixture in one run — a line of `results.jsonl`. */
export interface FixtureResult {
  fixture: string;
  run: number;
  kind: Fixture['kind'];
  split: Fixture['split'];
  seconds: number;
  /** Why the review failed; its findings are then empty and its bugs count as missed. */
  error: string | null;
  model: string | null;
  outcome: string | null;
  turns: number;
  toolCalls: number;
  verifyCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** Kept after the second look and the API's validation — what would be stored. */
  findings: EvalFinding[];
  /** Dropped by the second look. */
  refuted: number;
  /**
   * What those were, so a run can answer whether the second look is throwing away real bugs.
   * Absent from runs recorded before this was kept.
   */
  refutedFindings?: RefutedFinding[];
  /** Dropped by the API's validation (outside the diff, no failure scenario, same line). */
  invalid: number;
}

/** A finding the agent's second look refuted, with the checker's reason. */
export interface RefutedFinding {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  severity: string;
  summary: string;
  reason: string;
}

/**
 * Someone's reading of a location match (week9-10.md, trap 6): does the comment describe the
 * bug, or a different problem that happens to be nearby? Keyed by `matchKey`.
 */
export type Judgments = Record<string, 'right' | 'wrong'>;

/** A finding is at a bug when it is in the same file within this many lines of it (trap 6). */
export const MATCH_DISTANCE = 3;

export function matchKey(result: Pick<FixtureResult, 'fixture' | 'run'>, f: Pick<EvalFinding, 'path' | 'line' | 'side'>): string {
  return `${result.fixture}#${result.run}#${f.path}:${f.line}:${f.side}`;
}

function near(line: number, [from, to]: [number, number]): boolean {
  return line >= from - MATCH_DISTANCE && line <= to + MATCH_DISTANCE;
}

/**
 * Whether a finding is at a bug: same file, and within MATCH_DISTANCE of the bug's lines on the
 * side it comments on — head lines for a comment on the new code, base lines for one on removed
 * code. Any of the bug's places (`alsoAt`) will do.
 */
export function isAt(finding: Pick<EvalFinding, 'path' | 'line' | 'side'>, bug: Bug): boolean {
  const places: Region[] = [bug, ...(bug.alsoAt ?? [])];
  return places.some(
    (r) => r.file === finding.path && near(finding.line, finding.side === 'RIGHT' ? r.head : r.base),
  );
}

export type Level = 'kept' | 'posted';

/** How one review did, at one level. */
export interface FixtureScore {
  bugs: number;
  /** Bugs with at least one finding that matches — at their place, and not judged wrong. */
  found: number;
  findings: number;
  /** Findings that match a bug. On a clean fixture there are none: every finding is a false positive. */
  matched: number;
  /** Location matches nobody has read yet (trap 6): counted as matches until someone does. */
  unread: number;
}

export function scoreResult(result: FixtureResult, fixture: Fixture, level: Level, judgments: Judgments = {}): FixtureScore {
  const findings = result.findings.filter((f) => level === 'kept' || f.posted);
  const counts = (f: EvalFinding, bug: Bug) => isAt(f, bug) && judgments[matchKey(result, f)] !== 'wrong';

  const matching = findings.filter((f) => fixture.bugs.some((b) => counts(f, b)));
  return {
    bugs: fixture.bugs.length,
    found: fixture.bugs.filter((b) => findings.some((f) => counts(f, b))).length,
    findings: findings.length,
    matched: matching.length,
    unread: matching.filter((f) => judgments[matchKey(result, f)] === undefined).length,
  };
}

/** One run's numbers over a set of fixtures, at one level. Null where there is nothing to divide by. */
export interface RunScore {
  run: number;
  /** Of the known bugs, the share found. */
  recall: number | null;
  /** Of the findings, the share that are at a known bug. */
  precision: number | null;
  /**
   * Findings on clean fixtures, per clean fixture reviewed. A failed review of a clean fixture is
   * left out: it posted nothing, but only because it never ran, and counting it would flatter this.
   */
  fpPerClean: number | null;
  bugs: number;
  found: number;
  findings: number;
  cleanFixtures: number;
  cleanFindings: number;
  errors: number;
  unread: number;
  meanSeconds: number | null;
}

export function scoreRun(
  run: number,
  results: FixtureResult[],
  fixtures: Map<string, Fixture>,
  level: Level,
  judgments: Judgments = {},
): RunScore {
  const mine = results.filter((r) => r.run === run && fixtures.has(r.fixture));
  let bugs = 0, found = 0, findings = 0, matched = 0, cleanFixtures = 0, cleanFindings = 0, unread = 0;
  for (const result of mine) {
    const fixture = fixtures.get(result.fixture)!;
    const s = scoreResult(result, fixture, level, judgments);
    bugs += s.bugs;
    found += s.found;
    findings += s.findings;
    matched += s.matched;
    unread += s.unread;
    if (fixture.kind === 'clean' && result.error === null) {
      cleanFixtures += 1;
      cleanFindings += s.findings;
    }
  }
  const timed = mine.filter((r) => r.error === null);
  return {
    run,
    recall: bugs ? found / bugs : null,
    precision: findings ? matched / findings : null,
    fpPerClean: cleanFixtures ? cleanFindings / cleanFixtures : null,
    bugs,
    found,
    findings,
    cleanFixtures,
    cleanFindings,
    errors: mine.length - timed.length,
    unread,
    meanSeconds: timed.length ? timed.reduce((t, r) => t + r.seconds, 0) / timed.length : null,
  };
}

/** A number over several runs: never one run alone (trap 2). */
export interface Spread {
  mean: number;
  min: number;
  max: number;
  runs: number;
}

export function spread(values: (number | null)[]): Spread | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return {
    mean: present.reduce((a, b) => a + b, 0) / present.length,
    min: Math.min(...present),
    max: Math.max(...present),
    runs: present.length,
  };
}
