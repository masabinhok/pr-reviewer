import { config as loadEnv } from 'dotenv';

loadEnv({ path: '../../.env', quiet: true });

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import configuration from '../config/configuration.js';
import { AppJwtService } from '../github/app-jwt.service.js';
import { InstallationTokenService } from '../github/installation-token.service.js';
import { RedisService } from '../redis/redis.service.js';
import { AgentReviewer } from '../reviewer/agent-reviewer.js';
import { meetsPostingBar } from '../reviews/review-publisher.js';
import type { Severity } from '../generated/prisma/client.js';
import { fixtureProblems, type Fixture } from '../evals/fixture.js';
import { renderReport, type RunMeta } from '../evals/report.js';
import { reviewFixture } from '../evals/review-fixture.js';
import { evalStamp } from '../evals/stamp.js';
import type { FixtureResult, Judgments } from '../evals/score.js';

/**
 * The evaluation (docs/journal/week9-10.md, milestone 31): every fixture reviewed by the running agent,
 * through the API's own reviewer client, validation and posting bar, several times over; the
 * results written as they come, and a report at the end.
 *
 *   npm run eval                          3 runs of every fixture, into evals/runs/<time>/
 *   npm run eval -- --runs 1 --only a,b   fewer: to try a change on a few fixtures first
 *   npm run eval -- --split tune          only the tuning fixtures (while changing the reviewer)
 *   npm run eval -- --resume <dir>        carry on a stopped run where it stopped
 *   npm run eval -- --report <dir>        rewrite a run's report — after judging its matches, say
 *   npm run eval -- --rescore <dir> --bar medium
 *                                         score a finished run at another posting bar, into a new
 *                                         run directory. The bar applies after the model answers,
 *                                         so this needs no GPU: same findings, different comments.
 *   --note "<text>"                       how this run was made, where the stamp can't tell —
 *                                         e.g. "agent started with AGENT_VERIFY=false"
 *   --show-heldout                        list held-out fixtures one by one in the report
 *
 * The agent must be running (`npm run agent`, from the repository root) with Ollama up; which
 * model it uses is its own setting. Nothing here touches Postgres. Redis only when a fixture's
 * repository is private and the App is installed on it (the testbed) — for its token.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const FIXTURES = join(ROOT, 'evals/fixtures');
const RUNS = join(ROOT, 'evals/runs');

/** Consecutive failed reviews after which the run stops: the agent or Ollama is down. */
const GIVE_UP_AFTER = 3;

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

function loadFixtures(): Fixture[] {
  const fixtures = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((name) => ({
      name,
      fixture: JSON.parse(
        readFileSync(join(FIXTURES, name), 'utf8'),
      ) as Fixture,
    }));
  const problems = fixtures.flatMap(({ name, fixture }) =>
    fixtureProblems(fixture, name),
  );
  if (problems.length)
    throw new Error(`unsound fixtures:\n${problems.join('\n')}`);
  return fixtures.map((f) => f.fixture);
}

function readResults(dir: string): FixtureResult[] {
  const path = join(dir, 'results.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FixtureResult);
}

function writeReport(
  dir: string,
  fixtures: Fixture[],
  showHeldout: boolean,
): string {
  const meta = JSON.parse(
    readFileSync(join(dir, 'meta.json'), 'utf8'),
  ) as RunMeta;
  const judgmentsPath = join(dir, 'judgments.json');
  const judgments = existsSync(judgmentsPath)
    ? (JSON.parse(readFileSync(judgmentsPath, 'utf8')) as Judgments)
    : {};
  const report = renderReport(meta, readResults(dir), fixtures, {
    judgments,
    showHeldout,
  });
  writeFileSync(join(dir, 'report.md'), report);
  return report;
}

const git = (...a: string[]) =>
  execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

/**
 * Whether a repository needs a token, asked of GitHub once per repository: the App installed
 * on it means private code to read with that installation's token; anything else is read as
 * public, without one.
 */
function installations(config: ConfigService) {
  const known = new Map<string, bigint | null>();
  const jwt =
    config.get<string>('github.appId') &&
    config.get<string>('github.privateKeyBase64')
      ? new AppJwtService(config)
      : null;
  return async (repo: string): Promise<bigint | null> => {
    if (known.has(repo)) return known.get(repo)!;
    let id: bigint | null = null;
    if (jwt) {
      const response = await fetch(
        `https://api.github.com/repos/${repo}/installation`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${jwt.mint()}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'pr-reviewer-eval',
          },
        },
      );
      if (response.ok)
        id = BigInt(((await response.json()) as { id: number }).id);
    }
    known.set(repo, id);
    return id;
  };
}

/**
 * A finished run scored again at another posting bar, in a new directory. Only the posting
 * decision changes — every finding, and how long it took, is the earlier run's — so `meta` says
 * which run it came from and the report repeats it.
 */
