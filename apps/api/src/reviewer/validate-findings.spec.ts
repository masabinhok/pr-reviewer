import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { anchor, anchors, fingerprint, validateFindings } from './validate-findings.js';
import { parseDiff } from '../diff/parse-diff.js';
import { LineMap } from '../diff/line-map.js';
import { Severity } from '../generated/prisma/client.js';
import type { ProposedFinding } from './reviewer.js';

const diff = readFileSync(fileURLToPath(new URL('../../test/fixtures/diffs/diff-shapes.diff', import.meta.url)), 'utf8');
const lines = new LineMap(parseDiff(diff));

const proposed = (overrides: Partial<ProposedFinding> = {}): ProposedFinding => ({
  file: 'src/auth.ts',
  line: 26,
  side: 'RIGHT',
  severity: 'low',
  category: 'debugging',
  summary: '`console.log` is left in.',
  whyItBreaks: 'Every call writes to stdout in production.',
  ...overrides,
});

describe('validateFindings', () => {
  it('accepts a finding on a line in the diff, in the stored shape', () => {
    const { accepted, dropped } = validateFindings([proposed({ suggestedFix: '  Remove it. ' })], lines);

    expect(dropped).toEqual([]);
    expect(accepted).toEqual([
      {
        path: 'src/auth.ts',
        line: 26,
        side: 'RIGHT',
        severity: Severity.LOW,
        category: 'debugging',
        summary: '`console.log` is left in.',
        whyItBreaks: 'Every call writes to stdout in production.',
        suggestedFix: 'Remove it.',
        fingerprint: fingerprint('src/auth.ts', "  console.log('verifying', value);", 'debugging'),
        verdict: null,
        verdictReason: null,
        demotedFrom: null,
        anchors: anchors(lines, 'src/auth.ts', 26, 'RIGHT'),
      },
    ]);
  });

  it('carries the agent’s second look into the stored shape', () => {
    const { accepted } = validateFindings(
      [proposed({ verification: { verdict: 'unsure', reason: 'Line 25 may guard it.', demotedFrom: 'high' } })],
      lines,
    );

    expect(accepted[0]).toMatchObject({ verdict: 'UNSURE', verdictReason: 'Line 25 may guard it.', demotedFrom: 'HIGH' });
  });

  it.each<[string, Partial<ProposedFinding>]>([
    ['a line between hunks', { line: 21 }],
    ['the wrong side of an added line', { line: 9, side: 'LEFT', file: 'src/new-feature.ts' }],
    ['a file that is not in the diff', { file: 'src/elsewhere.ts' }],
    ['a binary file', { file: 'assets/logo.png', line: 1 }],
  ])('drops a finding on %s as outside-diff', (_where, overrides) => {
    const finding = proposed(overrides);

    expect(validateFindings([finding], lines)).toEqual({ accepted: [], dropped: [{ finding, reason: 'outside-diff' }] });
  });

  it.each(['', '   '])('drops a finding with no failure scenario (%j)', (whyItBreaks) => {
    const finding = proposed({ whyItBreaks });

    expect(validateFindings([finding], lines).dropped).toEqual([{ finding, reason: 'no-failure-scenario' }]);
  });

  // GitHub accepts a renamed file's old path; storage uses one name.
  it('stores a finding addressed by a renamed file’s old path under its new path', () => {
    const { accepted } = validateFindings([proposed({ file: 'src/utils.ts', line: 10, category: 'maintainability' })], lines);

    expect(accepted[0].path).toBe('src/helpers.ts');
  });

  it('maps severities to the database enum', () => {
    const severities = validateFindings(
      [
        proposed({ severity: 'high' }),
        proposed({ severity: 'medium', file: 'src/new-feature.ts', line: 2 }),
        proposed({ severity: 'low', file: 'src/helpers.ts', line: 10 }),
      ],
      lines,
    ).accepted.map((f) => f.severity);

    expect(severities).toEqual([Severity.HIGH, Severity.MEDIUM, Severity.LOW]);
  });

  // Seen on the local model: it filed one defect twice, as correctness and as security, and
  // both were posted — two identical comments on the same line of the pull request.
  describe('two findings on one line', () => {
    it('keeps the more severe one, whichever came first', () => {
      const low = proposed({ severity: 'low', category: 'correctness' });
      const high = proposed({ severity: 'high', category: 'security' });

      const first = validateFindings([low, high], lines);
      const second = validateFindings([high, low], lines);

      expect(first.accepted.map((f) => f.category)).toEqual(['security']);
      expect(second.accepted.map((f) => f.category)).toEqual(['security']);
      expect(first.dropped).toEqual([{ finding: low, reason: 'duplicate-line' }]);
      expect(second.dropped.map((d) => d.reason)).toEqual(['duplicate-line']);
    });

    it('keeps the first when they are equally severe', () => {
      const { accepted, dropped } = validateFindings(
        [proposed({ category: 'correctness' }), proposed({ category: 'security' })],
        lines,
      );

      expect(accepted.map((f) => f.category)).toEqual(['correctness']);
      expect(dropped).toEqual([{ finding: proposed({ category: 'security' }), reason: 'duplicate-line' }]);
    });

    it('leaves findings on different lines, files or sides alone', () => {
      const { accepted } = validateFindings(
        [
          proposed(),
          proposed({ line: 25 }),
          proposed({ file: 'src/new-feature.ts', line: 2 }),
          proposed({ side: 'LEFT', line: 24 }),
        ],
        lines,
      );

      expect(accepted).toHaveLength(4);
    });
  });
});

