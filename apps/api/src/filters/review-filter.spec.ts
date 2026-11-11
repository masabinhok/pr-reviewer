import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FILTER_CONFIG,
  filterDiffFiles,
  filterFileList,
  type ChangedFile,
  type FilterConfig,
} from './review-filter.js';
import { parseDiff } from '../diff/parse-diff.js';

const changed = (
  filename: string,
  status = 'modified',
  additions = 1,
  deletions = 0,
): ChangedFile => ({
  filename,
  status,
  additions,
  deletions,
});

const reasonFor = (path: string) =>
  filterFileList([changed(path)]).skipped[0]?.reason;

describe('filterFileList — stage one, by path', () => {
  it.each([
    ['package-lock.json', 'lockfile'],
    ['apps/web/pnpm-lock.yaml', 'lockfile'],
    ['yarn.lock', 'lockfile'],
    ['bun.lockb', 'lockfile'],
    ['Cargo.lock', 'lockfile'],
    ['poetry.lock', 'lockfile'],
    ['services/api/go.sum', 'lockfile'],
    ['composer.lock', 'lockfile'],
    ['Gemfile.lock', 'lockfile'],
    ['public/app.min.js', 'generated'],
    ['public/app.min.css', 'generated'],
    ['public/app.js.map', 'generated'],
    ['dist/index.js', 'generated'],
    ['packages/ui/build/button.js', 'generated'],
    ['src/__generated__/schema.ts', 'generated'],
    ['src/api.generated.ts', 'generated'],
    ['proto/user.pb.go', 'generated'],
    ['vendor/github.com/pkg/errors/errors.go', 'vendored'],
    ['node_modules/left-pad/index.js', 'vendored'],
    ['third_party/zlib/zlib.h', 'vendored'],
  ])('skips %s as %s', (path, reason) => {
    expect(reasonFor(path)).toBe(reason);
  });

  // The rules match whole names and whole directories, not substrings of either.
  it.each([
    'src/auth.ts',
    'src/lockfile.ts',
    'src/package-lock.json.ts',
    'docs/building.md',
    'src/distance.ts',
    'src/vendors.ts',
    'README.md',
    'src/min.js',
  ])('keeps %s', (path) => {
    expect(reasonFor(path)).toBeUndefined();
  });

  it('skips a removed file — nothing left to review', () => {
    expect(
      filterFileList([changed('src/old.ts', 'removed', 0, 40)]).skipped,
    ).toEqual([{ path: 'src/old.ts', reason: 'removed' }]);
  });

  it('keeps the files that survive, in order, with their original shape', () => {
    const files = [
      changed('src/a.ts'),
      changed('yarn.lock'),
      changed('src/b.ts'),
    ];

    const { kept, skipped } = filterFileList(files);

    expect(kept).toEqual([files[0], files[2]]);
    expect(skipped).toEqual([{ path: 'yarn.lock', reason: 'lockfile' }]);
  });
});

describe('filterFileList — PR-level limits', () => {
  const many = (n: number, lines = 1) =>
    Array.from({ length: n }, (_, i) =>
      changed(`src/f${i}.ts`, 'modified', lines, 0),
    );

  it('reviews a PR exactly at the file limit', () => {
    expect(filterFileList(many(50)).tooLarge).toBeUndefined();
  });

  it('refuses a PR one file over it', () => {
    expect(filterFileList(many(51)).tooLarge).toBe(
      '51 files to review, over the limit of 50',
    );
  });

  it('refuses a PR over the changed-line limit', () => {
    expect(filterFileList(many(3, 700)).tooLarge).toBe(
      '2100 changed lines to review, over the limit of 2000',
    );
  });

  // Limits count what would actually be reviewed: a 10,000-line lockfile bump alongside
  // a small fix is a small PR.
  it('applies the limits after per-file filtering', () => {
    const files = [
      changed('package-lock.json', 'modified', 9000, 1000),
      ...many(40, 10),
    ];

    expect(filterFileList(files).tooLarge).toBeUndefined();
  });

  it('takes its limits and rules from the config it is given', () => {
    const strict: FilterConfig = { ...DEFAULT_FILTER_CONFIG, maxFiles: 2 };

    expect(filterFileList(many(3), strict).tooLarge).toBe(
      '3 files to review, over the limit of 2',
    );
  });
});

describe('filterDiffFiles — stage two, on the parsed diff', () => {
  const diff = readFileSync(
    fileURLToPath(
      new URL('../../test/fixtures/diffs/diff-shapes.diff', import.meta.url),
    ),
    'utf8',
  );
  const parsed = parseDiff(diff);

  it('keeps only files with lines to review, naming why each other one was dropped', () => {
    // Everything that stage one would let through for the testbed PR.
    const survivors = new Set([
      'assets/logo.png',
      'docs/new name.md',
      'src/auth.ts',
      'src/config.ts',
      'src/helpers.ts',
      'src/new-feature.ts',
    ]);

    const { kept, skipped } = filterDiffFiles(parsed, survivors);

    expect(kept.map((f) => f.path)).toEqual([
      'src/auth.ts',
      'src/helpers.ts',
      'src/new-feature.ts',
    ]);
    expect(skipped).toEqual([
      { path: 'assets/logo.png', reason: 'binary' },
      { path: 'docs/new name.md', reason: 'no-changes' }, // pure rename
      { path: 'src/config.ts', reason: 'no-changes' }, // mode only
    ]);
  });

  it('ignores files stage one already dropped', () => {
    const { kept, skipped } = filterDiffFiles(parsed, new Set(['src/auth.ts']));

    expect(kept.map((f) => f.path)).toEqual(['src/auth.ts']);
    expect(skipped).toEqual([]);
  });
});
