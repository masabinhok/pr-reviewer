import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { AgentReviewer } from './agent-reviewer.js';
import type { InstallationTokenService } from '../github/installation-token.service.js';
import { parseDiff } from '../diff/parse-diff.js';
import { LineMap } from '../diff/line-map.js';
import type { ReviewContext } from './reviewer.js';

const diff = readFileSync(
  fileURLToPath(
    new URL('../../test/fixtures/diffs/pr3-synchronize.diff', import.meta.url),
  ),
  'utf8',
);
const files = parseDiff(diff).filter((f) => f.hunks.length > 0);

const context: ReviewContext = {
  installationId: 160831076n,
  repo: 'masabinhok/pr-reviewer-testbed',
  prNumber: 3,
  title: 'Diff shapes',
  body: 'Exercises every diff shape.',
  baseSha: 'f17b224',
  headSha: '6ac523cfcd000061512a81ba4f9676e09e573ae3',
  files,
  lines: new LineMap(files),
};

const settings: Record<string, unknown> = {
  'agent.url': 'http://localhost:8000',
  'agent.sharedSecret': 'agent-secret',
  'agent.timeoutMs': 60_000,
};

function config(values = settings): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (values[key] === undefined) throw new Error(`missing ${key}`);
      return values[key];
    },
  } as unknown as ConfigService;
}

