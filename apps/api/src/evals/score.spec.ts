import type { Bug, Fixture } from './fixture.js';
import {
  bugAt,
  isAt,
  matchKey,
  scoreResult,
  scoreRun,
  spread,
  type EvalFinding,
  type FixtureResult,
} from './score.js';

// Hand-made results: the scoring is checked against answers worked out on paper.

const bug: Bug = {
  file: 'index.js',
  head: [17, 17],
  base: [17, 22],
  description: 'maxAge 0 is dropped',
};

function fixture(
  id: string,
  kind: Fixture['kind'],
  bugs: Bug[] = [],
  split: Fixture['split'] = 'tune',
): Fixture {
  return { id, kind, split, bugs } as Fixture;
}

function finding(
  line: number,
  overrides: Partial<EvalFinding> = {},
): EvalFinding {
  return {
    path: 'index.js',
    line,
    side: 'RIGHT',
    severity: 'HIGH',
    category: 'correctness',
    summary: `finding at ${line}`,
    whyItBreaks: 'because',
    verdict: 'CONFIRMED',
    demotedFrom: null,
    posted: true,
    ...overrides,
  };
}

function result(
  fixtureId: string,
  run: number,
  findings: EvalFinding[],
  overrides: Partial<FixtureResult> = {},
): FixtureResult {
  return {
    fixture: fixtureId,
    run,
    kind: 'bug',
    split: 'tune',
    seconds: 10,
    error: null,
    model: 'm',
    outcome: 'submitted',
    turns: 1,
    toolCalls: 0,
    verifyCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    findings,
    refuted: 0,
    invalid: 0,
    ...overrides,
  };
}

describe('isAt: same file, within three lines, on the side commented on', () => {
  it.each([
    [17, 'RIGHT', true],
    [14, 'RIGHT', true],
    [20, 'RIGHT', true],
    [13, 'RIGHT', false],
    [21, 'RIGHT', false],
    // Removed code is measured against the base lines: 17–22, give or take three.
    [25, 'LEFT', true],
    [26, 'LEFT', false],
  ] as const)('line %i on %s → %s', (line, side, expected) => {
    expect(isAt(finding(line, { side }), bug)).toBe(expected);
  });

  it('never matches another file, however close the line', () => {
    expect(isAt(finding(17, { path: 'other.js' }), bug)).toBe(false);
  });

  it('matches any of the places the same defect is in', () => {
    const twice: Bug = {
      ...bug,
      alsoAt: [{ file: 'b.js', head: [40, 41], base: [40, 40] }],
    };
    expect(isAt(finding(43, { path: 'b.js' }), twice)).toBe(true);
  });
});

describe('scoreResult', () => {
  const two = fixture('f', 'bug', [
    bug,
    { file: 'index.js', head: [60, 60], base: [60, 60], description: 'other' },
  ]);

  it('counts bugs found, not findings: two comments on one bug find one', () => {
    const s = scoreResult(
      result('f', 1, [finding(17), finding(18), finding(100)]),
      two,
      'kept',
    );

    expect(s).toEqual({
      bugs: 2,
      found: 1,
      findings: 3,
      matched: 2,
      unread: 2,
    });
  });

  it('only counts posted findings at the posted level', () => {
    const r = result('f', 1, [
      finding(17, { posted: false, severity: 'LOW' }),
      finding(60),
    ]);

    expect(scoreResult(r, two, 'kept').found).toBe(2);
    expect(scoreResult(r, two, 'posted')).toMatchObject({
      found: 1,
      findings: 1,
    });
  });

  it('a match someone judged wrong found nothing — it described another problem', () => {
    const r = result('f', 1, [finding(17)]);
    const judged = { [matchKey(r, finding(17))]: 'wrong' as const };

    expect(scoreResult(r, two, 'kept', judged)).toMatchObject({
      found: 0,
      matched: 0,
      unread: 0,
    });
  });

  it('a match judged right is no longer unread', () => {
    const r = result('f', 1, [finding(17)]);

    expect(
      scoreResult(r, two, 'kept', { [matchKey(r, finding(17))]: 'right' }),
    ).toMatchObject({ found: 1, unread: 0 });
  });

  it('a comment between two bugs finds only the nearer one', () => {
    const close = fixture('p', 'bug', [
      {
        file: 'index.js',
        head: [28, 28],
        base: [0, 0],
        description: 'off by one',
      },
      {
        file: 'index.js',
        head: [32, 32],
        base: [0, 0],
        description: 'no empty check',
      },
    ]);
    // Line 31 is within three lines of both.
    const s = scoreResult(result('p', 1, [finding(31)]), close, 'kept');

    expect(s).toMatchObject({ found: 1, matched: 1 });
    expect(bugAt(finding(31), close.bugs)?.description).toBe('no empty check');
  });

  it('on a clean fixture every finding is unmatched', () => {
    expect(
      scoreResult(result('c', 1, [finding(17)]), fixture('c', 'clean'), 'kept'),
    ).toEqual({
      bugs: 0,
      found: 0,
      findings: 1,
      matched: 0,
      unread: 0,
    });
  });
});

