import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DiffParseError, parseDiff } from './parse-diff.js';
import type { DiffFile } from './diff.types.js';

/** Real diffs: one GitHub produced for a testbed PR, one git produced locally. */
function diffFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../test/fixtures/diffs/${name}.diff`, import.meta.url)), 'utf8');
}

function file(files: DiffFile[], path: string): DiffFile {
  const found = files.find((f) => f.path === path);
  if (!found) throw new Error(`no file ${path} in [${files.map((f) => f.path).join(', ')}]`);
  return found;
}

describe('parseDiff', () => {
  describe('a real GitHub diff (testbed PR #3, every shape at once)', () => {
    const files = parseDiff(diffFixture('diff-shapes'));

    it('finds all eight files with the right status', () => {
      expect(files.map((f) => [f.path, f.status])).toEqual([
        ['assets/logo.png', 'modified'],
        ['docs/new name.md', 'renamed'],
        ['legacy/remove-me.ts', 'removed'],
        ['package-lock.json', 'modified'],
        ['src/auth.ts', 'modified'],
        ['src/config.ts', 'modified'],
        ['src/helpers.ts', 'renamed'],
        ['src/new-feature.ts', 'added'],
      ]);
    });

    it('marks a binary file and gives it no hunks', () => {
      expect(file(files, 'assets/logo.png')).toMatchObject({ binary: true, hunks: [] });
    });

    // Spaces in both names, no ---/+++ lines: only `rename from` / `rename to` can say.
    it('reads a pure rename with spaces in the name from its rename lines', () => {
      expect(file(files, 'docs/new name.md')).toMatchObject({ oldPath: 'docs/old name.md', hunks: [] });
    });

    it('keeps the old path and the change for a rename with edits', () => {
      const helpers = file(files, 'src/helpers.ts');
      expect(helpers.oldPath).toBe('src/utils.ts');
      expect(helpers.hunks[0].lines.find((l) => l.kind === 'add')).toMatchObject({
        newLine: 10,
        content: '  // TODO: keep first-seen order explicitly',
      });
    });

    it('records a mode-only change with no hunks', () => {
      expect(file(files, 'src/config.ts')).toMatchObject({
        modeChange: { from: '100644', to: '100755' },
        hunks: [],
      });
    });

    it('numbers a removed file’s lines on the old side only', () => {
      const [hunk] = file(files, 'legacy/remove-me.ts').hunks;
      expect(hunk).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 });
      expect(hunk.lines).toEqual([{ kind: 'del', oldLine: 1, content: 'export const legacy = true;' }]);
    });

    it('flags the last line of a new file without a final newline', () => {
      const [hunk] = file(files, 'src/new-feature.ts').hunks;
      expect(hunk).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 4 });
      expect(hunk.lines.at(-1)).toEqual({ kind: 'add', newLine: 4, content: '}', noNewlineAtEnd: true });
      expect(hunk.lines.filter((l) => l.noNewlineAtEnd)).toHaveLength(1);
    });

    // Every number below was read off the PR's Files changed tab.
    it('numbers lines across three hunks the way GitHub shows them', () => {
      const auth = file(files, 'src/auth.ts');
      expect(auth.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
        [5, 14, 5, 15],
        [22, 6, 23, 8],
        [31, 6, 34, 3],
      ]);
      expect(auth.hunks[0].section).toBe('export interface Session {');

      const all = auth.hunks.flatMap((h) => h.lines);
      const find = (content: string) => all.filter((l) => l.content === content);

      expect(find('const SESSION_TTL_MS = 60 * 60 * 1000;')).toEqual([
        { kind: 'del', oldLine: 8, content: 'const SESSION_TTL_MS = 60 * 60 * 1000;' },
      ]);
      expect(find('const CLOCK_SKEW_MS = 5_000;')).toEqual([
        { kind: 'add', newLine: 9, content: 'const CLOCK_SKEW_MS = 5_000;' },
      ]);
      expect(find("  console.log('verifying', value);")[0]).toMatchObject({ kind: 'add', newLine: 26 });
      expect(find('export function verify(value: string, signature: string, secret: string): boolean {')[0]).toEqual({
        kind: 'context',
        oldLine: 22,
        newLine: 23,
        content: 'export function verify(value: string, signature: string, secret: string): boolean {',
      });
      expect(find('export function describe(session: Session): string {')[0]).toMatchObject({ kind: 'del', oldLine: 34 });
    });
  });

  describe('real git output for the awkward cases', () => {
    const files = parseDiff(diffFixture('git-edge-cases'));

    it('decodes a quoted, octal-escaped non-ASCII path', () => {
      expect(file(files, 'café.md').hunks[0].lines.map((l) => l.content)).toEqual(['café', 'café au lait']);
    });

    // git appends a tab to ---/+++ when the path has a space.
    it('reads a modified path with a space, dropping git’s trailing tab', () => {
      expect(file(files, 'spaced name.txt')).toMatchObject({ status: 'modified', oldPath: 'spaced name.txt' });
    });

    it('reads a deleted path with a space', () => {
      const deleted = file(files, 'to delete.txt');
      expect(deleted.status).toBe('removed');
      expect(deleted.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 });
    });

    it('treats omitted hunk counts as 1', () => {
      expect(file(files, 'single.txt').hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    });

    it('keeps a carriage return as part of the line', () => {
      expect(file(files, 'crlf.txt').hunks[0].lines[0]).toEqual({ kind: 'context', oldLine: 1, newLine: 1, content: 'a\r' });
    });

    it('records a new empty file with no hunks', () => {
      expect(file(files, 'empty.txt')).toMatchObject({ status: 'added', hunks: [] });
    });

    it('marks the old side’s missing final newline, not the new side’s', () => {
      const lines = file(files, 'nonl.txt').hunks[0].lines;
      expect(lines).toEqual([
        { kind: 'del', oldLine: 1, content: 'x', noNewlineAtEnd: true },
        { kind: 'add', newLine: 1, content: 'ytail' },
      ]);
    });

    it('splits separate changes into separate hunks with their section headings', () => {
      const multi = file(files, 'multi.txt');
      expect(multi.hunks.map((h) => [h.oldStart, h.newStart, h.section])).toEqual([
        [1, 1, ''],
        [24, 24, 'row 23'],
      ]);
      expect(multi.hunks[1].lines.find((l) => l.kind === 'add')).toMatchObject({ newLine: 27, content: 'row twenty-seven' });
    });
  });

  describe('shapes not in the fixtures', () => {
    it('returns no files for an empty diff', () => {
      expect(parseDiff('')).toEqual([]);
    });

    it('reads a quoted rename whose names have spaces and non-ASCII characters', () => {
      const [f] = parseDiff(
        [
          'diff --git "a/old caf\\303\\251.md" "b/new caf\\303\\251.md"',
          'similarity index 100%',
          'rename from "old caf\\303\\251.md"',
          'rename to "new caf\\303\\251.md"',
          '',
        ].join('\n'),
      );
      expect(f).toMatchObject({ path: 'new café.md', oldPath: 'old café.md', status: 'renamed' });
    });

    it('reads a copy', () => {
      const [f] = parseDiff(
        ['diff --git a/src/a.ts b/src/b.ts', 'similarity index 100%', 'copy from src/a.ts', 'copy to src/b.ts', ''].join('\n'),
      );
      expect(f).toMatchObject({ path: 'src/b.ts', oldPath: 'src/a.ts', status: 'copied' });
    });

    it('treats a `GIT binary patch` as binary and skips its body', () => {
      const [f, g] = parseDiff(
        [
          'diff --git a/img.png b/img.png',
          'index 1d20459..bf0acf5 100644',
          'GIT binary patch',
          'literal 73',
          'zcmeAS@N?(olHy`uVBq!ia0vp^EFjFm1|(O0oL2{==d',
          '',
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-a',
          '+b',
          '',
        ].join('\n'),
      );
      expect(f).toMatchObject({ path: 'img.png', binary: true, hunks: [] });
      expect(g.hunks[0].lines).toHaveLength(2);
    });

    it('accepts a context line whose leading space was stripped', () => {
      const [f] = parseDiff(['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,3 +1,3 @@', ' one', '', '-x', '+y', ''].join('\n'));
      expect(f.hunks[0].lines[1]).toEqual({ kind: 'context', oldLine: 2, newLine: 2, content: '' });
    });
  });

  // A wrong parse would put comments on the wrong lines; it must fail loudly instead.
  describe('malformed input', () => {
    const header = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts'];

    it.each([
      ['a hunk shorter than its header', [...header, '@@ -1,3 +1,3 @@', ' a', ' b'], /ends early/],
      ['a hunk longer than its header', [...header, '@@ -1,1 +1,1 @@', ' a', ' b'], /more lines than/],
      // The old side is used up after ' a', so '-b' overruns it while the new side still
      // expects a line — without a check it would parse quietly into wrong numbers.
      ['a deletion past the old side’s count', [...header, '@@ -1,1 +1,2 @@', ' a', '-b', '+c'], /more lines than/],
      ['a line with an unknown prefix', [...header, '@@ -1,2 +1,2 @@', ' a', '*b'], /unexpected line/],
      ['a malformed hunk header', [...header, '@@ -x +1 @@', ' a'], /malformed hunk header/],
      ['text before the first file', ['hello', ...header], /expected "diff --git"/],
    ])('rejects %s', (_name, lines, message) => {
      expect(() => parseDiff(lines.join('\n') + '\n')).toThrow(message);
    });

    it('reports the 1-based line it failed on', () => {
      const error = (() => {
        try {
          parseDiff([...header, '@@ -1,2 +1,2 @@', ' a', '*b', ''].join('\n'));
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(DiffParseError);
      expect(error).toMatchObject({ lineNumber: 6 });
    });
  });
});
