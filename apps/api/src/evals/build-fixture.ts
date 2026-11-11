import { basename } from 'node:path';
import { parseDiff } from '../diff/parse-diff.js';
import { filterDiffFiles, filterFileList } from '../filters/review-filter.js';
import { draftBugs, isReviewableSource, type Fixture } from './fixture.js';

export interface BuildInput {
  id: string;
  kind: 'bug' | 'clean';
  split: 'tune' | 'heldout';
  repo: string;
  /** The commit the fixture is made from — the fix (bug) or the change (clean). */
  commit: string;
  parent: string;
  message: string;
  /** `git diff base head`, where base/head are as `commitsToReview` says. */
  diff: string;
}

/** Which two commits a fixture reviews: a bug fixture reviews the fix backwards. */
export function commitsToReview(
  kind: 'bug' | 'clean',
  commit: string,
  parent: string,
): { base: string; head: string } {
  return kind === 'bug'
    ? { base: commit, head: parent }
    : { base: parent, head: commit };
}

/**
 * The fixture for a commit, from its diff: source files only (tests, docs and changelogs would
 * hand the reviewer the answer), through the API's own parser and filters, with a neutral title
 * — a fix's own title would name the bug — and a drafted key for a person to finish.
 */
export function buildFixture(input: BuildInput): Fixture {
  const { base, head } = commitsToReview(
    input.kind,
    input.commit,
    input.parent,
  );
  const parsed = parseDiff(input.diff);
  const source = parsed.filter((f) => isReviewableSource(f.path));
  const changed = source.map((f) => ({
    filename: f.path,
    status: f.status,
    additions: f.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'add')
      .length,
    deletions: f.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'del')
      .length,
  }));
  const listed = filterFileList(changed);
  if (listed.tooLarge)
    throw new Error(`too large to review: ${listed.tooLarge}`);
  const { kept } = filterDiffFiles(
    source,
    new Set(listed.kept.map((f) => f.filename)),
  );
  if (!kept.length)
    throw new Error(
      'no reviewable source files left after dropping tests and docs',
    );

  const names = kept.map((f) => basename(f.path));
  return {
    id: input.id,
    kind: input.kind,
    split: input.split,
    source: {
      repo: input.repo,
      commit: input.commit,
      url: `https://github.com/${input.repo}/commit/${input.commit}`,
      message: input.message,
    },
    reviewed: { base, head },
    request: {
      repo: input.repo,
      prNumber: 1,
      title: `Update ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`,
      body: '',
      baseSha: base,
      headSha: head,
      files: kept,
    },
    bugs: input.kind === 'bug' ? draftBugs(kept) : [],
    notes: '',
  };
}
