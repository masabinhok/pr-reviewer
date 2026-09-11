import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PullRequestsService } from './pull-requests.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { Prisma, ReviewStatus } from '../generated/prisma/client.js';
import type { PullRequestPayload } from './pull-request-payload.js';
import { fixtureJson } from '../../test/helpers/fixtures.js';

// The real captured delivery — its shape is what GitHub actually sends.
const opened = fixtureJson<PullRequestPayload>('pull_request.opened');
const HEAD = opened.pull_request.head.sha;
const BASE = opened.pull_request.base.sha;

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function prismaStub() {
  return {
    installation: { findUnique: vi.fn().mockResolvedValue({ id: 'inst-1' }) },
    repo: { upsert: vi.fn().mockResolvedValue({ id: 'repo-1' }) },
    review: {
      create: vi.fn().mockResolvedValue({ id: 'rev-1', status: ReviewStatus.PENDING }),
      findUniqueOrThrow: vi.fn(),
    },
  };
}

describe('PullRequestsService', () => {
  let prisma: ReturnType<typeof prismaStub>;
  let queue: { add: ReturnType<typeof vi.fn> };
  let service: PullRequestsService;

  beforeEach(() => {
    prisma = prismaStub();
    queue = { add: vi.fn().mockResolvedValue({}) };
    service = new PullRequestsService(prisma as unknown as PrismaService, queue as unknown as Queue);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates a PENDING review for the head commit and enqueues it by review ID', async () => {
    const outcome = await service.handle(opened, 'd-1');

    expect(outcome).toBe('enqueued');
    expect(prisma.review.create).toHaveBeenCalledWith({
      data: { repoId: 'repo-1', prNumber: opened.number, baseSha: BASE, headSha: HEAD, status: ReviewStatus.PENDING },
    });
    // The job carries the ID and nothing else; its ID is derived from the review's.
    expect(queue.add).toHaveBeenCalledWith('review', { reviewId: 'rev-1' }, { jobId: 'review-rev-1' });
  });

  it('upserts the repo and fills in its default branch', async () => {
    await service.handle(opened, 'd-1');

    const call = prisma.repo.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ githubId: BigInt(opened.repository.id) });
    expect(call.create.defaultBranch).toBe(opened.repository.default_branch);
    expect(call.update).toMatchObject({ defaultBranch: opened.repository.default_branch, deletedAt: null });
  });

  it('does nothing for a draft PR', async () => {
    const draft = { ...opened, pull_request: { ...opened.pull_request, draft: true } };

    const outcome = await service.handle(draft, 'd-2');

    expect(outcome).toBe('draft');
    expect(prisma.review.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('skips a PR from an installation that was never recorded', async () => {
    prisma.installation.findUnique.mockResolvedValue(null);

    const outcome = await service.handle(opened, 'd-3');

    expect(outcome).toBe('unknown-installation');
    expect(prisma.repo.upsert).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  describe('a commit that already has a review', () => {
    beforeEach(() => {
      prisma.review.create.mockRejectedValue(uniqueViolation());
    });

    // The row exists but its job may not (the first enqueue failed). Re-adding with the
    // same job ID repairs that, and is ignored by BullMQ if the job is there.
    it('re-adds the job when the existing review is still PENDING', async () => {
      prisma.review.findUniqueOrThrow.mockResolvedValue({ id: 'rev-old', status: ReviewStatus.PENDING });

      const outcome = await service.handle(opened, 'd-4');

      expect(outcome).toBe('already-reviewing');
      expect(queue.add).toHaveBeenCalledWith('review', { reviewId: 'rev-old' }, { jobId: 'review-rev-old' });
    });

    it.each([ReviewStatus.RUNNING, ReviewStatus.COMPLETED, ReviewStatus.FAILED])(
      'does not enqueue again when it is %s',
      async (status) => {
        prisma.review.findUniqueOrThrow.mockResolvedValue({ id: 'rev-old', status });

        const outcome = await service.handle(opened, 'd-5');

        expect(outcome).toBe('already-reviewing');
        expect(queue.add).not.toHaveBeenCalled();
      },
    );
  });

  it('rethrows a database error that is not a unique violation, without enqueueing', async () => {
    prisma.review.create.mockRejectedValue(new Error('connection lost'));

    await expect(service.handle(opened, 'd-6')).rejects.toThrow('connection lost');
    expect(queue.add).not.toHaveBeenCalled();
  });
});
