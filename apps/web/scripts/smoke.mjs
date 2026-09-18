/**
 * Smoke test for the built dashboard: start a fake dashboard API, start `next start` against
 * it, fetch every page and check each shows what it should — then the same with the API down,
 * where every page must say what's wrong and how to fix it instead of failing.
 *
 * Usage: npm run build && npm run test:smoke
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';

const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');

const TOKEN = 'smoke-token';
const API_PORT = 4311;
const WEB_PORT = 4312;
const now = new Date();
const hoursAgo = (h) => new Date(now.getTime() - h * 3_600_000).toISOString();
const day = (d) => new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);

const review = {
  id: 'rev-33', repo: 'masabinhok/pr-reviewer', prNumber: 33, prUrl: 'https://github.com/masabinhok/pr-reviewer/pull/33',
  headSha: '5b4152a0000000000000000000000000000000ab', status: 'COMPLETED', startedAt: hoursAgo(3), completedAt: hoursAgo(2.96),
  seconds: 139, error: null, skipReason: null, model: 'pr-reviewer:qwen2.5-7b', outcome: 'submitted', turns: 6, toolCalls: 4,
  verifyCalls: 3, tokensIn: 73714, tokensOut: 2730, costUsd: 0, findings: 3, posted: 1, droppedOnSecondLook: 1,
};
const data = {
  '/overview': {
    reviews: { total: 24, completed: 20, failed: 3, skipped: 1, inProgress: 0 },
    findings: { total: 35, bySeverity: { high: 10, medium: 6, low: 19 }, posted: 13, repeats: 1, resolved: { byApp: 1, byPerson: 0 }, verdicts: { confirmed: 5, unsure: 0, unverified: 0 }, droppedOnSecondLook: 6 },
    feedback: { posted: 13, withFeedback: 3, upvoted: 0, downvoted: 3 },
    agent: { reviews: 13, averageSeconds: 60, averageTurns: 3.8, tokensIn: 358841, tokensOut: 18603, costUsd: 0 },
    perDay: Array.from({ length: 30 }, (_, i) => ({ day: day(29 - i), reviews: i % 4, findings: i % 5, posted: i % 2 })),
  },
  '/installations': [
    { id: 'i1', githubId: '160831076', account: 'masabinhok', accountType: 'User', suspendedAt: null, deletedAt: null,
      repos: [{ id: 'r1', fullName: 'masabinhok/pr-reviewer', private: false, deletedAt: null, reviews: 6, lastReviewAt: hoursAgo(3) }] },
  ],
  '/reviews': { items: [review], nextCursor: null },
  '/reviews/rev-33': {
    ...review, baseSha: 'b'.repeat(40), checkRunUrl: 'https://github.com/masabinhok/pr-reviewer/runs/1',
    findings: [
      { id: 'f1', path: 'apps/api/src/config/configuration.ts', line: 3, side: 'RIGHT', severity: 'HIGH', category: 'correctness',
        summary: 'POST_MIN_SEVERITY is not validated.', whyItBreaks: 'A typo fails silently.', suggestedFix: null, verdict: 'CONFIRMED',
        verdictReason: 'Line 3 reads it raw.', demotedFrom: null, status: 'OPEN', resolvedBy: null, resolvedAt: null, posted: true,
        commentUrl: 'https://github.com/masabinhok/pr-reviewer/pull/33#discussion_r3999465159', repeatOf: null, feedback: { up: 0, down: 1 } },
      { id: 'f2', path: 'README.md', line: 12, side: 'RIGHT', severity: 'LOW', category: 'docs', summary: 'Severity is not stated.',
        whyItBreaks: 'It is unclear.', suggestedFix: null, verdict: 'UNSURE', verdictReason: 'Cannot tell.', demotedFrom: 'MEDIUM',
        status: 'OPEN', resolvedBy: null, resolvedAt: null, posted: false, commentUrl: null, repeatOf: null, feedback: { up: 0, down: 0 } },
    ],
    dropped: [{ path: 'apps/api/src/reviews/check-summary.ts', line: 95, severity: 'high', summary: 'Low bar mishandled.', reason: 'Nothing is below a low bar.' }],
  },
};

const api = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
  const path = new URL(req.url, 'http://x').pathname.replace('/api/dashboard', '');
  const body = data[path];
  res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(body ?? { message: 'Not Found' }));
});

const withApi = [
  ['/', ['How the reviewer is doing', 'Where findings go', '41', 'Refuted', 'Marked wrong', 'Reviews per day', 'What people thought']],
  ['/reviews', ['masabinhok/pr-reviewer #33', '5b4152a', 'Reviewed']],
  ['/reviews/rev-33', ['masabinhok/pr-reviewer #33', 'Posted on the pull request (1)', 'POST_MIN_SEVERITY is not validated.', 'Confirmed', '👎 1', 'was medium', 'Refuted by the second look (1)', 'Nothing is below a low bar.']],
  ['/installations', ['masabinhok', 'masabinhok/pr-reviewer', '6']],
];

let failures = 0;
const fail = (msg) => { failures++; console.error(`  FAIL ${msg}`); };

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(url); return; } catch { await sleep(200); }
  }
  throw new Error(`${url} never came up`);
}

async function check(label, pages) {
  console.log(label);
  for (const [path, expected] of pages) {
    const res = await fetch(`http://localhost:${WEB_PORT}${path}`);
    // React separates adjacent text with <!-- --> markers; read the page as a person would.
    const html = (await res.text()).replaceAll('<!-- -->', '');
    if (res.status !== 200) fail(`${path}: status ${res.status}`);
    for (const text of expected) if (!html.includes(text)) fail(`${path}: missing ${JSON.stringify(text)}`);
    console.log(`  ${path} ${res.status}`);
  }
}

await new Promise((r) => api.listen(API_PORT, r));
const web = spawn(process.execPath, [nextBin, 'start', '--port', String(WEB_PORT)], {
  env: { ...process.env, DASHBOARD_API_URL: `http://localhost:${API_PORT}`, DASHBOARD_TOKEN: TOKEN },
  stdio: ['ignore', 'ignore', 'inherit'],
});
try {
  await waitFor(`http://localhost:${WEB_PORT}/`);
  await check('with the API up', withApi);

  const missing = await fetch(`http://localhost:${WEB_PORT}/reviews/nope`);
  if (missing.status !== 404) fail(`/reviews/nope: status ${missing.status}, expected 404`);
  else console.log('  /reviews/nope 404');

  await new Promise((r) => api.close(r));
  await check('with the API down', withApi.map(([path]) => [path.startsWith('/reviews/') ? '/reviews' : path, ['is not answering', 'npm run start:dev']]));
} finally {
  web.kill();
  api.close();
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall pages render');