describe('scoreRun', () => {
  const fixtures = new Map([
    ['a', fixture('a', 'bug', [bug])],
    ['b', fixture('b', 'bug', [bug])],
    ['c', fixture('c', 'clean')],
    ['d', fixture('d', 'clean')],
  ]);

  it('recall over bugs, precision over findings, false positives over clean fixtures', () => {
    const results = [
      result('a', 1, [finding(17), finding(90)]),
      result('b', 1, []),
      result('c', 1, [finding(5), finding(6), finding(7)]),
      result('d', 1, []),
      result('a', 2, []), // another run: not counted in run 1
    ];

    expect(scoreRun(1, results, fixtures, 'kept')).toMatchObject({
      recall: 0.5, // 1 of 2 bugs
      precision: 0.2, // 1 of 5 findings is at a bug
      fpPerClean: 1.5, // 3 findings over 2 clean fixtures
      errors: 0,
      meanSeconds: 10,
    });
  });

  it('a failed review misses its bugs and is not timed', () => {
    const results = [
      result('a', 1, [finding(17)], { seconds: 4 }),
      result('b', 1, [], { error: 'agent answered 503', seconds: 900 }),
    ];

    expect(scoreRun(1, results, fixtures, 'kept')).toMatchObject({
      recall: 0.5,
      errors: 1,
      meanSeconds: 4,
    });
  });

  it('a failed review of a clean fixture is not a clean review: it leaves false positives alone', () => {
    const results = [
      result('c', 1, [finding(5), finding(6)]),
      result('d', 1, [], { error: 'timeout' }),
    ];

    expect(scoreRun(1, results, fixtures, 'kept')).toMatchObject({
      fpPerClean: 2,
      cleanFixtures: 1,
    });
  });

  it('says nothing, rather than 0 or 100%, where there is nothing to divide by', () => {
    expect(scoreRun(1, [result('a', 1, [])], fixtures, 'kept')).toMatchObject({
      recall: 0,
      precision: null,
      fpPerClean: null,
    });
  });

  it('only scores the fixtures it is given — one split', () => {
    const tune = new Map([['a', fixtures.get('a')!]]);

    expect(
      scoreRun(
        1,
        [result('a', 1, [finding(17)]), result('b', 1, [])],
        tune,
        'kept',
      ).recall,
    ).toBe(1);
  });
});

describe('spread', () => {
  it('is the mean with the range, over the runs that have a number', () => {
    expect(spread([0.5, 0.25, null, 0.75])).toEqual({
      mean: 0.5,
      min: 0.25,
      max: 0.75,
      runs: 3,
    });
  });

  it('is null with no number at all', () => {
    expect(spread([null, null])).toBeNull();
  });
});
