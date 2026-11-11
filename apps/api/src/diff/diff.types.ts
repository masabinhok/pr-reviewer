/** Which version of the file a line belongs to, in GitHub's review-comment vocabulary. */
export type Side = 'LEFT' | 'RIGHT';

export type DiffFileStatus =
  'added' | 'removed' | 'modified' | 'renamed' | 'copied';

export interface DiffLine {
  kind: 'add' | 'del' | 'context';
  /** Line number in the old file — present for `del` and `context`. */
  oldLine?: number;
  /** Line number in the new file — present for `add` and `context`. */
  newLine?: number;
  /** The line's text without its +/-/space prefix and without the newline. */
  content: string;
  /** Followed by `\ No newline at end of file`. */
  noNewlineAtEnd?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after the second `@@` — usually the enclosing function. */
  section: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** The path a review comment uses: the new path, or the old one for a removed file. */
  path: string;
  /** The path before the change; differs from `path` only for renames and copies. */
  oldPath: string;
  status: DiffFileStatus;
  binary: boolean;
  /** Set when the file's mode changed (e.g. 100644 → 100755). */
  modeChange?: { from: string; to: string };
  hunks: Hunk[];
}
