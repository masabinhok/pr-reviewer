import { Logger } from '@nestjs/common';
import { GithubApiService, MAX_PULL_REQUEST_FILES } from './github-api.service.js';
import { GithubApiError, GithubRateLimitError } from './github-api.errors.js';
import type { InstallationTokenService } from './installation-token.service.js';

const INSTALLATION = 42;
const REPO = 'octo/widgets';
const NOW = new Date('2026-09-11T12:00:00Z');

function json(body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

describe('GithubApiService', () => {
  let service: GithubApiService;
  let tokens: { getToken: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn> };
  let fetchMock: ReturnType<typeof vi.fn>;

  const call = (n: number) => {
    const [url, init] = fetchMock.mock.calls[n];
    return { url: String(url), init: init as RequestInit & { headers: Record<string, string> } };
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);

    tokens = {
      getToken: vi.fn().mockResolvedValueOnce('ghs_one').mockResolvedValue('ghs_two'),
      invalidate: vi.fn().mockResolvedValue(undefined),
    };
    service = new GithubApiService(tokens as unknown as InstallationTokenService);

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('calls as the installation, with GitHub’s JSON media type and API version', async () => {
    fetchMock.mockResolvedValue(json({ number: 7 }));

    const pr = await service.getPullRequest(INSTALLATION, REPO, 7);

    expect(pr.number).toBe(7);
    expect(tokens.getToken).toHaveBeenCalledWith(INSTALLATION);
    const { url, init } = call(0);
    expect(url).toBe('https://api.github.com/repos/octo/widgets/pulls/7');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer ghs_one',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  // By SHA through compare — never /pulls/{n}, whose diff moves when the author pushes.
  it('fetches the diff between two exact commits via compare, as raw diff text', async () => {
    fetchMock.mockResolvedValue(new Response('diff --git a/x b/x\n', { status: 200 }));

    const diff = await service.getDiff(INSTALLATION, REPO, 'base111', 'head222');

    expect(diff).toBe('diff --git a/x b/x\n');
    expect(call(0).url).toBe('https://api.github.com/repos/octo/widgets/compare/base111...head222');
    expect(call(0).init.headers.Accept).toBe('application/vnd.github.diff');
  });

  describe('review threads', () => {
    const thread = (over: Record<string, unknown> = {}) => ({
      id: 'PRRT_1',
      isResolved: false,
      isOutdated: true,
      comments: { nodes: [{ id: 'PRRC_1', databaseId: 991, isMinimized: false }] },
      ...over,
    });

    it('reads them through GraphQL, with the comment each one starts', async () => {
      fetchMock.mockResolvedValue(
        json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [thread(), thread({ id: 'PRRT_2', isOutdated: false })] } } } } }),
      );

      const threads = await service.listReviewThreads(INSTALLATION, REPO, 6);

      expect(threads).toEqual([
        { id: 'PRRT_1', isOutdated: true, isResolved: false, commentId: 991n, commentNodeId: 'PRRC_1', isMinimized: false },
        { id: 'PRRT_2', isOutdated: false, isResolved: false, commentId: 991n, commentNodeId: 'PRRC_1', isMinimized: false },
      ]);
      const { url, init } = call(0);
      expect(url).toBe('https://api.github.com/graphql');
      expect(JSON.parse(String(init.body)).variables).toEqual({ owner: 'octo', name: 'widgets', number: 6 });
    });

    it('skips a thread whose comments it cannot see', async () => {
      fetchMock.mockResolvedValue(json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [thread({ comments: { nodes: [] } })] } } } } }));

      expect(await service.listReviewThreads(INSTALLATION, REPO, 6)).toEqual([]);
    });

    it('is empty for a pull request GraphQL will not show', async () => {
      fetchMock.mockResolvedValue(json({ data: { repository: null } }));

      expect(await service.listReviewThreads(INSTALLATION, REPO, 6)).toEqual([]);
    });

    it('collapses a comment as outdated', async () => {
      fetchMock.mockResolvedValue(json({ data: { minimizeComment: { minimizedComment: { isMinimized: true } } } }));

      await service.minimizeComment(INSTALLATION, 'PRRC_1');

      const body = JSON.parse(String(call(0).init.body));
      expect(body.query).toContain('minimizeComment');
      expect(body.query).toContain('OUTDATED');
      expect(body.variables).toEqual({ id: 'PRRC_1' });
    });

    // GraphQL answers 200 with an errors array; a failure must not read as success.
    it('turns a GraphQL error into a failure', async () => {
      fetchMock.mockResolvedValue(json({ data: { minimizeComment: null }, errors: [{ message: 'Resource not accessible by integration' }] }));

      await expect(service.minimizeComment(INSTALLATION, 'PRRC_1')).rejects.toThrow('Resource not accessible by integration');
    });
  });

  describe('pagination', () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ filename: `f${from + i}.ts` }));
    const link = (n: number) =>
      `<https://api.github.com/repositories/1/pulls/7/files?per_page=100&page=${n}>; rel="next", <https://api.github.com/x?page=9>; rel="last"`;

    it('follows the Link header across pages and concatenates them', async () => {
      fetchMock
        .mockResolvedValueOnce(json(page(0, 100), { headers: { link: link(2) } }))
        .mockResolvedValueOnce(json(page(100, 100), { headers: { link: link(3) } }))
        .mockResolvedValueOnce(json(page(200, 17)));

      const files = await service.listPullRequestFiles(INSTALLATION, REPO, 7);

      expect(files).toHaveLength(217);
      expect(files.at(-1)?.filename).toBe('f216.ts');
      expect(call(0).url).toBe('https://api.github.com/repos/octo/widgets/pulls/7/files?per_page=100');
      expect(call(1).url).toContain('page=2');
      expect(call(2).url).toContain('page=3');
    });

    it('stops at the maximum even if GitHub offers another page', async () => {
      fetchMock.mockImplementation(async () => json(page(0, 100), { headers: { link: link(2) } }));

      const items = await service.paginate(INSTALLATION, '/things?per_page=100', { max: 250 });

      expect(items).toHaveLength(250);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('caps pull-request files at GitHub’s 3000', () => {
      expect(MAX_PULL_REQUEST_FILES).toBe(3000);
    });
  });

  describe('rate limits', () => {
    it('reports a spent hourly budget as a primary limit, retrying at the reset time', async () => {
      const reset = NOW.getTime() / 1000 + 1800;
      fetchMock.mockResolvedValue(
        json({ message: 'API rate limit exceeded' }, {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        }),
      );

      const error = await service.getPullRequest(INSTALLATION, REPO, 7).catch((e) => e);

      expect(error).toBeInstanceOf(GithubRateLimitError);
      expect(error).toMatchObject({ kind: 'primary', retryAt: new Date(reset * 1000) });
    });

    it('honours retry-after on a secondary limit', async () => {
      fetchMock.mockResolvedValue(json({ message: 'slow down' }, { status: 429, headers: { 'retry-after': '30' } }));

      const error = await service.getPullRequest(INSTALLATION, REPO, 7).catch((e) => e);

      expect(error).toMatchObject({ kind: 'secondary', retryAt: new Date(NOW.getTime() + 30_000) });
    });

    it('waits a minute on a secondary limit that gives no retry-after', async () => {
      fetchMock.mockResolvedValue(
        json({ message: 'You have exceeded a secondary rate limit.' }, { status: 403 }),
      );

      const error = await service.getPullRequest(INSTALLATION, REPO, 7).catch((e) => e);

      expect(error).toMatchObject({ kind: 'secondary', retryAt: new Date(NOW.getTime() + 60_000) });
    });

    // A 403 that is neither is a real refusal — say, a missing permission.
    it('treats any other 403 as an ordinary failure', async () => {
      fetchMock.mockResolvedValue(json({ message: 'Resource not accessible by integration' }, { status: 403 }));

      const error = await service.getPullRequest(INSTALLATION, REPO, 7).catch((e) => e);

      expect(error).toBeInstanceOf(GithubApiError);
      expect(error).not.toBeInstanceOf(GithubRateLimitError);
    });
  });

  describe('a revoked token (401)', () => {
    it('drops the cached token and retries once with a fresh one', async () => {
      fetchMock
        .mockResolvedValueOnce(json({ message: 'Bad credentials' }, { status: 401 }))
        .mockResolvedValueOnce(json({ number: 7 }));

      const pr = await service.getPullRequest(INSTALLATION, REPO, 7);

      expect(pr.number).toBe(7);
      expect(tokens.invalidate).toHaveBeenCalledWith(INSTALLATION);
      expect(call(0).init.headers.Authorization).toBe('Bearer ghs_one');
      expect(call(1).init.headers.Authorization).toBe('Bearer ghs_two');
    });

    it('gives up after the one retry', async () => {
      fetchMock.mockImplementation(async () => json({ message: 'Bad credentials' }, { status: 401 }));

      const error = await service.getPullRequest(INSTALLATION, REPO, 7).catch((e) => e);

      expect(error).toBeInstanceOf(GithubApiError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('Check Runs', () => {
    it('creates one in progress on the head commit, tied to the review', async () => {
      fetchMock.mockResolvedValue(json({ id: 9001 }, { status: 201 }));

      const run = await service.createCheckRun(INSTALLATION, REPO, { name: 'pr-reviewer', headSha: 'abc123', externalId: 'rev-1' });

      expect(run).toEqual({ id: 9001 });
      const { url, init } = call(0);
      expect(url).toBe('https://api.github.com/repos/octo/widgets/check-runs');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        name: 'pr-reviewer',
        head_sha: 'abc123',
        external_id: 'rev-1',
        status: 'in_progress',
        started_at: NOW.toISOString(),
      });
    });

    it('completes one with a conclusion and a summary', async () => {
      fetchMock.mockResolvedValue(json({ id: 9001 }));

      await service.completeCheckRun(INSTALLATION, REPO, 9001n, {
        conclusion: 'success',
        output: { title: 'No findings in 1 file', summary: 'Reviewed 1 file.' },
      });

      const { url, init } = call(0);
      expect(url).toBe('https://api.github.com/repos/octo/widgets/check-runs/9001');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(String(init.body))).toEqual({
        status: 'completed',
        conclusion: 'success',
        completed_at: NOW.toISOString(),
        output: { title: 'No findings in 1 file', summary: 'Reviewed 1 file.' },
      });
    });
  });

  // The App never approves or requests changes — whatever the code it read says.
  it('posts a review as a plain COMMENT with every inline comment in it', async () => {
    fetchMock.mockResolvedValue(json({ id: 9001, html_url: 'https://github.com/x' }));

    await service.createReview(INSTALLATION, REPO, 6, {
      commitId: 'head111',
      body: 'pr-reviewer found 1 issue (1 high).',
      comments: [{ path: 'src/users.ts', line: 18, side: 'RIGHT', body: '**High** · security — …' }],
    });

    const { url, init } = call(0);
    expect(url).toBe('https://api.github.com/repos/octo/widgets/pulls/6/reviews');
    expect(JSON.parse(String(init.body))).toEqual({
      commit_id: 'head111',
      body: 'pr-reviewer found 1 issue (1 high).',
      event: 'COMMENT',
      comments: [{ path: 'src/users.ts', line: 18, side: 'RIGHT', body: '**High** · security — …' }],
    });
  });

  // /reviews/{id}/comments returns line: null and side: null; the PR-level list has them.
  it('reads a review’s comments from the PR’s comment list, where line and side are filled in', async () => {
    fetchMock.mockResolvedValue(
      json([
        { id: 1, path: 'a.ts', line: 2, side: 'RIGHT', pull_request_review_id: 9001 },
        { id: 2, path: 'b.ts', line: 5, side: 'RIGHT', pull_request_review_id: 1234 },
      ]),
    );

    const comments = await service.listReviewComments(INSTALLATION, REPO, 6, 9001n);

    expect(call(0).url).toBe('https://api.github.com/repos/octo/widgets/pulls/6/comments?per_page=100');
    expect(comments.map((c) => c.id)).toEqual([1]);
  });

  it('reports failures with GitHub’s message and the path, never the token', async () => {
    fetchMock.mockResolvedValue(json({ message: 'Not Found' }, { status: 404 }));

    const error = await service.listPullRequestFiles(INSTALLATION, REPO, 7).catch((e) => e);

    expect(error).toBeInstanceOf(GithubApiError);
    expect(error.message).toBe('GitHub 404 on /repos/octo/widgets/pulls/7/files: Not Found');
    expect(error.message).not.toContain('ghs_');
  });
});
