import { Logger } from '@nestjs/common';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { ReviewProcessor, type ReviewTarget } from './review.processor.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { GithubApiService } from '../github/github-api.service.js';
import { ReviewStatus } from '../generated/prisma/client.js';
import { GithubRateLimitError } from '../github/github-api.errors.js';
import type { ReviewJobData } from './review-queue.js';
import type { ReviewOutcome } from './review-outcome.js';
import type { ReviewPipeline } from './review-pipeline.js';
import { Severity } from '../generated/prisma/client.js';
import type { ValidFinding } from '../reviewer/validate-findings.js';

const HEAD = '9ee05f8fb49c7d0c5183c0b0853f1bed0da7f6a8';

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rev-1',
    status: ReviewStatus.PENDING,
    prNumber: 3,
    baseSha: 'base000',
    headSha: HEAD,
    checkRunId: null as bigint | null,
    repo: { fullName: 'octo/widgets', installation: { githubId: 42n } },
    ...overrides,
  };
}

function job(attemptsMade = 0, attempts = 3) {
  return {
    data: { reviewId: 'rev-1' },
    attemptsMade,
    opts: { attempts },
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<ReviewJobData> & { moveToDelayed: ReturnType<typeof vi.fn> };
}

describe('ReviewProcessor', () => {
  let prisma: {
    review: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    finding: { deleteMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let github: { createCheckRun: ReturnType<typeof vi.fn>; completeCheckRun: ReturnType<typeof vi.fn> };
  let processor: ReviewProcessor;
  let run: ReturnType<typeof vi.spyOn>;

  /** Every `data` the row was updated with, in order. */
  const updates = () => prisma.review.update.mock.calls.map(([arg]) => arg.data);
  const statuses = () => updates().map((d) => d.status).filter(Boolean);
  const conclusion = () => github.completeCheckRun.mock.calls[0]?.[3];

  beforeEach(() => {
    prisma = {
      review: {
        findUnique: vi.fn().mockResolvedValue(reviewRow()),
        update: vi.fn().mockResolvedValue({}),
      },
      finding: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      // The array form: every operation is built first, then committed together.
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    github = {
      createCheckRun: vi.fn().mockResolvedValue({ id: 777 }),
      completeCheckRun: vi.fn().mockResolvedValue(undefined),
    };
    processor = new ReviewProcessor(
      prisma as unknown as PrismaService,
      github as unknown as GithubApiService,
      {} as ReviewPipeline, // `run` is spied below, so the pipeline itself is never called
    );
    // `run` is the pipeline; here only what it returns or throws matters.
    run = vi
      .spyOn(processor as unknown as { run: (t: ReviewTarget) => Promise<ReviewOutcome> }, 'run')
      .mockResolvedValue({ kind: 'completed', reviewed: ['src/a.ts'], skipped: [], findings: [] });
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterEach(() => vi.restoreAllMocks());

  describe('a review that completes', () => {
    it('runs the pipeline with everything it needs, from the database', async () => {
      await processor.process(job());

      expect(run).toHaveBeenCalledWith({
        reviewId: 'rev-1',
        installationId: 42n,
        repo: 'octo/widgets',
        prNumber: 3,
        baseSha: 'base000',
        headSha: HEAD,
      });
    });

    it('opens a Check Run on the head commit, stores its ID, and completes it as success', async () => {
      await processor.process(job());

      expect(github.createCheckRun).toHaveBeenCalledWith(42n, 'octo/widgets', {
        name: 'pr-reviewer',
        headSha: HEAD,
        externalId: 'rev-1',
      });
      expect(updates()).toContainEqual({ checkRunId: 777n });
      expect(github.completeCheckRun).toHaveBeenCalledWith(42n, 'octo/widgets', 777n, expect.anything());
      expect(conclusion()).toMatchObject({ conclusion: 'success', output: { title: 'No findings in 1 file' } });
      expect(statuses()).toEqual([ReviewStatus.RUNNING, ReviewStatus.COMPLETED]);
    });

    // A spinner that stops before the row settles can only be fixed by the retry; a row
    // that settles first makes the retry skip, and the spinner never stops.
    it('completes the Check Run before settling the row', async () => {
      const order: string[] = [];
      github.completeCheckRun.mockImplementation(async () => void order.push('check'));
      prisma.review.update.mockImplementation(async ({ data }) => void (data.status === ReviewStatus.COMPLETED && order.push('row')));

      await processor.process(job());

      expect(order).toEqual(['check', 'row']);
    });

    it('stores the findings and COMPLETED in one transaction, replacing any from an earlier attempt', async () => {
      const found: ValidFinding = {
        path: 'src/auth.ts',
        line: 26,
        side: 'RIGHT',
        severity: Severity.LOW,
        category: 'debugging',
        summary: '`console.log` is left in.',
        whyItBreaks: 'writes to stdout in production',
        suggestedFix: null,
        fingerprint: 'a'.repeat(64),
      };
      run.mockResolvedValue({ kind: 'completed', reviewed: ['src/auth.ts'], skipped: [], findings: [found] });

      await processor.process(job());

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.finding.deleteMany).toHaveBeenCalledWith({ where: { reviewId: 'rev-1' } });
      expect(prisma.finding.createMany).toHaveBeenCalledWith({
        data: [
          {
            reviewId: 'rev-1',
            filePath: 'src/auth.ts',
            line: 26,
            side: 'RIGHT',
            severity: Severity.LOW,
            category: 'debugging',
            summary: '`console.log` is left in.',
            whyItBreaks: 'writes to stdout in production',
            suggestedFix: null,
            fingerprint: 'a'.repeat(64),
          },
        ],
      });
      const [ops] = prisma.$transaction.mock.calls[0];
      expect(ops).toHaveLength(3); // delete, create, COMPLETED — all or nothing
    });

    it('reuses the Check Run a previous attempt created', async () => {
      prisma.review.findUnique.mockResolvedValue(reviewRow({ status: ReviewStatus.RUNNING, checkRunId: 555n }));

      await processor.process(job(1));

      expect(github.createCheckRun).not.toHaveBeenCalled();
      expect(github.completeCheckRun).toHaveBeenCalledWith(42n, 'octo/widgets', 555n, expect.anything());
    });
  });

  it('records a skipped review as SKIPPED with its reason, and a skipped Check Run', async () => {
    run.mockResolvedValue({ kind: 'skipped', reason: '62 files to review, over the limit of 50', skipped: [] });

    await processor.process(job());

    expect(conclusion()).toMatchObject({ conclusion: 'skipped' });
    expect(updates().at(-1)).toMatchObject({
      status: ReviewStatus.SKIPPED,
      skipReason: '62 files to review, over the limit of 50',
    });
  });

  describe('a review that fails', () => {
    beforeEach(() => {
      run.mockRejectedValue(new Error('GitHub 502'));
    });

    // Retries left: the review is still going, so the spinner stays and the row stays RUNNING.
    it('leaves the Check Run and the row alone while retries are left', async () => {
      await expect(processor.process(job(0, 3))).rejects.toThrow('GitHub 502');

      expect(github.completeCheckRun).not.toHaveBeenCalled();
      expect(statuses()).toEqual([ReviewStatus.RUNNING]);
    });

    it('completes the Check Run as failure and marks the row FAILED on the final attempt', async () => {
      await expect(processor.process(job(2, 3))).rejects.toThrow('GitHub 502');

      expect(conclusion()).toMatchObject({ conclusion: 'failure', output: { title: 'Review failed' } });
      expect(conclusion().output.summary).toContain('GitHub 502');
      expect(conclusion().output.summary).toContain('after 3 attempts');
      expect(updates().at(-1)).toMatchObject({ status: ReviewStatus.FAILED, error: 'GitHub 502' });
    });

    // If GitHub is what's down, completing the check fails too — that must not hide the
    // real error or stop the row being marked FAILED.
    it('still marks the row FAILED and rethrows the real error when completing the Check Run fails', async () => {
      github.completeCheckRun.mockRejectedValue(new Error('GitHub 503'));

      await expect(processor.process(job(2, 3))).rejects.toThrow('GitHub 502');

      expect(updates().at(-1)).toMatchObject({ status: ReviewStatus.FAILED });
    });

    // BullMQ fails an UnrecoverableError at once, whatever attempts are left — so the row
    // and the spinner must settle on the first attempt, not wait for a retry that won't come.
    it('settles on the first attempt when the error is unrecoverable', async () => {
      run.mockRejectedValue(new UnrecoverableError('agent answered 422: repository snapshot too large'));

      await expect(processor.process(job(0, 3))).rejects.toBeInstanceOf(UnrecoverableError);

      expect(conclusion()).toMatchObject({ conclusion: 'failure' });
      expect(updates().at(-1)).toMatchObject({ status: ReviewStatus.FAILED });
    });

    it('marks it FAILED without touching a Check Run that was never created', async () => {
      github.createCheckRun.mockRejectedValue(new Error('Resource not accessible by integration'));

      await expect(processor.process(job(2, 3))).rejects.toThrow('Resource not accessible');

      expect(github.completeCheckRun).not.toHaveBeenCalled();
      expect(updates().at(-1)).toMatchObject({ status: ReviewStatus.FAILED });
    });
  });

  // Even on the last attempt: waiting for GitHub is not a failure of the review.
  it('reschedules a rate-limited attempt for the reset time, leaving the Check Run spinning', async () => {
    const retryAt = new Date(Date.now() + 30 * 60_000);
    run.mockRejectedValue(new GithubRateLimitError('primary', retryAt, '/repos/o/r/pulls/1/files'));
    const finalAttempt = job(2, 3);

    await expect(processor.process(finalAttempt, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    expect(finalAttempt.moveToDelayed).toHaveBeenCalledWith(retryAt.getTime(), 'lock-token');
    expect(github.completeCheckRun).not.toHaveBeenCalled();
    expect(statuses()).toEqual([ReviewStatus.RUNNING, ReviewStatus.PENDING]);
  });

  describe('a review with nothing to do', () => {
    it('does nothing when the row no longer exists', async () => {
      prisma.review.findUnique.mockResolvedValue(null);

      await processor.process(job());

      expect(run).not.toHaveBeenCalled();
      expect(github.createCheckRun).not.toHaveBeenCalled();
    });

    it.each([ReviewStatus.COMPLETED, ReviewStatus.FAILED, ReviewStatus.SKIPPED])(
      'skips a review that is already %s',
      async (status) => {
        prisma.review.findUnique.mockResolvedValue(reviewRow({ status }));

        await processor.process(job());

        expect(run).not.toHaveBeenCalled();
        expect(prisma.review.update).not.toHaveBeenCalled();
      },
    );
  });
});
