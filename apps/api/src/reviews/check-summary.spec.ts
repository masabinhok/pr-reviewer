import { renderCheck } from './check-summary.js';
import { Severity } from '../generated/prisma/client.js';
import type { ValidFinding } from '../reviewer/validate-findings.js';

const HEAD = 'bc26a45357e0d8886c7aab3f2aa409fce73f8e43';

const finding = (severity: Severity, path = 'src/auth.ts', line = 26, summary = 'debug output left in'): ValidFinding => ({
  severity,
  path,
  line,
  summary,
  side: 'RIGHT',
  category: 'debugging',
  whyItBreaks: 'writes to stdout in production',
  suggestedFix: null,
  fingerprint: 'f'.repeat(64),
});

describe('renderCheck', () => {
  describe('a completed review', () => {
    it('is a success titled by its findings, even when it has some', () => {
      const { conclusion, output } = renderCheck(
        { kind: 'completed', reviewed: ['src/auth.ts', 'src/new-feature.ts'], skipped: [], findings: [finding(Severity.MEDIUM)] },
        HEAD,
      );

      expect(conclusion).toBe('success');
      expect(output.title).toBe('1 finding in 2 files');
      expect(output.summary).toContain('Reviewed 2 files at `bc26a45`.');
    });

    it('says so plainly when there is nothing to report', () => {
      const { output } = renderCheck({ kind: 'completed', reviewed: ['a.ts'], skipped: [], findings: [] }, HEAD);

      expect(output.title).toBe('No findings in 1 file');
      expect(output.summary).toContain('No findings.');
    });

    it('tallies by severity and lists the most severe first', () => {
      const { output } = renderCheck(
        {
          kind: 'completed',
          reviewed: ['a.ts'],
          skipped: [],
          findings: [finding(Severity.LOW, 'a.ts', 3, 'low one'), finding(Severity.HIGH, 'a.ts', 9, 'high one')],
        },
        HEAD,
      );

      expect(output.summary).toContain('**Findings:** 1 high · 0 medium · 1 low');
      expect(output.summary.indexOf('high one')).toBeLessThan(output.summary.indexOf('low one'));
      expect(output.summary).toContain('| high | `a.ts:9` | high one |');
    });

    it('lists what was not reviewed, and why, in a collapsed section', () => {
      const { output } = renderCheck(
        {
          kind: 'completed',
          reviewed: ['src/auth.ts'],
          skipped: [
            { path: 'package-lock.json', reason: 'lockfile' },
            { path: 'assets/logo.png', reason: 'binary' },
          ],
          findings: [],
        },
        HEAD,
      );

      expect(output.summary).toContain('<summary>2 files not reviewed</summary>');
      expect(output.summary).toContain('| `package-lock.json` | lockfile |');
    });

    // A pipe in a finding would end its table cell; a newline would end the row.
    it('keeps finding text from breaking the table', () => {
      const { output } = renderCheck(
        { kind: 'completed', reviewed: ['a.ts'], skipped: [], findings: [finding(Severity.LOW, 'a.ts', 1, 'a || b\nis always truthy')] },
        HEAD,
      );

      expect(output.summary).toContain('| a \\|\\| b is always truthy |');
    });

    it('shows at most 50 findings and says how many more there are', () => {
      const findings = Array.from({ length: 60 }, (_, i) => finding(Severity.LOW, 'a.ts', i + 1, `finding ${i + 1}`));

      const { output } = renderCheck({ kind: 'completed', reviewed: ['a.ts'], skipped: [], findings }, HEAD);

      expect(output.summary).toContain('finding 50 |');
      expect(output.summary).not.toContain('finding 51 |');
      expect(output.summary).toContain('…and 10 more.');
    });

    it('stays under GitHub’s summary limit however much there is to say', () => {
      const skipped = Array.from({ length: 3000 }, (_, i) => ({ path: `vendor/${'x'.repeat(40)}/${i}.go`, reason: 'vendored' as const }));

      const { output } = renderCheck({ kind: 'completed', reviewed: [], skipped, findings: [] }, HEAD);

      expect(output.summary.length).toBeLessThan(65_535);
      expect(output.summary).toMatch(/summary truncated\.$/);
    });
  });

  it('marks a too-large PR as skipped, with the limit it hit', () => {
    const { conclusion, output } = renderCheck(
      { kind: 'skipped', reason: '62 files to review, over the limit of 50', skipped: [] },
      HEAD,
    );

    expect(conclusion).toBe('skipped');
    expect(output.title).toBe('Not reviewed: 62 files to review, over the limit of 50');
  });

  it('marks a failed review as failure, with the error and the attempts it took', () => {
    const { conclusion, output } = renderCheck({ kind: 'failed', error: 'GitHub 502 on /repos/o/r/compare', attempts: 3 }, HEAD);

    expect(conclusion).toBe('failure');
    expect(output.title).toBe('Review failed');
    expect(output.summary).toContain('failed after 3 attempts');
    expect(output.summary).toContain('GitHub 502 on /repos/o/r/compare');
  });
});
