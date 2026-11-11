import type { DiffFile, DiffLine, Hunk } from './diff.types.js';

/** The diff is not what `git diff` produces. Carries the 1-based line it failed on. */
export class DiffParseError extends Error {
  constructor(
    message: string,
    readonly lineNumber: number,
  ) {
    super(`diff line ${lineNumber}: ${message}`);
    this.name = 'DiffParseError';
  }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DEV_NULL = '/dev/null';

/**
 * Parses a unified diff as produced by `git diff` — and so by GitHub's diff media type —
 * into files, hunks and numbered lines.
 *
 * A pure function: string in, structure out. It checks every hunk's line counts against
 * its `@@` header and throws `DiffParseError` on a mismatch, because a silently wrong
 * parse would anchor review comments to the wrong lines.
 */
export function parseDiff(text: string): DiffFile[] {
  const lines = text.split('\n');
  // A diff ends with a newline, which leaves one empty string after the split.
  if (lines.at(-1) === '') lines.pop();

  const files: DiffFile[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git ')) {
      throw new DiffParseError(
        `expected "diff --git", found "${lines[i].slice(0, 40)}"`,
        i + 1,
      );
    }
    const start = i;
    const header = headerPaths(lines[i].slice('diff --git '.length));
    i++;

    const file: DiffFile = {
      path: '',
      oldPath: '',
      status: 'modified',
      binary: false,
      hunks: [],
    };
    let from = header?.from;
    let to = header?.to;
    let oldMode: string | undefined;
    let newMode: string | undefined;

    // Extended header lines, until the first hunk or the next file.
    while (
      i < lines.length &&
      !lines[i].startsWith('@@') &&
      !lines[i].startsWith('diff --git ')
    ) {
      const line = lines[i];
      if (line.startsWith('new file mode ')) {
        file.status = 'added';
      } else if (line.startsWith('deleted file mode ')) {
        file.status = 'removed';
      } else if (line.startsWith('old mode ')) {
        oldMode = line.slice('old mode '.length);
      } else if (line.startsWith('new mode ')) {
        newMode = line.slice('new mode '.length);
      } else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        from = unquote(line.slice('rename from '.length));
      } else if (line.startsWith('rename to ')) {
        file.status = 'renamed';
        to = unquote(line.slice('rename to '.length));
      } else if (line.startsWith('copy from ')) {
        file.status = 'copied';
        from = unquote(line.slice('copy from '.length));
      } else if (line.startsWith('copy to ')) {
        file.status = 'copied';
        to = unquote(line.slice('copy to '.length));
      } else if (
        line.startsWith('Binary files ') ||
        line === 'GIT binary patch'
      ) {
        file.binary = true;
      } else if (line.startsWith('--- ')) {
        const path = markerPath(line.slice(4), 'a/');
        if (path === DEV_NULL) file.status = 'added';
        else from = path;
      } else if (line.startsWith('+++ ')) {
        const path = markerPath(line.slice(4), 'b/');
        if (path === DEV_NULL) file.status = 'removed';
        else to = path;
      }
      // `index …`, `similarity index`, `dissimilarity index`, and the base85 body of a
      // GIT binary patch carry nothing a review comment needs.
      i++;
    }

    if (from === undefined || to === undefined) {
      throw new DiffParseError('could not determine the file path', start + 1);
    }
    file.oldPath = from;
    file.path = file.status === 'removed' ? from : to;
    if (oldMode && newMode && oldMode !== newMode)
      file.modeChange = { from: oldMode, to: newMode };

    while (i < lines.length && lines[i].startsWith('@@')) {
      const [hunk, next] = parseHunk(lines, i);
      file.hunks.push(hunk);
      i = next;
    }

    files.push(file);
  }

  return files;
}

