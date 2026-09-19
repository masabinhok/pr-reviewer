import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixtureProblems, type Fixture } from './fixture.js';

const DIR = fileURLToPath(new URL('../../../../evals/fixtures/', import.meta.url));
const committed = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((name) => ({ name, fixture: JSON.parse(readFileSync(`${DIR}${name}`, 'utf8')) as Fixture }));

const SHA = (c: string) => c.repeat(40);

function sound(): Fixture {
  return {
    id: 'example',
    kind: 'bug',
    split: 'tune',
    source: { repo: 'o/r', commit: SHA('f'), url: 'https://github.com/o/r/commit/f', message: 'Fix x' },
    reviewed: { base: SHA('f'), head: SHA('a') },
    request: {
      repo: 'o/r',
      prNumber: 1,
      title: 'Update a.ts',
      body: '',
      baseSha: SHA('f'),
      headSha: SHA('a'),
      files: [
        {
          path: 'a.ts',
          oldPath: 'a.ts',
          status: 'modified',
          binary: false,
          hunks: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, section: '', lines: [] }],
        },
      ],
    },
    bugs: [{ file: 'a.ts', head: [11, 11], base: [11, 11], description: 'x breaks for empty input.' }],
    notes: 'Reversed from o/r@fffffff.',
  };
}

describe('fixtureProblems', () => {
  it('passes a sound fixture', () => {
    expect(fixtureProblems(sound(), 'example.json')).toEqual([]);
  });

  it.each<[string, (f: Fixture) => void, string]>([
    ['an undescribed bug', (f) => (f.bugs[0].description = 'TODO: what goes wrong'), 'is not described'],
    ['a bug outside the diff', (f) => (f.bugs[0].head = f.bugs[0].base = [40, 41]), 'outside every hunk'],
    ['a bug in a file not reviewed', (f) => (f.bugs[0].file = 'b.ts'), 'not in the diff'],
    ['a second place outside the diff', (f) => (f.bugs[0].alsoAt = [{ file: 'a.ts', head: [90, 90], base: [90, 90] }]), 'outside every hunk'],
    ['a clean fixture with bugs', (f) => (f.kind = 'clean'), 'a clean fixture has bugs'],
    ['a bug fixture with none', (f) => (f.bugs = []), 'has no bugs'],
    ['no notes', (f) => (f.notes = ''), 'no notes'],
    ['a request for other commits', (f) => (f.request.headSha = SHA('b')), 'does not review the recorded commits'],
    ['a short SHA', (f) => (f.source.commit = 'fffffff'), 'provenance is incomplete'],
    ['an unknown split', (f) => (f.split = 'test' as never), 'split is test'],
  ])('reports %s', (_what, spoil, message) => {
    const f = sound();
    spoil(f);

    expect(fixtureProblems(f).join('\n')).toContain(message);
  });

  it('reports a file whose name is not its id', () => {
    expect(fixtureProblems(sound(), 'other.json')).toEqual([expect.stringContaining('does not match the file name')]);
  });
});

describe('the committed fixtures (evals/fixtures)', () => {
  it('are all sound', () => {
    expect(committed.flatMap(({ name, fixture }) => fixtureProblems(fixture, name))).toEqual([]);
  });

  it('are about 20 with bugs and about 10 clean', () => {
    const bugs = committed.filter((c) => c.fixture.kind === 'bug').length;
    const clean = committed.filter((c) => c.fixture.kind === 'clean').length;

    expect(bugs).toBeGreaterThanOrEqual(18);
    expect(clean).toBeGreaterThanOrEqual(8);
  });

  // The held-out set decides, so it has to be able to measure both numbers.
  it('hold out both kinds, and a fair share of each', () => {
    const heldOut = committed.filter((c) => c.fixture.split === 'heldout').map((c) => c.fixture);

    expect(heldOut.some((f) => f.kind === 'bug')).toBe(true);
    expect(heldOut.some((f) => f.kind === 'clean')).toBe(true);
    expect(heldOut.length / committed.length).toBeGreaterThan(0.25);
  });

  it('carry no installation token', () => {
    expect(committed.filter(({ fixture }) => 'installationToken' in fixture.request)).toEqual([]);
  });
});
