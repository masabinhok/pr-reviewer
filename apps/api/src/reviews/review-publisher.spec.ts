import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { ReviewPublisher, commentBody, reviewMarker } from './review-publisher.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { GithubApiService } from '../github/github-api.service.js';
import type { ConfigService } from '@nestjs/config';
import { GithubApiError } from '../github/github-api.errors.js';
import { FindingSide, FindingStatus, Severity, type Finding } from '../generated/prisma/client.js';
import type { ReviewTarget } from './review.processor.js';

const target: ReviewTarget = {
  reviewId: 'rev-1',
  installationId: 42n,
  repo: 'octo/widgets',
  prNumber: 6,
  baseSha: 'base000',
  headSha: 'head111',
};

let nextId = 1;
function finding(severity: Severity, overrides: Partial<Finding> = {}): Finding {
  return {
    id: `f-${nextId++}`,
    reviewId: 'rev-1',
    filePath: 'src/users.ts',
    line: 18,
    side: FindingSide.RIGHT,
    status: FindingStatus.OPEN,
    severity,
    category: 'security',
    summary: 'SQL is built by string interpolation.',
    whyItBreaks: "findUserByName(db, \"x' OR '1'='1\") returns every user.",
    suggestedFix: 'Use a parameterised query.',
    fingerprint: 'f'.repeat(64),
    githubCommentId: null,
    verdict: null,
    verdictReason: null,
    demotedFrom: null,
    ...overrides,
  };
}

