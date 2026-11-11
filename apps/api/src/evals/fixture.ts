import type { DiffFile } from '../diff/diff.types.js';

/**
 * One pull request of the evaluation, with its known answer.
 *
 * A **bug** fixture is a real bug fix, reversed: the reviewed change goes from the fixed code
 * (base) back to the code before the fix (head), so the head commit really has the bug and the
 * answer is where the fix changed things. A **clean** fixture is a real merged change believed to
 * need no fix, reviewed as it was.
 */
export interface Fixture {
  id: string;
  kind: 'bug' | 'clean';
  /** Tune on `tune`; `heldout` only decides (docs/journal/week9-10.md, trap 3). */
  split: 'tune' | 'heldout';
  source: {
    repo: string;
    /** The fix (bug) or the change (clean) the fixture was made from. */
    commit: string;
    url: string;
    /** The commit's first line — for the people judging, never shown to the reviewer. */
    message: string;
  };
  /** The two commits the review compares. For a bug fixture, base is the fix and head its parent. */
  reviewed: { base: string; head: string };
  /** What the reviewer is sent: the agent's request, without an installation token. */
  request: FixtureRequest;
  bugs: Bug[];
  /** Why this fixture, and how its answer was decided. */
  notes: string;
}

export interface FixtureRequest {
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  files: DiffFile[];
}

/**
 * Where a bug is and what it is. `head` is the range of head-side lines the fix changed (the
 * buggy lines as the reviewer sees them); `base` the same place on the base side, for a fix
 * that only added code, whose reversal is a deletion.
 */
export interface Bug extends Region {
  description: string;
  /**
   * The same defect in other places — a missing check repeated in two functions. Finding it at
   * any of them finds the bug, once; recall counts bugs, not places.
   */
  alsoAt?: Region[];
}

export interface Region {
  file: string;
  head: [number, number];
  base: [number, number];
}

const SHA = /^[0-9a-f]{40}$/;

/** Every reason a fixture can't be used; empty when it is sound. */
export function fixtureProblems(f: Fixture, fileName?: string): string[] {
  const problems: string[] = [];
  const say = (p: string) => problems.push(`${f.id ?? fileName}: ${p}`);

  if (fileName && `${f.id}.json` !== fileName)
    say(`id does not match the file name ${fileName}`);
  if (!['bug', 'clean'].includes(f.kind)) say(`kind is ${f.kind}`);
  if (!['tune', 'heldout'].includes(f.split)) say(`split is ${f.split}`);
  if (!f.source?.repo || !SHA.test(f.source?.commit ?? '') || !f.source?.url)
    say('provenance is incomplete');
  if (!f.notes?.trim()) say('no notes on how the answer was decided');
  if (!SHA.test(f.reviewed?.base ?? '') || !SHA.test(f.reviewed?.head ?? ''))
    say('reviewed commits are not full SHAs');

  const r = f.request;
  if (!r || r.baseSha !== f.reviewed?.base || r.headSha !== f.reviewed?.head)
    say('the request does not review the recorded commits');
  if (!r?.files?.length) say('the request has no files');
  if (r?.prNumber !== undefined && !(r.prNumber > 0))
    say('prNumber must be positive');

  if (f.kind === 'clean' && f.bugs.length) say('a clean fixture has bugs');
  if (f.kind === 'bug' && !f.bugs.length) say('a bug fixture has no bugs');
  for (const bug of f.bugs) {
    if (!bug.description?.trim() || bug.description.includes('TODO'))
      say(`bug in ${bug.file} is not described`);
    for (const region of [bug, ...(bug.alsoAt ?? [])]) {
      const file = r?.files?.find((d) => d.path === region.file);
      if (!file) {
        say(`bug in ${region.file}: that file is not in the diff`);
        continue;
      }
      const touches = file.hunks.some(
        (h) =>
          overlaps(region.head, [
            h.newStart,
            h.newStart + Math.max(h.newLines, 1) - 1,
          ]) ||
          overlaps(region.base, [
            h.oldStart,
            h.oldStart + Math.max(h.oldLines, 1) - 1,
          ]),
      );
      if (!touches)
        say(
          `bug in ${region.file} at ${region.head.join('-')} is outside every hunk`,
        );
    }
  }
  return problems;
}

const overlaps = (a: [number, number], b: [number, number]) =>
  a[0] <= b[1] && b[0] <= a[1];

/**
 * A first draft of the answer key: one bug per hunk, at the lines the fix changed. A person
 * then merges, trims and describes them — the draft never ships with "TODO" (validation).
 */
export function draftBugs(files: DiffFile[]): Bug[] {
  return files.flatMap((file) =>
    file.hunks.map((h) => {
      const changedNew = h.lines
        .filter((l) => l.kind === 'add')
        .map((l) => l.newLine!);
      const changedOld = h.lines
        .filter((l) => l.kind === 'del')
        .map((l) => l.oldLine!);
      // A pure deletion has no head-side lines: point at where the code was taken out.
      const anchor = h.lines.find((l) => l.kind === 'del')
        ? (h.lines
            .slice(
              0,
              h.lines.findIndex((l) => l.kind === 'del'),
            )
            .reverse()
            .find((l) => l.newLine)?.newLine ?? h.newStart)
        : h.newStart;
      return {
        file: file.path,
        head: changedNew.length
          ? [Math.min(...changedNew), Math.max(...changedNew)]
          : [anchor, anchor],
        base: changedOld.length
          ? [Math.min(...changedOld), Math.max(...changedOld)]
          : [h.oldStart, h.oldStart],
        description: 'TODO: what goes wrong, for which input',
      } satisfies Bug;
    }),
  );
}

/** Source code, not tests, docs or changelogs — those would hand the reviewer the answer. */
export function isReviewableSource(path: string): boolean {
  if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/.test(path)) return false;
  if (path.endsWith('.d.ts')) return false;
  if (
    /(^|\/)(tests?|__tests__|spec|specs|fixtures?|examples?|benchmarks?|docs?)\//.test(
      path,
    )
  )
    return false;
  return (
    !/(\.|_)(test|spec)\.[a-z]+$/.test(path) &&
    !/(^|\/)test_[^/]+\.py$/.test(path)
  );
}
