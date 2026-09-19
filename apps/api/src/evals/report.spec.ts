import type { Bug, Fixture } from './fixture.js';
import { renderReport, type RunMeta } from './report.js';
import type { EvalFinding, FixtureResult } from './score.js';

const bug: Bug = { file: 'a.ts', head: [10, 10], base: [10, 10], description: 'off by one' };
const fixtures = [
  { id: 'tuned', kind: 'bug', split: 'tune', bugs: [bug] },
  { id: 'secret', kind: 'bug', split: 'heldout', bugs: [bug] },
  { id: 'calm', kind: 'clean', split: 'heldout', bugs: [] },
] as unknown as Fixture[];

const meta: RunMeta = {
  started: '2026-09-19T10:00:00.000Z',
  commit: 'abcdef0123456789',
  dirty: false,
  runs: 2,
  bar: 'HIGH',
  fixtures: ['tuned', 'secret', 'calm'],
};

function at(line: number, posted = true): EvalFinding {
  return {
    path: 'a.ts',
    line,
    side: 'RIGHT',
    severity: posted ? 'HIGH' : 'LOW',
    category: 'correctness',
    summary: `summary ${line}`,
    whyItBreaks: 'x',
    verdict: null,
    demotedFrom: null,
    posted,
  };
}

function result(fixture: string, run: number, findings: EvalFinding[], error: string | null = null): FixtureResult {
  const f = fixtures.find((x) => x.id === fixture)!;
  return {
    fixture,
    run,
    kind: f.kind,
    split: f.split,
    seconds: run * 10,
    error,
    model: 'pr-reviewer:qwen2.5-7b',
    outcome: 'submitted',
    turns: 2,
    toolCalls: 1,
    verifyCalls: 1,
    tokensIn: 1000,
    tokensOut: 100,
    findings,
    refuted: 0,
    invalid: 0,
  };
}

const results = [
  result('tuned', 1, [at(10)]),
  result('secret', 1, [at(10, false)]),
  result('calm', 1, [at(3)]),
  result('tuned', 2, []),
  result('secret', 2, [at(11)]),
  result('calm', 2, [], 'agent answered 503'),
];

describe('renderReport', () => {
  const report = renderReport(meta, results, fixtures);

  it('says what the run was made with', () => {
    expect(report).toContain('pr-reviewer:qwen2.5-7b · posting bar high · 2 of 2 run(s) · 3 fixtures (2 bug, 1 clean) · commit abcdef0');
  });

  it('gives each number as a mean with its range over runs, per split and level', () => {
    // held-out, kept — run 1: the bug found, 1 of 2 findings at it, 1 on the clean fixture;
    // run 2: found, 1 of 1, and the clean review failed, so no false-positive number that run.
    expect(report).toContain('| held-out | kept | 100% | 75% (50%–100%) | 1 (1 run) |');
    // held-out, posted — run 1's match was low, so not posted: missed, and 0 of 1 posted is at it.
    expect(report).toContain('| held-out | posted | 50% (0%–100%) | 50% (0%–100%) | 1 (1 run) |');
    expect(report).toContain('| tune | kept | 50% (0%–100%) | 100% (1 run) | — |');
  });

  it('counts failures, which miss their bugs', () => {
    expect(report).toContain('6 review(s), 1 failed (agent answered 503)');
  });

  it('lists tuning fixtures one by one, and not held-out ones unless asked', () => {
    expect(report).toContain('| tuned | tune | 1/1 found · 1 kept, 1 posted, 0 refuted | 0/1 found · 0 kept, 0 posted, 0 refuted |');
    expect(report).not.toContain('| secret |');
    expect(report).not.toContain('secret#');

    const all = renderReport(meta, results, fixtures, { showHeldout: true });
    expect(all).toContain('| secret | heldout | 1/1 found · 1 kept, 0 posted, 0 refuted | 1/1 found · 1 kept, 1 posted, 0 refuted |');
    expect(all).toContain('| calm | heldout | 1 kept, 1 posted, 0 refuted | failed |');
  });

  it('asks for the location matches to be read, until they are judged', () => {
    expect(report).toContain('**3 location match(es) not read yet**');
    expect(report).toContain('- `tuned#1#a.ts:10:RIGHT` — **summary 10**  \n  the bug: off by one');

    const judged = renderReport(meta, results, fixtures, {
      judgments: { 'tuned#1#a.ts:10:RIGHT': 'wrong', 'secret#1#a.ts:10:RIGHT': 'right', 'secret#2#a.ts:11:RIGHT': 'right' },
    });
    expect(judged).not.toContain('not read yet');
    expect(judged).toContain('| tune | kept | 0% | 0% (1 run) | — |');
  });
});