function rescore(from: string, bar: Severity): string {
  const source = JSON.parse(
    readFileSync(join(from, 'meta.json'), 'utf8'),
  ) as RunMeta;
  if (source.bar === bar)
    throw new Error(`${basename(from)} is already at bar ${bar.toLowerCase()}`);
  const started = new Date().toISOString();
  const dir = join(
    RUNS,
    `${started.slice(0, 19).replaceAll(':', '')}-${bar.toLowerCase()}`,
  );
  mkdirSync(dir, { recursive: true });

  const meta: RunMeta = {
    ...source,
    started,
    bar,
    stamp: evalStamp((path) => readFileSync(join(ROOT, path), 'utf8'), bar),
    rescoredFrom: basename(from),
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  // The production rule, not a copy of it: the same function the publisher uses.
  const results = readResults(from).map((r) => ({
    ...r,
    findings: r.findings.map((f) => ({
      ...f,
      posted: meetsPostingBar(f.severity, bar),
    })),
  }));
  writeFileSync(
    join(dir, 'results.jsonl'),
    results.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  const judgments = join(from, 'judgments.json');
  // The judgments are of findings, not of the bar: they carry over unchanged.
  if (existsSync(judgments))
    writeFileSync(join(dir, 'judgments.json'), readFileSync(judgments));
  return dir;
}

async function main() {
  const a = args();
  const fixtures = loadFixtures();
  const showHeldout = a['show-heldout'] === true;

  if (typeof a.report === 'string') {
    console.log(writeReport(resolve(a.report), fixtures, showHeldout));
    return;
  }

  // The reviewer client logs each answer's finding count — for held-out fixtures too, which
  // must not be watched (trap 3). Its warnings and errors still show.
  Logger.overrideLogger(['warn', 'error']);
  const config = new ConfigService(configuration());
  const bar = (
    typeof a.bar === 'string'
      ? a.bar.toUpperCase()
      : config.getOrThrow<Severity>('posting.minSeverity')
  ) as Severity;
  if (!['HIGH', 'MEDIUM', 'LOW'].includes(bar))
    throw new Error(`--bar must be high, medium or low; got ${a.bar}`);

  if (typeof a.rescore === 'string') {
    console.log(
      writeReport(rescore(resolve(a.rescore), bar), fixtures, showHeldout),
    );
    return;
  }

  let dir: string;
  let meta: RunMeta;
  if (typeof a.resume === 'string') {
    dir = resolve(a.resume);
    meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as RunMeta;
  } else {
    const runs = Number(a.runs ?? 3);
    if (!Number.isInteger(runs) || runs < 1)
      throw new Error('--runs must be a whole number, 1 or more');
    const only = typeof a.only === 'string' ? a.only.split(',') : null;
    const split = typeof a.split === 'string' ? a.split : null;
    const chosen = fixtures.filter(
      (f) => (!only || only.includes(f.id)) && (!split || f.split === split),
    );
    if (chosen.length === 0)
      throw new Error('no fixture matches --only / --split');
    const started = new Date().toISOString();
    dir = join(RUNS, started.slice(0, 19).replaceAll(':', ''));
    meta = {
      started,
      commit: git('rev-parse', 'HEAD'),
      dirty:
        git('status', '--porcelain', '--untracked-files=no', '--', 'apps')
          .length > 0,
      // Of the files as they are on disk now — what the agent, restarted since any change, runs.
      stamp: evalStamp((path) => readFileSync(join(ROOT, path), 'utf8'), bar),
      runs,
      bar,
      fixtures: chosen.map((f) => f.id),
      ...(typeof a.note === 'string' ? { note: a.note } : {}),
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  }

  // The agent is asked by the API's own client. Its token service is only built if a fixture
  // needs one — which connects to Redis.
  let redis: RedisService | null = null;
  let tokens: InstallationTokenService | null = null;
  const tokenService = {
    getToken: (id: bigint) => {
      tokens ??= new InstallationTokenService(
        new AppJwtService(config),
        (redis = new RedisService()),
      );
      return tokens.getToken(id);
    },
  } as InstallationTokenService;
  const reviewer = new AgentReviewer(config, tokenService);
  const installationOf = installations(config);

  const agent = config.getOrThrow<string>('agent.url');
  await fetch(`${agent}/healthz`).catch(() => {
    throw new Error(
      `the agent is not answering at ${agent} — start it with \`npm run agent\``,
    );
  });

  const done = new Set(readResults(dir).map((r) => `${r.fixture}#${r.run}`));
  const todo = meta.fixtures
    .map((id) => fixtures.find((f) => f.id === id))
    .filter((f): f is Fixture => f !== undefined);
  const total = meta.runs * todo.length;
  console.log(
    `${basename(dir)}: ${meta.runs} run(s) × ${todo.length} fixture(s), posting bar ${bar.toLowerCase()}, ${done.size} already done`,
  );

  let failedInARow = 0;
  let n = done.size;
  try {
    for (let run = 1; run <= meta.runs; run++) {
      for (const fixture of todo) {
        if (done.has(`${fixture.id}#${run}`)) continue;
        const installationId = await installationOf(fixture.request.repo);
        const result = await reviewFixture(reviewer, fixture, run, {
          bar,
          installationId,
        });
        // One line per review, as it finishes: a stopped run keeps everything it did.
        appendFileSync(
          join(dir, 'results.jsonl'),
          JSON.stringify(result) + '\n',
        );
        n += 1;

        const what = result.error
          ? `failed: ${result.error}`
          : `${result.findings.length} kept, ${result.findings.filter((f) => f.posted).length} posted, ${result.refuted} refuted`;
        // Held-out fixtures are run, not watched: their outcome would tempt tuning (trap 3).
        const shown =
          fixture.split === 'heldout' && !showHeldout && !result.error
            ? 'done'
            : what;
        console.log(
          `[${n}/${total}] run ${run} ${fixture.id} (${result.seconds.toFixed(0)}s): ${shown}`,
        );

        failedInARow = result.error ? failedInARow + 1 : 0;
        if (failedInARow >= GIVE_UP_AFTER) {
          throw new Error(
            `${GIVE_UP_AFTER} reviews failed in a row — is the agent up, and Ollama? Carry on with --resume ${dir}`,
          );
        }
      }
    }
  } finally {
    writeReport(dir, fixtures, showHeldout);
    await (redis as RedisService | null)?.quit();
  }
  console.log(`\nwrote ${join(dir, 'report.md')}`);
}

await main();