const agentAnswer = {
  findings: [
    {
      file: 'src/auth.ts',
      line: 26,
      side: 'RIGHT',
      severity: 'low',
      category: 'debugging',
      summary: 'console.log left in.',
      whyItBreaks: 'Logs the value being verified.',
      suggestedFix: null,
    },
  ],
  model: 'claude-opus-5',
  outcome: 'submitted',
  turns: 4,
  toolCalls: 3,
  usage: {
    inputTokens: 1200,
    outputTokens: 800,
    cacheReadInputTokens: 9000,
    cacheCreationInputTokens: 3000,
    costUsd: 0.0507,
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AgentReviewer', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let tokens: { getToken: ReturnType<typeof vi.fn> };
  let reviewer: AgentReviewer;

  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(async () => json(agentAnswer));
    vi.stubGlobal('fetch', fetchMock);
    tokens = { getToken: vi.fn().mockResolvedValue('ghs_installation_token') };
    reviewer = new AgentReviewer(
      config(),
      tokens as unknown as InstallationTokenService,
    );
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the contract the agent expects, authenticated, with a fresh installation token', async () => {
    await reviewer.review(context);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8000/reviews');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'X-Agent-Secret': 'agent-secret',
      'Content-Type': 'application/json',
    });
    expect(tokens.getToken).toHaveBeenCalledWith(160831076n);

    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(
      [
        'baseSha',
        'body',
        'files',
        'headSha',
        'installationToken',
        'prNumber',
        'repo',
        'title',
      ].sort(),
    );
    expect(body.installationToken).toBe('ghs_installation_token');
    expect(body.files.map((f: { path: string }) => f.path)).toEqual(
      files.map((f) => f.path),
    );
    // The parsed diff goes over as-is: the agent's models mirror these field names.
    expect(body.files[0].hunks[0].lines[0]).toEqual(files[0].hunks[0].lines[0]);
  });

  it('sends no token for a public repository with no installation — the evaluation', async () => {
    await reviewer.review({ ...context, installationId: null });

    expect(tokens.getToken).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty(
      'installationToken',
    );
  });

  it('returns the findings and how the run went', async () => {
    const result = await reviewer.review(context);

    expect(result.findings).toEqual([
      {
        file: 'src/auth.ts',
        line: 26,
        side: 'RIGHT',
        severity: 'low',
        category: 'debugging',
        summary: 'console.log left in.',
        whyItBreaks: 'Logs the value being verified.',
        suggestedFix: undefined,
      },
    ]);
    expect(result.run).toEqual({
      model: 'claude-opus-5',
      outcome: 'submitted',
      turns: 4,
      toolCalls: 3,
      usage: agentAnswer.usage,
    });
  });

  it('returns what the second look decided: verdicts on kept findings, and what it dropped', async () => {
    const verification = {
      verdict: 'unsure',
      reason: 'Line 25 may guard it.',
      demotedFrom: 'high',
    };
    const refuted = {
      ...agentAnswer.findings[0],
      line: 20,
      summary: 'sign() is unchecked.',
      verification: null,
    };
    fetchMock.mockResolvedValue(
      json({
        ...agentAnswer,
        findings: [{ ...agentAnswer.findings[0], verification }],
        dropped: [
          { finding: refuted, reason: 'Line 19 throws on an empty payload.' },
        ],
        verifyCalls: 2,
      }),
    );

    const result = await reviewer.review(context);

    expect(result.findings[0].verification).toEqual(verification);
    expect(result.dropped).toEqual([
      {
        finding: expect.objectContaining({
          line: 20,
          suggestedFix: undefined,
          verification: undefined,
        }),
        reason: 'Line 19 throws on an empty payload.',
      },
    ]);
    expect(result.run?.verifyCalls).toBe(2);
  });

  // The API and the agent deploy separately: an agent from before the second look still works.
  it('reads an answer without the second look as one that dropped nothing', async () => {
    const result = await reviewer.review(context);

    expect(result.dropped).toEqual([]);
    expect(result.findings[0].verification).toBeUndefined();
  });

  describe('errors, sorted by whether a retry could help', () => {
    it.each([503, 502, 500])(
      'retries when the agent answers %s',
      async (status) => {
        fetchMock.mockResolvedValue(
          json({ detail: 'Anthropic API unavailable, retry later' }, status),
        );

        const error = await reviewer.review(context).catch((e) => e);

        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(UnrecoverableError);
        expect(error.message).toContain(`agent answered ${status}`);
      },
    );

    it.each([422, 401, 400])(
      'does not retry when the agent answers %s',
      async (status) => {
        fetchMock.mockResolvedValue(
          json(
            { detail: 'repository snapshot: over 50 MB compressed' },
            status,
          ),
        );

        const error = await reviewer.review(context).catch((e) => e);

        expect(error).toBeInstanceOf(UnrecoverableError);
        expect(error.message).toContain('over 50 MB compressed');
      },
    );

    it('retries when the agent cannot be reached at all', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      const error = await reviewer.review(context).catch((e) => e);

      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect(error.message).toBe(
        `agent unreachable for masabinhok/pr-reviewer-testbed#3@6ac523c: TypeError`,
      );
    });

    it('names the network error’s code', async () => {
      fetchMock.mockRejectedValue(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
        }),
      );

      const error = await reviewer.review(context).catch((e) => e);

      expect(error.message).toBe(
        `agent unreachable for masabinhok/pr-reviewer-testbed#3@6ac523c: TypeError (ECONNREFUSED)`,
      );
    });

    it('never puts the installation token in an error', async () => {
      fetchMock.mockResolvedValue(
        json({ detail: [{ msg: 'field required' }] }, 422),
      );

      const error = await reviewer.review(context).catch((e) => e);

      expect(error.message).not.toContain('ghs_');
    });
  });

  it('refuses to start without the agent’s URL or secret', () => {
    expect(
      () =>
        new AgentReviewer(
          config({ ...settings, 'agent.url': undefined }),
          tokens as never,
        ),
    ).toThrow('agent.url');
    expect(
      () =>
        new AgentReviewer(
          config({ ...settings, 'agent.sharedSecret': undefined }),
          tokens as never,
        ),
    ).toThrow('agent.sharedSecret');
  });

  describe('against a real HTTP server', () => {
    let server: Server;
    let url: string;
    const original = getGlobalDispatcher();

    beforeEach(async () => {
      vi.unstubAllGlobals();
      // The agent thinks for a while before it answers at all.
      server = createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(agentAnswer));
        }, 2_500);
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      setGlobalDispatcher(original);
      await new Promise((resolve) => server.close(resolve));
    });

    // fetch's default headers timeout is 300 s; this lowers it to 200 ms so the test can show,
    // in seconds, that AGENT_TIMEOUT_MS is what governs a slow review instead. undici checks
    // its timeouts about once a second, hence an answer 2.5 s late rather than 0.5 s.
    it('waits as long as AGENT_TIMEOUT_MS for headers, not the default dispatcher', async () => {
      setGlobalDispatcher(new Agent({ headersTimeout: 200 }));
      const slow = new AgentReviewer(
        config({
          ...settings,
          'agent.url': url,
          'agent.timeoutMs': 5_000,
        }),
        tokens as unknown as InstallationTokenService,
      );

      const result = await slow.review(context);

      expect(result.findings).toHaveLength(1);
    });

    it('still gives up at AGENT_TIMEOUT_MS', async () => {
      const impatient = new AgentReviewer(
        config({ ...settings, 'agent.url': url, 'agent.timeoutMs': 100 }),
        tokens as unknown as InstallationTokenService,
      );

      const error = await impatient.review(context).catch((e) => e);

      expect(error.message).toMatch(
        /^agent unreachable for .*: (TimeoutError|TypeError)/,
      );
    });
  });
});
