import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fingerprint, validateFindings } from './validate-findings.js';
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
      },
    ]);
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
      [proposed({ severity: 'high' }), proposed({ severity: 'medium' }), proposed({ severity: 'low' })],
      lines,
    ).accepted.map((f) => f.severity);

    expect(severities).toEqual([Severity.HIGH, Severity.MEDIUM, Severity.LOW]);
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
