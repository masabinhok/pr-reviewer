import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  evalStamp,
  MIN_RUNS,
  runProblem,
  STAMPED,
  type RunOnDisk,
} from './stamp.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const files: Record<string, string> = Object.fromEntries(
  STAMPED.map((p) => [p, `contents of ${p}`]),
);

describe('evalStamp', () => {
  it('every stamped file exists: a rename must not quietly drop one from the stamp', () => {
    for (const path of STAMPED)
      expect(existsSync(ROOT + path), path).toBe(true);
  });

  it('is the same for the same files and bar', () => {
    expect(evalStamp((p) => files[p], 'HIGH')).toBe(
      evalStamp((p) => files[p], 'HIGH'),
    );
    expect(evalStamp((p) => readFileSync(ROOT + p, 'utf8'), 'HIGH')).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });

  it('changes when any stamped file does — one character of the prompt', () => {
    const before = evalStamp((p) => files[p], 'HIGH');
    for (const path of STAMPED) {
      expect(
        evalStamp((p) => (p === path ? files[p] + ' ' : files[p]), 'HIGH'),
        path,
      ).not.toBe(before);
    }
  });

  it('changes with the posting bar', () => {
    expect(evalStamp((p) => files[p], 'MEDIUM')).not.toBe(
      evalStamp((p) => files[p], 'HIGH'),
    );
  });
});

describe('runProblem: whether a run vouches for the reviewer', () => {
  const fixtures = ['a', 'b'];
  const complete = (): RunOnDisk => ({
    dir: 'r',
    meta: { stamp: 's1', runs: MIN_RUNS, fixtures },
    results: [1, 2, 3].flatMap((run) =>
      fixtures.map((fixture) => ({ fixture, run })),
    ),
  });

  it('a complete run with the current stamp does', () => {
    expect(runProblem(complete(), 's1', fixtures)).toBeNull();
  });

  it('one made before the change does not', () => {
    expect(runProblem(complete(), 's2', fixtures)).toBe('made with stamp s1');
  });

  it('nor one of a single run, a few fixtures, or one that stopped halfway', () => {
    const few = complete();
    few.meta.runs = 1;
    expect(runProblem(few, 's1', fixtures)).toBe('1 run(s), fewer than 3');

    const some = complete();
    some.meta.fixtures = ['a'];
    expect(runProblem(some, 's1', fixtures)).toBe('leaves out 1 fixture(s): b');

    const stopped = complete();
    stopped.results.pop();
    expect(runProblem(stopped, 's1', fixtures)).toBe(
      'stopped after 5 of 6 reviews',
    );
  });

  it('a run that predates the stamp does not', () => {
    const old = complete();
    delete old.meta.stamp;
    expect(runProblem(old, 's1', fixtures)).toBe('made with stamp (none)');
  });
});
