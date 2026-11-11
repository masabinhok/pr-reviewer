import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureProblems } from '../evals/fixture.js';
import { buildFixture, commitsToReview } from '../evals/build-fixture.js';

/**
 * Makes an evaluation fixture from a real commit in a public repository.
 *
 *   --kind bug    the commit is a bug fix; the fixture reviews its reversal — from the fixed
 *                 code back to the code before the fix — and drafts the answer key from the
 *                 lines the fix changed, for a person to check and describe.
 *   --kind clean  the commit is a change believed to need no fix; reviewed as it was.
 *
 * Only source files are kept: tests, docs and changelogs in a fix would hand the reviewer the
 * answer. The diff comes from git itself (a shallow fetch of the commit and its parent), then
 * goes through the API's own parser and filters, as a real review's would.
 *
 * Usage: npm run eval:fixture -- --repo owner/name --commit <sha> --kind bug|clean --id <id> --split tune|heldout [--force]
 */

const EVALS = resolve(import.meta.dirname, '../../../../evals/fixtures');

function args(): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd();

function main() {
  const a = args();
  const repo = String(a.repo ?? '');
  const commit = String(a.commit ?? '');
  const kind = a.kind === 'clean' ? 'clean' : a.kind === 'bug' ? 'bug' : null;
  const id = String(a.id ?? '');
  const split =
    a.split === 'heldout' ? 'heldout' : a.split === 'tune' ? 'tune' : null;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    !/^[0-9a-f]{7,40}$/.test(commit) ||
    !kind ||
    !/^[a-z0-9-]+$/.test(id) ||
    !split
  ) {
    throw new Error(
      'usage: --repo owner/name --commit <sha> --kind bug|clean --id <kebab-id> --split tune|heldout [--force]',
    );
  }
  const out = join(EVALS, `${id}.json`);
  if (existsSync(out) && !a.force)
    throw new Error(
      `${out} exists — its key may be hand-edited; pass --force to replace it`,
    );

  // git fetches by full SHA only; ask GitHub for it when given a short one.
  const full =
    commit.length === 40
      ? commit
      : execFileSync(
          'gh',
          ['api', `repos/${repo}/commits/${commit}`, '--jq', '.sha'],
          { encoding: 'utf8' },
        ).trim();

  const dir = mkdtempSync(join(tmpdir(), 'eval-fixture-'));
  try {
    git(dir, 'init', '-q');
    git(
      dir,
      'fetch',
      '-q',
      '--depth=2',
      `https://github.com/${repo}.git`,
      full,
    );
    const [sha, ...parents] = git(
      dir,
      'rev-list',
      '--parents',
      '-n1',
      'FETCH_HEAD',
    ).split(' ');
    if (parents.length !== 1)
      throw new Error(
        `${sha} has ${parents.length} parents; use a commit with exactly one`,
      );
    const parent = parents[0];
    const message = git(dir, 'log', '-1', '--format=%s', sha);

    const { base, head } = commitsToReview(kind, sha, parent);
    const fixture = buildFixture({
      id,
      kind,
      split,
      repo,
      commit: sha,
      parent,
      message,
      diff: git(dir, 'diff', '--no-color', '--no-ext-diff', '-M', base, head),
    });
    const kept = fixture.request.files;

    mkdirSync(EVALS, { recursive: true });
    writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);

    console.log(`wrote ${out}`);
    console.log(`${kind} · ${repo}@${sha.slice(0, 7)} "${message}"`);
    console.log(
      `reviews ${base.slice(0, 7)} → ${head.slice(0, 7)}: ${kept.length} source file(s) kept`,
    );
    for (const f of kept) {
      console.log(`\n=== ${f.path}`);
      for (const h of f.hunks) {
        console.log(
          `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${h.section}`,
        );
        for (const l of h.lines)
          console.log(
            `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${String(l.newLine ?? l.oldLine).padStart(4)} ${l.content}`,
          );
      }
    }
    const problems = fixtureProblems(fixture);
    console.log(
      `\nstill to do before it validates: ${problems.length ? `\n  ${problems.join('\n  ')}` : 'nothing'}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
