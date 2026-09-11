import type { DiffFile } from '../diff/diff.types.js';

/** Why a file never reaches the reviewer. */
export type SkipReason = 'lockfile' | 'generated' | 'vendored' | 'removed' | 'binary' | 'no-changes';

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

/** A path rule: a file matches if any of its non-empty fields matches. */
export interface PathRule {
  reason: Extract<SkipReason, 'lockfile' | 'generated' | 'vendored'>;
  /** Exact file names, anywhere in the tree. */
  basenames?: string[];
  /** File-name endings, e.g. `.min.js`. */
  suffixes?: string[];
  /** Substrings of the file name, e.g. `.generated.`. */
  contains?: string[];
  /** Directory names; a file anywhere beneath one matches. */
  directories?: string[];
}

export interface FilterConfig {
  rules: PathRule[];
  /** A PR with more files than this, after filtering, is not reviewed at all. */
  maxFiles: number;
  /** Likewise for added + deleted lines across the files that survive filtering. */
  maxChangedLines: number;
}

/**
 * The defaults. Policy lives in data rather than in `if`s so that month 3's per-repo
 * `.prreviewer.yml` can override it without touching the code that applies it.
 */
export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  rules: [
    {
      reason: 'lockfile',
      basenames: [
        'package-lock.json',
        'npm-shrinkwrap.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'bun.lock',
        'bun.lockb',
        'Cargo.lock',
        'poetry.lock',
        'Pipfile.lock',
        'uv.lock',
        'go.sum',
        'composer.lock',
        'Gemfile.lock',
      ],
    },
    {
      reason: 'generated',
      suffixes: ['.min.js', '.min.css', '.map', '.pb.go'],
      contains: ['.generated.'],
      directories: ['dist', 'build', '__generated__'],
    },
    {
      reason: 'vendored',
      directories: ['vendor', 'node_modules', 'third_party'],
    },
  ],
  maxFiles: 50,
  maxChangedLines: 2000,
};

/** The fields of a changed file that the first stage needs — GitHub's file list has them. */
export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface FileListVerdict<T extends ChangedFile> {
  kept: T[];
  skipped: SkippedFile[];
  /** Set when the whole PR is too large to review; the reason says which limit and by how much. */
  tooLarge?: string;
}

/**
 * Stage one, on GitHub's file list — before the diff is fetched, because a very large diff
 * is refused by GitHub rather than truncated. Drops files by path and removed files, then
 * checks the PR-level limits against what is left.
 */
export function filterFileList<T extends ChangedFile>(
  files: T[],
  config: FilterConfig = DEFAULT_FILTER_CONFIG,
): FileListVerdict<T> {
  const kept: T[] = [];
  const skipped: SkippedFile[] = [];

  for (const file of files) {
    const reason = file.status === 'removed' ? 'removed' : matchRule(file.filename, config.rules);
    if (reason) skipped.push({ path: file.filename, reason });
    else kept.push(file);
  }

  const changedLines = kept.reduce((n, f) => n + f.additions + f.deletions, 0);
  let tooLarge: string | undefined;
  if (kept.length > config.maxFiles) {
    tooLarge = `${kept.length} files to review, over the limit of ${config.maxFiles}`;
  } else if (changedLines > config.maxChangedLines) {
    tooLarge = `${changedLines} changed lines to review, over the limit of ${config.maxChangedLines}`;
  }

  return { kept, skipped, tooLarge };
}

/**
 * Stage two, on the parsed diff — the only place that can tell a binary file from a pure
 * rename or a mode-only change, since GitHub's file list omits `patch` for all three.
 * Keeps only files named in `keep` (the survivors of stage one) that have lines to review.
 */
export function filterDiffFiles(
  files: DiffFile[],
  keep: ReadonlySet<string>,
): { kept: DiffFile[]; skipped: SkippedFile[] } {
  const kept: DiffFile[] = [];
  const skipped: SkippedFile[] = [];

  for (const file of files) {
    if (!keep.has(file.path)) continue; // dropped in stage one, already reported there
    if (file.binary) skipped.push({ path: file.path, reason: 'binary' });
    else if (file.hunks.length === 0) skipped.push({ path: file.path, reason: 'no-changes' });
    else kept.push(file);
  }

  return { kept, skipped };
}

function matchRule(path: string, rules: PathRule[]): PathRule['reason'] | undefined {
  const segments = path.split('/');
  const name = segments.at(-1)!;
  const directories = segments.slice(0, -1);

  for (const rule of rules) {
    if (
      rule.basenames?.includes(name) ||
      rule.suffixes?.some((s) => name.endsWith(s)) ||
      rule.contains?.some((c) => name.includes(c)) ||
      rule.directories?.some((d) => directories.includes(d))
    ) {
      return rule.reason;
    }
  }
  return undefined;
}