describe('anchor', () => {
  const code = "  console.log('verifying', value);";

  it('is the same wherever the line moved to and whatever the category', () => {
    // No line number or category goes in: code moves between pushes, and the model renames categories.
    expect(anchor('src/auth.ts', 'RIGHT', code)).toBe(anchor('src/auth.ts', 'RIGHT', `\t${code.trim()}   `));
  });

  it('differs by file, by side and by the code itself', () => {
    const base = anchor('src/auth.ts', 'RIGHT', code);

    expect(anchor('src/other.ts', 'RIGHT', code)).not.toBe(base);
    expect(anchor('src/auth.ts', 'LEFT', code)).not.toBe(base);
    expect(anchor('src/auth.ts', 'RIGHT', "  console.log('verifying', token);")).not.toBe(base);
  });

  it.each(['}', '  });', '', '*/', ') {', '[];'])('is null for a line with no identifier on it: %j', (line) => {
    expect(anchor('src/auth.ts', 'RIGHT', line)).toBeNull();
  });

  it('keeps short but real code', () => {
    expect(anchor('src/auth.ts', 'RIGHT', '  return pages[pages.length];')).not.toBeNull();
  });
});

describe('anchors', () => {
  const window = (line: number) => anchors(lines, 'src/auth.ts', line, 'RIGHT');

  // Seen live: the model put one defect on line 23 in one review and on line 24 in the next.
  it('overlaps for findings a line or two apart, so a wobble in the chosen line is still one comment', () => {
    const shared = window(26).filter((a) => window(27).includes(a));

    expect(shared.length).toBeGreaterThan(0);
  });

  it('includes the finding’s own line when it has real code', () => {
    expect(window(26)).toContain(anchor('src/auth.ts', 'RIGHT', "  console.log('verifying', value);"));
  });

  it('has no hashes from outside the diff or from lines with no identifier', () => {
    expect(anchors(lines, 'src/elsewhere.ts', 26, 'RIGHT')).toEqual([]);
    expect(window(26).every((a) => typeof a === 'string' && a.length === 64)).toBe(true);
  });

  it('does not overlap for findings far apart in the file', () => {
    expect(window(26).filter((a) => window(10).includes(a))).toEqual([]);
  });
});

describe('fingerprint', () => {
  const base = fingerprint('src/auth.ts', "console.log('x');", 'debugging');

  // The whole point: the same problem, pushed again a few lines lower, is not new.
  it('ignores where the line is and how it is indented', () => {
    expect(fingerprint('src/auth.ts', "    console.log('x');", 'debugging')).toBe(base);
    expect(fingerprint('src/auth.ts', "console.log(  'x'  );", 'debugging')).not.toBe(base); // inner code differs
    expect(fingerprint('src/auth.ts', "console.log('x');\t", 'debugging')).toBe(base);
  });

  it('changes with the file, the code, or the kind of problem', () => {
    expect(fingerprint('src/other.ts', "console.log('x');", 'debugging')).not.toBe(base);
    expect(fingerprint('src/auth.ts', "console.log('y');", 'debugging')).not.toBe(base);
    expect(fingerprint('src/auth.ts', "console.log('x');", 'security')).not.toBe(base);
  });

  it('is a 64-character hex digest', () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });
});
