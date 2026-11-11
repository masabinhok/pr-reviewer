import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StubReviewer } from './stub-reviewer.js';
import { parseDiff } from '../diff/parse-diff.js';
import { LineMap } from '../diff/line-map.js';
import type { ReviewContext } from './reviewer.js';

function context(diff: string): ReviewContext {
  const files = parseDiff(diff);
  return {
    installationId: 1n,
    repo: 'o/r',
    prNumber: 1,
    title: '',
    body: '',
    baseSha: 'b',
    headSha: 'h',
    files,
    lines: new LineMap(files),
  };
}

describe('StubReviewer', () => {
  it('finds the three planted problems in the real testbed PR, on the lines they were added', async () => {
    const diff = readFileSync(
      fileURLToPath(
        new URL('../../test/fixtures/diffs/diff-shapes.diff', import.meta.url),
      ),
      'utf8',
    );

    const { findings } = await new StubReviewer().review(context(diff));

    expect(
      findings.map((f) => [f.file, f.line, f.side, f.severity, f.category]),
    ).toEqual([
      ['src/auth.ts', 26, 'RIGHT', 'low', 'debugging'],
      ['src/helpers.ts', 10, 'RIGHT', 'low', 'maintainability'],
      ['src/new-feature.ts', 2, 'RIGHT', 'medium', 'correctness'],
    ]);
    expect(findings.every((f) => f.whyItBreaks.length > 20)).toBe(true);
  });

  // Flagging code the author didn't touch is exactly the noise that gets bots uninstalled.
  it('ignores the same patterns on context and deleted lines', async () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,3 @@',
      " console.log('already here');",
      '-debugger;',
      '+const x = 1;',
      ' // TODO: old one',
      '',
    ].join('\n');

    expect(await new StubReviewer().review(context(diff))).toEqual({
      findings: [],
    });
  });
});
