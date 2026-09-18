import { describe, expect, it } from 'vitest';
import { ago, count, duration, money, percent, statusLabel, tokens, verdictLabel } from './format';
import { funnel } from './funnel';
import type { Overview } from './api';

describe('format', () => {
  it('writes durations the way a person reads them', () => {
    expect([duration(null), duration(9), duration(60), duration(130), duration(3900)]).toEqual(['—', '9s', '1m', '2m 10s', '1h 5m']);
  });

  it('shortens token counts', () => {
    expect([tokens(null), tokens(855), tokens(21_362), tokens(137_012), tokens(2_400_000)]).toEqual(['—', '855', '21k', '137k', '2.4M']);
    expect(tokens(4_316)).toBe('4.3k');
  });

  it('says what a local model costs rather than hiding it', () => {
    expect([money(null), money(0), money(0.0921), money(0.004)]).toEqual(['—', '$0.00', '$0.09', '$0.0040']);
  });

  it('refuses to divide by nothing', () => {
    expect([percent(3, 13), percent(0, 0)]).toEqual(['23%', '—']);
    expect(count(35_000)).toBe('35,000');
  });

  it('dates relative to now', () => {
    const now = new Date('2026-09-18T12:00:00Z');
    expect(ago('2026-09-18T11:58:00Z', now)).toBe('2 min ago');
    expect(ago('2026-09-18T09:00:00Z', now)).toBe('3 hours ago');
    expect(ago('2026-09-17T11:00:00Z', now)).toBe('yesterday');
    expect(ago('2026-09-01T11:00:00Z', now)).toBe('1 Sept');
  });

  it('names statuses and verdicts in plain words', () => {
    expect(statusLabel('SKIPPED')).toBe('Too large to review');
    expect(verdictLabel(null)).toBe('Not checked');
    expect(verdictLabel('UNVERIFIED')).toBe('No verdict');
  });
});

describe('funnel', () => {
  const overview = {
    findings: { total: 35, droppedOnSecondLook: 6, posted: 13, repeats: 1 },
    feedback: { downvoted: 3 },
  } as unknown as Overview;

  it('follows findings from proposed to marked wrong, in order', () => {
    expect(funnel(overview).map((s) => [s.key, s.value])).toEqual([
      ['proposed', 41],
      ['refuted', 6],
      ['kept', 35],
      ['posted', 13],
      ['downvoted', 3],
    ]);
  });

  it('mentions the repeats it did not post again', () => {
    expect(funnel(overview)[3].note).toContain('1 more was already there');
    expect(funnel({ ...overview, findings: { ...overview.findings, repeats: 0 } })[3].note).toBe('Commented on the pull request.');
  });
});
