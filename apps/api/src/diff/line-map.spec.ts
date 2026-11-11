import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDiff } from './parse-diff.js';
import { LineMap } from './line-map.js';
import type { Side } from './diff.types.js';

const diff = readFileSync(
  fileURLToPath(
    new URL('../../test/fixtures/diffs/diff-shapes.diff', import.meta.url),
  ),
  'utf8',
);
const map = new LineMap(parseDiff(diff));

describe('LineMap on a real PR diff', () => {
  // The four kinds of line GitHub accepts a comment on, straight from the Files changed tab.
  it.each<[string, string, number, Side]>([
    ['an added line', 'src/auth.ts', 26, 'RIGHT'],
    ['a deleted line', 'src/auth.ts', 8, 'LEFT'],
    ['a context line, new side', 'src/auth.ts', 23, 'RIGHT'],
    ['the same context line, old side', 'src/auth.ts', 22, 'LEFT'],
    ['a line of a new file', 'src/new-feature.ts', 2, 'RIGHT'],
    ['a deleted file, under its old path', 'legacy/remove-me.ts', 1, 'LEFT'],
  ])('allows %s', (_kind, path, line, side) => {
    expect(map.canComment(path, line, side)).toBe(true);
  });

  it.each<[string, string, number, Side]>([
    ['a line above the first hunk', 'src/auth.ts', 1, 'RIGHT'],
    ['a line between two hunks', 'src/auth.ts', 21, 'RIGHT'],
    ['a line between two hunks, old side', 'src/auth.ts', 20, 'LEFT'],
    ['the new side of a deleted file', 'legacy/remove-me.ts', 1, 'RIGHT'],
    ['the old side of a new file', 'src/new-feature.ts', 1, 'LEFT'],
    ['a binary file', 'assets/logo.png', 1, 'RIGHT'],
    ['a rename without changes', 'docs/new name.md', 1, 'RIGHT'],
    ['a mode-only change', 'src/config.ts', 1, 'RIGHT'],
    ['a file not in the diff', 'src/missing.ts', 1, 'RIGHT'],
  ])('rejects %s', (_kind, path, line, side) => {
    expect(map.canComment(path, line, side)).toBe(false);
  });

  it('addresses both sides of a renamed file by its new path', () => {
    expect(map.canComment('src/helpers.ts', 7, 'LEFT')).toBe(true);
    expect(map.canComment('src/helpers.ts', 10, 'RIGHT')).toBe(true);
  });

  // GitHub accepted comments on src/utils.ts:7 LEFT and :10 RIGHT on the testbed PR.
  it('accepts a renamed file’s old path, as GitHub does, and resolves it to the new one', () => {
    expect(map.canComment('src/utils.ts', 7, 'LEFT')).toBe(true);
    expect(map.canComment('src/utils.ts', 10, 'RIGHT')).toBe(true);
    expect(map.resolvePath('src/utils.ts')).toBe('src/helpers.ts');
    expect(map.resolvePath('src/auth.ts')).toBe('src/auth.ts');
  });

  it('does not alias a copy’s source, which is a different file', () => {
    const copied = new LineMap(
      parseDiff(
        [
          'diff --git a/a.ts b/b.ts',
          'similarity index 90%',
          'copy from a.ts',
          'copy to b.ts',
          '--- a/a.ts',
          '+++ b/b.ts',
          '@@ -1 +1 @@',
          '-x',
          '+y',
          '',
        ].join('\n'),
      ),
    );
    expect(copied.canComment('b.ts', 1, 'RIGHT')).toBe(true);
    expect(copied.canComment('a.ts', 1, 'LEFT')).toBe(false);
  });

  it('returns the line a comment would sit on', () => {
    expect(map.lineAt('src/auth.ts', 16, 'RIGHT')).toEqual({
      kind: 'add',
      newLine: 16,
      content: '  return session.expiresAt - CLOCK_SKEW_MS < now;',
    });
    expect(map.lineAt('src/auth.ts', 21, 'RIGHT')).toBeUndefined();
  });
});
