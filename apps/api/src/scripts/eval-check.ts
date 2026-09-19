import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import configuration from '../config/configuration.js';
import { evalStamp, runProblem, type RunOnDisk } from '../evals/stamp.js';

/**
 * CI's eval gate (week9-10.md, trap 1). CI can't run the model, so it checks that someone did:
 * the reviewer as committed — its stamp — must have a complete run in evals/runs. A change to a
 * prompt, a tool, the second look, the validation or the posting bar without a fresh run fails.
 *
 * No .env is read: the stamp is of the defaults that ship, and a run made with another posting
 * bar doesn't vouch for them.
 *
 * Usage: npm run eval:check   (prints the current stamp with --print)
 */

const ROOT = resolve(import.meta.dirname, '../../../..');

function main(): number {
  const bar = configuration().posting.minSeverity;
  const stamp = evalStamp((path) => readFileSync(join(ROOT, path), 'utf8'), bar);
  if (process.argv.includes('--print')) {
    console.log(stamp);
    return 0;
  }

  const fixtures = readdirSync(join(ROOT, 'evals/fixtures'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length));
  const runsDir = join(ROOT, 'evals/runs');
  const runs: RunOnDisk[] = (existsSync(runsDir) ? readdirSync(runsDir) : [])
    .filter((d) => existsSync(join(runsDir, d, 'meta.json')))
    .map((d) => ({
      dir: d,
      meta: JSON.parse(readFileSync(join(runsDir, d, 'meta.json'), 'utf8')) as RunOnDisk['meta'],
      results: existsSync(join(runsDir, d, 'results.jsonl'))
        ? readFileSync(join(runsDir, d, 'results.jsonl'), 'utf8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l) as RunOnDisk['results'][number])
        : [],
    }));

  const vouching = runs.find((r) => runProblem(r, stamp, fixtures) === null);
  if (vouching) {
    console.log(`eval stamp ${stamp}: evaluated in evals/runs/${vouching.dir}`);
    return 0;
  }

  console.error(`eval stamp ${stamp}: the reviewer has changed since its last full evaluation.`);
  for (const r of runs) console.error(`  evals/runs/${r.dir}: ${runProblem(r, stamp, fixtures)}`);
  console.error(
    '\nRun the evaluation and commit its directory:\n' +
      '  npm run agent:eval                  # from the repository root\n' +
      '  cd apps/api && npm run eval         # then git add evals/runs/<the new run>\n' +
      'See evals/README.md.',
  );
  return 1;
}

process.exitCode = main();