describe('ReviewPublisher', () => {
  let prisma: {
    review: { findUniqueOrThrow: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    finding: { update: ReturnType<typeof vi.fn> };
  };
  let github: {
    createReview: ReturnType<typeof vi.fn>;
    listReviews: ReturnType<typeof vi.fn>;
    listReviewComments: ReturnType<typeof vi.fn>;
  };
  let publisher: ReviewPublisher;
  const withBar = (minSeverity: Severity) =>
    new ReviewPublisher(
      prisma as unknown as PrismaService,
      github as unknown as GithubApiService,
      { getOrThrow: () => minSeverity } as unknown as ConfigService,
    );

  beforeEach(() => {
    prisma = {
      review: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ githubReviewId: null }),
        update: vi.fn().mockResolvedValue({}),
      },
      finding: { update: vi.fn().mockResolvedValue({}) },
    };
    github = {
      createReview: vi.fn().mockResolvedValue({ id: 9001, html_url: 'https://github.com/octo/widgets/pull/6#pullrequestreview-9001' }),
      listReviews: vi.fn().mockResolvedValue([]),
      listReviewComments: vi.fn().mockResolvedValue([]),
    };
    publisher = withBar(Severity.MEDIUM);
    for (const level of ['log', 'warn'] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('posts high and medium findings as one review, and keeps low ones out of it', async () => {
    const high = finding(Severity.HIGH, { line: 18 });
    const medium = finding(Severity.MEDIUM, { line: 28, category: 'correctness' });
    const low = finding(Severity.LOW, { line: 32 });

    const publication = await publisher.publish(target, [high, medium, low]);

    expect(github.createReview).toHaveBeenCalledTimes(1);
    const [installation, repo, pr, review] = github.createReview.mock.calls[0];
    expect([installation, repo, pr]).toEqual([42n, 'octo/widgets', 6]);
    expect(review.commitId).toBe('head111');
    expect(review.comments.map((c: { line: number }) => c.line)).toEqual([18, 28]);
    expect(review.comments[0]).toMatchObject({ path: 'src/users.ts', side: 'RIGHT' });
    expect(review.body).toBe(
      'pr-reviewer found 2 issues (1 high, 1 medium). 1 lower-severity note is in the pr-reviewer check.\n\n' +
        reviewMarker('rev-1'),
    );
    expect(publication).toEqual({
      posted: 2,
      url: 'https://github.com/octo/widgets/pull/6#pullrequestreview-9001',
      minSeverity: Severity.MEDIUM,
    });
  });

  // The default. Dogfooding the local model on real pull requests: its medium findings
  // were noise, its high ones were the planted bugs.
  it('with the bar at high, posts only high findings and leaves medium in the check', async () => {
    const high = finding(Severity.HIGH, { line: 18 });
    const medium = finding(Severity.MEDIUM, { line: 28 });

    const publication = await withBar(Severity.HIGH).publish(target, [high, medium]);

    const [, , , review] = github.createReview.mock.calls[0];
    expect(review.comments.map((c: { line: number }) => c.line)).toEqual([18]);
    expect(review.body).toContain('1 lower-severity note is in the pr-reviewer check');
    expect(publication).toMatchObject({ posted: 1, minSeverity: Severity.HIGH });
  });

  it('with the bar at low, posts everything', async () => {
    await withBar(Severity.LOW).publish(target, [finding(Severity.HIGH), finding(Severity.LOW, { line: 32 })]);

    expect(github.createReview.mock.calls[0][3].comments).toHaveLength(2);
  });

  it('stores the GitHub review ID so a retry never posts again', async () => {
    await publisher.publish(target, [finding(Severity.HIGH)]);

    expect(prisma.review.update).toHaveBeenCalledWith({ where: { id: 'rev-1' }, data: { githubReviewId: 9001n } });
  });

  it('posts nothing when the review was already posted', async () => {
    prisma.review.findUniqueOrThrow.mockResolvedValue({ githubReviewId: 9001n });

    const publication = await publisher.publish(target, [finding(Severity.HIGH)]);

    expect(github.createReview).not.toHaveBeenCalled();
    expect(github.listReviews).not.toHaveBeenCalled();
    expect(publication.posted).toBe(1);
  });

  // The gap between posting and storing the ID: GitHub has the review, the row doesn't.
  it('adopts a review an earlier attempt posted but never recorded, instead of posting twice', async () => {
    github.listReviews.mockResolvedValue([
      { id: 111, body: 'someone else’s review', html_url: 'u1' },
      { id: 8000, body: `pr-reviewer found 1 issue (1 high).\n\n${reviewMarker('rev-1')}`, html_url: 'u2' },
    ]);

    const publication = await publisher.publish(target, [finding(Severity.HIGH)]);

    expect(github.createReview).not.toHaveBeenCalled();
    expect(prisma.review.update).toHaveBeenCalledWith({ where: { id: 'rev-1' }, data: { githubReviewId: 8000n } });
    expect(publication.url).toBe('u2');
  });

  it('posts nothing when no finding meets the severity gate', async () => {
    const publication = await publisher.publish(target, [finding(Severity.LOW), finding(Severity.LOW)]);

    expect(github.createReview).not.toHaveBeenCalled();
    expect(publication).toEqual({ posted: 0, url: null, minSeverity: Severity.MEDIUM });
  });

  it('links each posted finding to its comment, matching path, line and side', async () => {
    const a = finding(Severity.HIGH, { line: 18 });
    const b = finding(Severity.HIGH, { line: 18, category: 'correctness' }); // same line
    const c = finding(Severity.MEDIUM, { line: 28 });
    github.listReviewComments.mockResolvedValue([
      { id: 501, path: 'src/users.ts', line: 28, side: 'RIGHT' },
      { id: 502, path: 'src/users.ts', line: 18, side: 'RIGHT' },
      { id: 503, path: 'src/users.ts', line: 18, side: 'RIGHT' },
    ]);

    await publisher.publish(target, [a, b, c]);

    const links = prisma.finding.update.mock.calls.map(([arg]) => [arg.where.id, arg.data.githubCommentId]);
    expect(links).toEqual([
      [a.id, 502n],
      [b.id, 503n],
      [c.id, 501n],
    ]);
  });

  // Every comment was validated against the diff first, so GitHub refusing one is a bug
  // the same request will hit again — not something to retry.
  it('does not retry a review GitHub refuses as unprocessable', async () => {
    github.createReview.mockRejectedValue(new GithubApiError(422, '/repos/octo/widgets/pulls/6/reviews', 'Line could not be resolved'));

    await expect(publisher.publish(target, [finding(Severity.HIGH)])).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('lets any other GitHub failure retry', async () => {
    github.createReview.mockRejectedValue(new GithubApiError(502, '/repos/octo/widgets/pulls/6/reviews', 'Bad Gateway'));

    const error = await publisher.publish(target, [finding(Severity.HIGH)]).catch((e) => e);

    expect(error).toBeInstanceOf(GithubApiError);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });
});

describe('commentBody', () => {
  it('leads with severity and category, then the failure scenario, then the fix', () => {
    expect(commentBody(finding(Severity.HIGH))).toBe(
      '**High** · security — SQL is built by string interpolation.\n\n' +
        "findUserByName(db, \"x' OR '1'='1\") returns every user.\n\n" +
        '**Suggested fix:** Use a parameterised query.',
    );
  });

  it('leaves out the fix line when there is no fix', () => {
    expect(commentBody(finding(Severity.MEDIUM, { suggestedFix: null }))).not.toContain('Suggested fix');
  });
});
