import type { DiffFile, DiffLine, Side } from './diff.types.js';

/**
 * Answers the one question comment anchoring needs: can a review comment go on this path,
 * line and side? GitHub accepts a comment on any line inside a hunk — context lines
 * included — and rejects anything outside every hunk with a 422.
 *
 * - `RIGHT` is the new file: added and context lines, by their new line number.
 * - `LEFT` is the old file: deleted and context lines, by their old line number.
 *
 * A renamed file is addressed by its new path, as the Files changed tab shows it — and,
 * because GitHub accepts it too (checked with prove:line-map), by its old path, on either
 * side. `resolvePath` maps either name to the one canonical path, so a finding is stored
 * under a single name however it was addressed. Copies are not aliased: a copy's source
 * is a different file that still exists. A removed file only has a LEFT side, under its
 * old path.
 */
export class LineMap {
  private readonly lines = new Map<string, Map<number, DiffLine>>();
  private readonly aliases = new Map<string, string>();

  constructor(files: DiffFile[]) {
    for (const file of files) {
      if (file.status === 'renamed' && file.oldPath !== file.path)
        this.aliases.set(file.oldPath, file.path);

      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.newLine !== undefined)
            this.slot(file.path, 'RIGHT').set(line.newLine, line);
          if (line.oldLine !== undefined)
            this.slot(file.path, 'LEFT').set(line.oldLine, line);
        }
      }
    }
  }

  canComment(path: string, line: number, side: Side): boolean {
    return this.lineAt(path, line, side) !== undefined;
  }

  /** The diff line a comment would sit on, or undefined if it can't sit there. */
  lineAt(path: string, line: number, side: Side): DiffLine | undefined {
    return this.lines.get(key(this.canonical(path), side))?.get(line);
  }

  /** The canonical path for a file in the diff — the new name for a rename. */
  resolvePath(path: string): string {
    return this.canonical(path);
  }

  private canonical(path: string): string {
    return this.aliases.get(path) ?? path;
  }

  private slot(path: string, side: Side): Map<number, DiffLine> {
    const k = key(path, side);
    let slot = this.lines.get(k);
    if (!slot) this.lines.set(k, (slot = new Map()));
    return slot;
  }
}

function key(path: string, side: Side): string {
  return `${side} ${path}`;
}
