import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ReviewStatus } from '../src/generated/prisma/client.js';
import { sign } from './helpers/sign.js';
import { fixture, fixtureJson } from './helpers/fixtures.js';
import { truncateAll } from './helpers/db.js';
import { fakeGithub } from './helpers/github-fake.js';

/**
 * The review flow with the agent in it: a signed delivery → queue → worker → pipeline →
 * AgentReviewer → the agent's HTTP boundary → validation → a posted review. GitHub is faked
 * at fetch as in review-flow.e2e-spec.ts; the agent is faked at its own URL, answering
 * with the contract's response file (contracts/review-response.json) — the same file the
 * agent's own tests generate from its models.
 */

const AGENT_URL = 'http://agent.test';
const AGENT_SECRET = 'e2e-agent-secret';

const diffs = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/diffs/${name}`, import.meta.url)), 'utf8');
const agentAnswer = readFileSync(fileURLToPath(new URL('../../../contracts/review-response.json', import.meta.url)), 'utf8');

const SYNC = fixture('pull_request.synchronize');
const sync = fixtureJson<{
  installation: { id: number };
  repository: { full_name: string };
  pull_request: { head: { sha: string } };
}>('pull_request.synchronize');

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Review flow with the agent (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let github: ReturnType<typeof fakeGithub>;
  let agentCalls: { headers: Record<string, string>; body: Record<string, unknown> }[];
  let agentReply: () => Response;

  const settledReview = () =>
    until(
      () => prisma.review.findFirst({ where: { headSha: sync.pull_request.head.sha }, include: { findings: true } }),
      (r) => r !== null && ([ReviewStatus.COMPLETED, ReviewStatus.FAILED] as ReviewStatus[]).includes(r.status),
    );

  function deliver() {
    return request(app.getHttpServer())
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', randomUUID())
      .set('X-Hub-Signature-256', sign(SYNC))
      .send(SYNC);
  }

  beforeAll(async () => {
    // Select the agent for this file only; the rest of the suite runs the stub.
    vi.stubEnv('REVIEWER', 'agent');
    vi.stubEnv('AGENT_URL', AGENT_URL);
    vi.stubEnv('AGENT_SHARED_SECRET', AGENT_SECRET);
    const { AppModule } = await import('../src/app.module.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prisma = app.get(PrismaService);

    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await app.close();
  });

  beforeEach(async () => {
    github = fakeGithub({
      pulls: {
        [`${sync.repository.full_name}#3`]: {
          files: JSON.parse(diffs('pr3-synchronize.files.json')),
          diff: diffs('pr3-synchronize.diff'),
          title: 'Diff shapes',
        },
      },
    });
    agentCalls = [];
    agentReply = () => new Response(agentAnswer, { status: 200, headers: { 'Content-Type': 'application/json' } });

    vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(AGENT_URL)) {
        agentCalls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
        return agentReply();
      }
      return github.fetch(input, init);
    });

    await truncateAll(prisma);
    await prisma.installation.create({
      data: { githubId: BigInt(sync.installation.id), accountLogin: 'masabinhok', accountType: 'User' },
    });
  });

  it('asks the agent, validates its findings, posts the ones that pass the gate', async () => {
    await deliver().expect(200);
    const review = await settledReview();

    expect(review?.status).toBe(ReviewStatus.COMPLETED);
    expect(agentCalls).toHaveLength(1);
    const [call] = agentCalls;
    expect(call.headers['X-Agent-Secret']).toBe(AGENT_SECRET);
    expect(call.body).toMatchObject({
      repo: sync.repository.full_name,
      prNumber: 3,
      headSha: sync.pull_request.head.sha,
      installationToken: `ghs_fake_${sync.installation.id}`, // minted through the fake GitHub
    });

    // The agent's three findings: high and medium are posted, low stays in the Check Run.
    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0].event).toBe('COMMENT');
    expect(github.reviews[0].comments.map((c) => [c.path, c.line])).toEqual([
      ['src/auth.ts', 26],
      ['src/new-feature.ts', 2],
    ]);
    expect(review!.findings.map((f) => f.severity).sort()).toEqual(['HIGH', 'LOW', 'MEDIUM']);
  });

  it('stores the second look’s verdicts and shows what it dropped', async () => {
    await deliver().expect(200);
    const review = await settledReview();

    const byLine = Object.fromEntries(review!.findings.map((f) => [`${f.filePath}:${f.line}`, [f.verdict, f.verdictReason]]));
    expect(byLine['src/auth.ts:26'][0]).toBe('CONFIRMED');
    expect(byLine['src/helpers.ts:10']).toEqual(['UNSURE', 'The code around the TODO does not show whether ordering matters.']);
    // The refuted finding is not a Finding and is not posted, but the Check Run says why.
    expect(review!.findings.some((f) => f.line === 20)).toBe(false);
    const [check] = github.completedCheckRuns();
    expect(check.output.summary).toContain('1 finding dropped on a second look');
    expect(check.output.summary).toContain("Line 19 is `if (!payload) throw new Error('empty payload');`.");
    expect(check.output.summary).toContain('6 turns, 5 tool calls, 4 checks');
  });

  it('stores what the review cost and credits the model in the Check Run', async () => {
    await deliver().expect(200);
    const review = await settledReview();

    expect(review).toMatchObject({ promptTokens: 2400 + 41000 + 9000, completionTokens: 1800, costCents: 9 });
    expect(review?.agentResult).toMatchObject({ run: { model: 'claude-opus-5', turns: 6 } });
    const [check] = github.completedCheckRuns();
    expect(check.output.summary).toContain('Reviewed by `claude-opus-5` in 6 turns, 5 tool calls, 4 checks');
  });

  // The retry after a failure late in settling reuses the stored answer and the posted
  // review: the agent is paid once and the PR gets one review.
  it('retries without calling the agent or posting again', async () => {
    let failed = false;
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
      if (!failed && (init.method ?? 'GET') === 'PATCH' && String(input).includes('/check-runs/')) {
        failed = true;
        return new Response(JSON.stringify({ message: 'Bad Gateway' }), { status: 502 });
      }
      return inner(input, init);
    });

    await deliver().expect(200);
    const review = await settledReview();

    expect(failed).toBe(true);
    expect(review?.status).toBe(ReviewStatus.COMPLETED);
    expect(agentCalls).toHaveLength(1);
    expect(github.reviews).toHaveLength(1);
  });

  it('retries an agent that is temporarily unavailable, then fails the review', async () => {
    agentReply = () => new Response(JSON.stringify({ detail: 'Anthropic API unavailable, retry later' }), { status: 503 });

    await deliver().expect(200);
    const review = await settledReview();

    expect(review?.status).toBe(ReviewStatus.FAILED);
    expect(agentCalls).toHaveLength(3); // every attempt
    expect(review?.agentResult).toBeNull();
    expect(github.completedCheckRuns()).toEqual([expect.objectContaining({ conclusion: 'failure' })]);
    expect(github.reviews).toHaveLength(0);
  });

  it('does not retry when the agent says the request can never succeed', async () => {
    agentReply = () => new Response(JSON.stringify({ detail: 'repository snapshot: over 50 MB compressed' }), { status: 422 });

    await deliver().expect(200);
    const review = await settledReview();

    expect(review?.status).toBe(ReviewStatus.FAILED);
    expect(agentCalls).toHaveLength(1);
    expect(review?.error).toContain('over 50 MB compressed');
  });
});
