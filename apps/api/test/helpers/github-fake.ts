/**
 * GitHub, faked at the `fetch` boundary. Everything above it — the token service, the API
 * client, pagination, error mapping, the pipeline — runs for real; only the network is
 * replaced, with responses captured from real calls (test/fixtures/diffs).
 *
 * Unknown requests throw, so a test can't pass by quietly calling something unexpected.
 */

export interface FakePullRequest {
  /** What `/pulls/{n}/files` returns. */
  files: unknown[];
  /** What `/compare/{base}...{head}` returns, keyed by `base...head`, or one diff for any. */
  diff: string | ((base: string, head: string) => string);
  title?: string;
}

export interface FakeGithubOptions {
  /** By `owner/repo#number`. */
  pulls: Record<string, FakePullRequest>;
  /** Make compare fail this way, to exercise the failure path. */
  failCompare?: { status: number; message: string };
}

export interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

export interface PostedReview {
  id: number;
  prNumber: number;
  body: string;
  event: string;
  commitId: string;
  comments: { id: number; path: string; line: number; side: string; body: string }[];
}

export function fakeGithub(options: FakeGithubOptions) {
  const calls: RecordedCall[] = [];
  let nextCheckRunId = 5000;
  let nextReviewId = 7000;
  let nextCommentId = 90000;
  const reviews: PostedReview[] = [];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const pull = (repo: string, number: string) => {
    const pr = options.pulls[`${repo}#${number}`];
    if (!pr) throw new Error(`fake GitHub: no pull request ${repo}#${number}`);
    return pr;
  };

  async function handle(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });

    let m: RegExpMatchArray | null;

    if (method === 'POST' && (m = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
      return json({ token: `ghs_fake_${m[1]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/))) {
      return json(pull(m[1], m[2]).files);
    }
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/))) {
      const pr = pull(m[1], m[2]);
      return json({ number: Number(m[2]), title: pr.title ?? 'A pull request', body: null });
    }
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/))) {
      if (options.failCompare) return json({ message: options.failCompare.message }, options.failCompare.status);
      const pr = Object.entries(options.pulls).find(([key]) => key.startsWith(`${m![1]}#`))?.[1];
      if (!pr) throw new Error(`fake GitHub: no pull request in ${m[1]}`);
      return new Response(typeof pr.diff === 'string' ? pr.diff : pr.diff(m[2], m[3]), { status: 200 });
    }
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/))) {
      return json(reviews.filter((r) => r.prNumber === Number(m![2])).map((r) => ({ id: r.id, body: r.body, html_url: `https://github.com/${m![1]}/pull/${m![2]}#pullrequestreview-${r.id}` })));
    }
    if (method === 'POST' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/))) {
      const review: PostedReview = {
        id: nextReviewId++,
        prNumber: Number(m[2]),
        body: body.body,
        event: body.event,
        commitId: body.commit_id,
        comments: body.comments.map((c: { path: string; line: number; side: string; body: string }) => ({ id: nextCommentId++, ...c })),
      };
      reviews.push(review);
      return json({ id: review.id, html_url: `https://github.com/${m[1]}/pull/${m[2]}#pullrequestreview-${review.id}` });
    }
    // Faithful to GitHub, including its quirk: the per-review endpoint leaves line and side
    // null, and only the PR-level comment list fills them in. (An earlier fake returned them
    // from both, and a real bug passed its tests.)
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews\/(\d+)\/comments$/))) {
      const review = reviews.find((r) => r.id === Number(m![3]));
      return json((review?.comments ?? []).map(({ id, path: p }) => ({ id, path: p, line: null, side: null })));
    }
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/comments$/))) {
      return json(
        reviews
          .filter((r) => r.prNumber === Number(m![2]))
          .flatMap((r) => r.comments.map(({ id, path: p, line, side }) => ({ id, path: p, line, side, pull_request_review_id: r.id }))),
      );
    }
    if (method === 'POST' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/check-runs$/))) {
      return json({ id: nextCheckRunId++ }, 201);
    }
    if (method === 'PATCH' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/check-runs\/(\d+)$/))) {
      return json({ id: Number(m[2]) });
    }

    throw new Error(`fake GitHub: unexpected ${method} ${path}`);
  }

  return {
    fetch: handle,
    calls,
    /** The pull requests the fake serves; change one mid-test to change what GitHub returns. */
    pulls: options.pulls,
    /** Reviews posted to the fake, with their comments. */
    reviews,
    /** The body of every Check Run completion, in order. */
    completedCheckRuns: () =>
      calls
        .filter((c) => c.method === 'PATCH' && /\/check-runs\/\d+$/.test(c.path))
        .map((c) => c.body as { conclusion: string; output: { title: string; summary: string } }),
    createdCheckRuns: () =>
      calls.filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs')).map((c) => c.body as { head_sha: string }),
  };
}
