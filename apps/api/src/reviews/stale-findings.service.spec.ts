import { Logger } from '@nestjs/common';
import { StaleFindings } from './stale-findings.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  GithubApiService,
  ReviewThread,
} from '../github/github-api.service.js';
import {
  FindingStatus,
  ResolvedBy,
  type Finding,
} from '../generated/prisma/client.js';
import type { ReviewTarget } from './review.processor.js';

const target: ReviewTarget = {
  reviewId: 'rev-2',
  installationId: 42n,
  repo: 'octo/widgets',
  prNumber: 6,
  baseSha: 'base000',
  headSha: 'head111',
};

const earlier = (id: string, commentId: bigint) => ({
  id,
  githubCommentId: commentId,
  filePath: 'src/auth.ts',
  line: 23,
});

const thread = (
  commentId: bigint,
  over: Partial<ReviewThread> = {},
): ReviewThread => ({
  id: `PRRT_${commentId}`,
  isOutdated: true,
  isResolved: false,
  commentId,
  commentNodeId: `PRRC_${commentId}`,
  isMinimized: false,
  ...over,
});

/** A finding of the current review; `repeatOfId` says it found an earlier one again. */
const current = (repeatOfId: string | null) =>
  ({ id: 'f-new', repeatOfId }) as Finding;

describe('StaleFindings', () => {
  let prisma: {
    finding: {
      findMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };
  let github: {
    listReviewThreads: ReturnType<typeof vi.fn>;
    minimizeComment: ReturnType<typeof vi.fn>;
  };
  let stale: StaleFindings;

  beforeEach(() => {
    prisma = {
      finding: {
        findMany: vi.fn().mockResolvedValue([earlier('old-1', 991n)]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    github = {
      listReviewThreads: vi.fn().mockResolvedValue([thread(991n)]),
      minimizeComment: vi.fn().mockResolvedValue(undefined),
    };
    stale = new StaleFindings(
      prisma as unknown as PrismaService,
      github as unknown as GithubApiService,
    );
    for (const level of ['log', 'warn'] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  describe('a comment from an earlier review', () => {
    it('is resolved and collapsed when its code changed and this review did not find it again', async () => {
      const resolved = await stale.resolve(target, [current(null)]);

      expect(resolved).toBe(1);
      expect(prisma.finding.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['old-1'] } },
        data: {
          status: FindingStatus.RESOLVED,
          resolvedAt: expect.any(Date),
          resolvedBy: ResolvedBy.APP,
        },
      });
      expect(github.minimizeComment).toHaveBeenCalledWith(42n, 'PRRC_991');
    });

    // The model's findings vary run to run: not repeating itself is not evidence of a fix.
    it('is left alone when this review found it again, however outdated the code', async () => {
      const resolved = await stale.resolve(target, [current('old-1')]);

      expect(resolved).toBe(0);
      expect(prisma.finding.updateMany).not.toHaveBeenCalled();
      expect(github.minimizeComment).not.toHaveBeenCalled();
    });

    it('is left alone when the code it points at has not changed', async () => {
      github.listReviewThreads.mockResolvedValue([
        thread(991n, { isOutdated: false }),
      ]);

      expect(await stale.resolve(target, [current(null)])).toBe(0);
      expect(prisma.finding.updateMany).not.toHaveBeenCalled();
    });

    it('is not collapsed twice', async () => {
      github.listReviewThreads.mockResolvedValue([
        thread(991n, { isMinimized: true }),
      ]);

      expect(await stale.resolve(target, [current(null)])).toBe(1);
      expect(github.minimizeComment).not.toHaveBeenCalled();
    });

    // The row is the record; an expanded comment is untidy, not wrong.
    it('stays resolved when collapsing the comment fails', async () => {
      github.minimizeComment.mockRejectedValue(new Error('GitHub 403'));

      await expect(stale.resolve(target, [current(null)])).resolves.toBe(1);
      expect(prisma.finding.updateMany).toHaveBeenCalled();
    });

    it('only considers open, posted findings of other reviews of this pull request', async () => {
      await stale.resolve(target, [current(null)]);

      expect(prisma.finding.findMany.mock.calls[0][0].where).toEqual({
        status: FindingStatus.OPEN,
        githubCommentId: { not: null },
        reviewId: { not: 'rev-2' },
        review: { prNumber: 6, repo: { fullName: 'octo/widgets' } },
      });
    });

    it('asks GitHub nothing when there is nothing that could be stale', async () => {
      prisma.finding.findMany.mockResolvedValue([]);

      expect(await stale.resolve(target, [current(null)])).toBe(0);
      expect(github.listReviewThreads).not.toHaveBeenCalled();
    });
  });

  describe('a person resolving the thread on GitHub', () => {
    it('resolves the findings behind its comments', async () => {
      await stale.setResolvedByPerson([991n, 992n], true);

      expect(prisma.finding.updateMany).toHaveBeenCalledWith({
        where: { githubCommentId: { in: [991n, 992n] } },
        data: {
          status: FindingStatus.RESOLVED,
          resolvedAt: expect.any(Date),
          resolvedBy: ResolvedBy.PERSON,
        },
      });
    });

    it('reopens them when the thread is reopened', async () => {
      await stale.setResolvedByPerson([991n], false);

      expect(prisma.finding.updateMany).toHaveBeenCalledWith({
        where: { githubCommentId: { in: [991n] } },
        data: {
          status: FindingStatus.OPEN,
          resolvedAt: null,
          resolvedBy: null,
        },
      });
    });

    it('does nothing for a thread with no comments', async () => {
      expect(await stale.setResolvedByPerson([], true)).toBe(0);
      expect(prisma.finding.updateMany).not.toHaveBeenCalled();
    });
  });
});