function parseHunk(lines: string[], at: number): [Hunk, number] {
  const match = HUNK_HEADER.exec(lines[at]);
  if (!match)
    throw new DiffParseError(`malformed hunk header "${lines[at]}"`, at + 1);

  const hunk: Hunk = {
    oldStart: Number(match[1]),
    // A missing count means 1: `@@ -3 +3 @@` is one line on each side.
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    section: match[5].trim(),
    lines: [],
  };

  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let oldLeft = hunk.oldLines;
  let newLeft = hunk.newLines;
  let i = at + 1;

  while (oldLeft > 0 || newLeft > 0) {
    if (i >= lines.length) {
      throw new DiffParseError(
        `hunk ends early: ${oldLeft} old and ${newLeft} new line(s) missing`,
        i,
      );
    }
    const raw = lines[i];
    const prefix = raw[0];
    const content = raw.slice(1);
    let line: DiffLine;

    // An empty string is a context line whose leading space some tool stripped along the
    // way; git itself always writes the space.
    if (prefix === ' ' || raw === '') {
      line = {
        kind: 'context',
        oldLine: oldLine++,
        newLine: newLine++,
        content,
      };
      oldLeft--;
      newLeft--;
    } else if (prefix === '-') {
      line = { kind: 'del', oldLine: oldLine++, content };
      oldLeft--;
    } else if (prefix === '+') {
      line = { kind: 'add', newLine: newLine++, content };
      newLeft--;
    } else if (prefix === '\\') {
      markNoNewline(hunk, i);
      i++;
      continue;
    } else {
      throw new DiffParseError(
        `unexpected line inside a hunk: "${raw.slice(0, 40)}"`,
        i + 1,
      );
    }

    if (oldLeft < 0 || newLeft < 0) {
      throw new DiffParseError(
        'hunk has more lines than its @@ header declares',
        i + 1,
      );
    }
    hunk.lines.push(line);
    i++;
  }

  // When the hunk's last line has no newline, its marker comes after the counts run out.
  while (i < lines.length && lines[i].startsWith('\\')) {
    markNoNewline(hunk, i);
    i++;
  }

  // Anything else before the next hunk or file means the counts were wrong.
  if (
    i < lines.length &&
    !lines[i].startsWith('@@') &&
    !lines[i].startsWith('diff --git ')
  ) {
    throw new DiffParseError(
      'hunk has more lines than its @@ header declares',
      i + 1,
    );
  }

  return [hunk, i];
}

function markNoNewline(hunk: Hunk, at: number) {
  const previous = hunk.lines.at(-1);
  if (!previous)
    throw new DiffParseError(
      '"No newline" marker with no line before it',
      at + 1,
    );
  previous.noNewlineAtEnd = true;
}

/**
 * Paths from the `diff --git` line. Unambiguous when quoted, or when the old and new paths
 * are the same — even with spaces, because the line is then `a/X b/X`. A rename whose
 * names contain spaces is ambiguous here, but its `rename from` / `rename to` lines settle it.
 */
function headerPaths(rest: string): { from: string; to: string } | undefined {
  if (rest.startsWith('"')) {
    const [a, after] = readQuoted(rest);
    const b = after.trimStart();
    return {
      from: stripPrefix(a, 'a/'),
      to: stripPrefix(b.startsWith('"') ? readQuoted(b)[0] : b, 'b/'),
    };
  }

  const half = (rest.length - 5) / 2; // rest is "a/" + X + " b/" + X
  if (Number.isInteger(half) && half > 0) {
    const x = rest.slice(2, 2 + half);
    if (rest === `a/${x} b/${x}`) return { from: x, to: x };
  }

  // Unquoted, different, no spaces — a plain rename or copy.
  const split = rest.indexOf(' b/');
  if (rest.startsWith('a/') && split > 0)
    return { from: rest.slice(2, split), to: rest.slice(split + 3) };
  return undefined;
}

/** A `---` / `+++` path. Git appends a tab when the path contains a space. */
function markerPath(value: string, prefix: 'a/' | 'b/'): string {
  const path = unquote(value.replace(/\t$/, ''));
  return path === DEV_NULL ? DEV_NULL : stripPrefix(path, prefix);
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function unquote(value: string): string {
  return value.startsWith('"') ? readQuoted(value)[0] : value;
}

const ESCAPES: Record<string, number> = {
  n: 10,
  t: 9,
  r: 13,
  '"': 34,
  '\\': 92,
  a: 7,
  b: 8,
  f: 12,
  v: 11,
};

/**
 * Reads a C-style quoted path, as git writes names containing non-ASCII or special
 * characters: `"caf\303\251.md"` is `café.md` — the octal escapes are raw UTF-8 bytes.
 * Returns the decoded path and whatever follows the closing quote.
 */
function readQuoted(value: string): [string, string] {
  const bytes: number[] = [];
  let i = 1;

  for (; i < value.length && value[i] !== '"'; i++) {
    if (value[i] !== '\\') {
      bytes.push(...Buffer.from(value[i], 'utf8'));
      continue;
    }
    i++;
    if (/[0-7]/.test(value[i])) {
      bytes.push(parseInt(value.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(ESCAPES[value[i]] ?? value.charCodeAt(i));
    }
  }

  return [Buffer.from(bytes).toString('utf8'), value.slice(i + 1)];
}
