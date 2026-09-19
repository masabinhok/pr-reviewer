import type { Fixture } from './fixture.js';
import { isAt, matchKey, scoreResult, scoreRun, spread, type FixtureResult, type Judgments, type Level, type Spread } from './score.js';

/** What a run was made with, written when it starts (`meta.json`). */
export interface RunMeta {
  started: string;
  /** The commit of this repository the run was made on, and whether the tree had changes. */
  commit: string;
  dirty: boolean;
  runs: number;
  bar: string;
  fixtures: string[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

function show(s: Spread | null, format: (v: number) => string): string {
  if (!s) return '—';
  if (s.runs === 1) return `${format(s.mean)} (1 run)`;
  return s.min === s.max ? format(s.mean) : `${format(s.mean)} (${format(s.min)}–${format(s.max)})`;
}

function table(rows: string[][]): string {
  const [head, ...body] = rows;
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

/**
 * The report of a run directory, as Markdown: the numbers by split and level, each as the mean
 * over runs with its range, then time and tokens, then — for the tuning split, and the held-out
 * one only when asked (trap 3) — every fixture run by run, and the location matches that still
 * need reading (trap 6).
 */
export function renderReport(
  meta: RunMeta,
  results: FixtureResult[],
  fixtures: Fixture[],
  options: { judgments?: Judgments; showHeldout?: boolean } = {},
): string {
  const judgments = options.judgments ?? {};
  const runs = [...new Set(results.map((r) => r.run))].sort((a, b) => a - b);
  const models = [...new Set(results.map((r) => r.model).filter((m) => m !== null))];
  const inRun = fixtures.filter((f) => meta.fixtures.includes(f.id));
  const count = (k: Fixture['kind']) => inRun.filter((f) => f.kind === k).length;

  const out: string[] = [];
  out.push(`# Evaluation, ${meta.started.slice(0, 16).replace('T', ' ')}`);
  out.push('');
  out.push(
    `${models.join(', ') || 'no model answered'} · posting bar ${meta.bar.toLowerCase()} · ` +
      `${runs.length} of ${meta.runs} run(s) · ${inRun.length} fixtures (${count('bug')} bug, ${count('clean')} clean) · ` +
      `commit ${meta.commit.slice(0, 7)}${meta.dirty ? ' with uncommitted changes' : ''}`,
  );
  out.push('');
  out.push(
    '**Kept** is every finding that survived the second look and validation — what the Check Run lists. ' +
      '**Posted** is what met the posting bar — what a person sees on the pull request. ' +
      'Each number is the mean over runs, with the range in brackets.',
  );

  const splits: [string, (f: Fixture) => boolean][] = [
    ['held-out', (f) => f.split === 'heldout'],
    ['tune', (f) => f.split === 'tune'],
    ['all', () => true],
  ];
  const rows: string[][] = [['split', 'level', 'recall', 'precision', 'false positives per clean PR']];
  for (const [name, keep] of splits) {
    const subset = new Map(inRun.filter(keep).map((f) => [f.id, f]));
    for (const level of ['kept', 'posted'] as Level[]) {
      const scores = runs.map((r) => scoreRun(r, results, subset, level, judgments));
      rows.push([
        name,
        level,
        show(spread(scores.map((s) => s.recall)), pct),
        show(spread(scores.map((s) => s.precision)), pct),
        show(spread(scores.map((s) => s.fpPerClean)), num),
      ]);
    }
  }
  out.push('', '## Numbers', '', table(rows));

  const all = new Map(inRun.map((f) => [f.id, f]));
  const perRun = runs.map((r) => scoreRun(r, results, all, 'kept', judgments));
  const done = results.filter((r) => r.error === null);
  const errors = results.filter((r) => r.error !== null);
  const unread = perRun.reduce((t, s) => t + s.unread, 0);
  out.push('', '## Cost', '');
  out.push(
    table([
      ['', 'mean', 'range'],
      secondsRow('seconds per review', done.map((r) => r.seconds)),
      secondsRow('tokens in per review', done.map((r) => r.tokensIn)),
      secondsRow('tokens out per review', done.map((r) => r.tokensOut)),
    ]),
  );
  out.push('');
  out.push(
    `${results.length} review(s), ${errors.length} failed` +
      (errors.length ? ` (${[...new Set(errors.map((e) => e.error))].slice(0, 3).join('; ')})` : '') +
      '. A failed review finds nothing: its bugs count as missed.',
  );
  if (unread > 0) {
    out.push('', `**${unread} location match(es) not read yet** — they count as found until judged (trap 6).`);
  }

  const shown = inRun.filter((f) => f.split === 'tune' || options.showHeldout);
  out.push('', '## Fixtures', '');
  if (!options.showHeldout) {
    out.push('Held-out fixtures are left out: they decide, and are not looked at one by one (trap 3).', '');
  }
  out.push(
    table([
      ['fixture', 'split', ...runs.map((r) => `run ${r}`)],
      ...shown.map((f) => [
        f.id,
        f.split,
        ...runs.map((run) => {
          const result = results.find((r) => r.fixture === f.id && r.run === run);
          if (!result) return 'not run';
          if (result.error !== null) return 'failed';
          const kept = scoreResult(result, f, 'kept', judgments);
          const posted = scoreResult(result, f, 'posted', judgments);
          const found = f.kind === 'bug' ? `${kept.found}/${kept.bugs} found · ` : '';
          return `${found}${kept.findings} kept, ${posted.findings} posted, ${result.refuted} refuted`;
        }),
      ]),
    ]),
  );

  const matches = matchesToRead(results, shown, judgments);
  if (matches.length > 0) {
    out.push('', '## Matches to read', '');
    out.push('Mark each in `judgments.json` as `right` (it describes the bug) or `wrong` (it describes something else):', '');
    for (const m of matches) out.push(`- \`${m.key}\` — **${m.summary}**  \n  the bug: ${m.bug}`);
  }

  return out.join('\n') + '\n';
}

function secondsRow(label: string, values: number[]): string[] {
  if (values.length === 0) return [label, '—', '—'];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return [label, Math.round(mean).toLocaleString('en'), `${Math.round(Math.min(...values)).toLocaleString('en')}–${Math.round(Math.max(...values)).toLocaleString('en')}`];
}

function matchesToRead(results: FixtureResult[], fixtures: Fixture[], judgments: Judgments) {
  const out: { key: string; summary: string; bug: string }[] = [];
  for (const f of fixtures) {
    for (const result of results.filter((r) => r.fixture === f.id)) {
      for (const finding of result.findings) {
        const key = matchKey(result, finding);
        const bug = f.bugs.find((b) => isAt(finding, b));
        if (bug && judgments[key] === undefined) out.push({ key, summary: finding.summary, bug: bug.description });
      }
    }
  }
  return out;
}
