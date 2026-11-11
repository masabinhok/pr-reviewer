import { createHash } from 'node:crypto';
import type { FixtureResult } from './score.js';

/**
 * Everything in the repository that shapes the reviewer's answers on a fixture: the model and
 * its settings, the prompts, the tools, the second look, how settings become the agent's
 * configuration, and the API's validation. The posting bar is stamped as a value, not a file.
 *
 * Not here: what only moves code around a review (the snapshot, HTTP, the queue, the
 * database), and the diff parsing and filtering — a fixture's request is already parsed and
 * filtered. Adding a file here changes the stamp, so the next change to it needs a fresh run.
 */
export const STAMPED = [
  'apps/agent/ollama/Modelfile',
  'apps/agent/src/pr_agent/agent/graph.py',
  'apps/agent/src/pr_agent/agent/prompt.py',
  'apps/agent/src/pr_agent/agent/submit.py',
  'apps/agent/src/pr_agent/agent/verify.py',
  'apps/agent/src/pr_agent/config.py',
  'apps/agent/src/pr_agent/main.py',
  'apps/agent/src/pr_agent/repo/tools.py',
  'apps/api/src/reviewer/validate-findings.ts',
] as const;

/**
 * The stamp (docs/journal/week9-10.md, trap 1): a hash of the stamped files and the posting bar. A run
 * records it; CI recomputes it from the committed files and asks for a run that carries it.
 */
export function evalStamp(read: (path: string) => string, bar: string): string {
  const hash = createHash('sha256');
  for (const path of [...STAMPED].sort()) hash.update(`${path}\0${read(path)}\0`);
  hash.update(`posting bar\0${bar}`);
  return hash.digest('hex').slice(0, 16);
}

/** A run's directory, as the check sees it. */
export interface RunOnDisk {
  dir: string;
  meta: { stamp?: string; runs: number; fixtures: string[] };
  results: Pick<FixtureResult, 'fixture' | 'run'>[];
}

/** Fewer runs than this say too little about a noisy model (trap 2) to vouch for a change. */
export const MIN_RUNS = 3;

/** Why a run can't vouch for the current reviewer; null when it can. */
export function runProblem(run: RunOnDisk, stamp: string, fixtures: string[]): string | null {
  if (run.meta.stamp !== stamp) return `made with stamp ${run.meta.stamp ?? '(none)'}`;
  if (run.meta.runs < MIN_RUNS) return `${run.meta.runs} run(s), fewer than ${MIN_RUNS}`;
  const missing = fixtures.filter((f) => !run.meta.fixtures.includes(f));
  if (missing.length) return `leaves out ${missing.length} fixture(s): ${missing.slice(0, 3).join(', ')}`;
  const done = new Set(run.results.map((r) => `${r.fixture}#${r.run}`));
  const expected = run.meta.runs * run.meta.fixtures.length;
  if (done.size < expected) return `stopped after ${done.size} of ${expected} reviews`;
  return null;
}
