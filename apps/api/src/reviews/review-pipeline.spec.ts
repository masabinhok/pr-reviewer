import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import { ReviewPipeline } from './review-pipeline.js';
import type { ReviewTarget } from './review.processor.js';
import type {
  GithubApiService,
  PullRequestFile,
} from '../github/github-api.service.js';
import { StubReviewer } from '../reviewer/stub-reviewer.js';
import type { Reviewer } from '../reviewer/reviewer.js';
import { Severity } from '../generated/prisma/client.js';
import type { ReviewerResultStore } from './reviewer-result.store.js';
import type { ReviewerResult } from '../reviewer/reviewer.js';

// A real PR, as GitHub returned it: the file list and the SHA-pinned diff.
const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../test/fixtures/diffs/${name}`, import.meta.url),
    ),
    'utf8',
  );
const DIFF = fixture('diff-shapes.diff');
const FILES = JSON.parse(
  fixture('diff-shapes.files.json'),
) as PullRequestFile[];

const target: ReviewTarget = {
  reviewId: 'rev-1',
  installationId: 160831076n,
  repo: 'masabinhok/pr-reviewer-testbed',
  prNumber: 3,
  baseSha: 'f17b224',
  headSha: 'bc26a45',
};

describe('ReviewPipeline', () => {
  let github: {
    listPullRequestFiles: ReturnType<typeof vi.fn>;
    getDiff: ReturnType<typeof vi.fn>;
    getPullRequest: ReturnType<typeof vi.fn>;
  };

  let store: { load: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };

  const pipeline = (reviewer: Reviewer = new StubReviewer()) =>
    new ReviewPipeline(
      github as unknown as GithubApiService,
      reviewer,
      store as unknown as ReviewerResultStore,
    );

  beforeEach(() => {
    github = {
      listPullRequestFiles: vi.fn().mockResolvedValue(FILES),
      getDiff: vi.fn().mockResolvedValue(DIFF),
      getPullRequest: vi
        .fn()
        .mockResolvedValue({ title: 'Diff shapes', body: null }),
    };
    store = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('reviews only what survives both filters, and says why everything else was skipped', async () => {
    const outcome = await pipeline().run(target);

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.reviewed).toEqual([
      'src/auth.ts',
      'src/helpers.ts',
      'src/new-feature.ts',
    ]);
    expect(outcome.skipped).toEqual([
      { path: 'legacy/remove-me.ts', reason: 'removed' },
      { path: 'package-lock.json', reason: 'lockfile' },
      { path: 'assets/logo.png', reason: 'binary' },
      { path: 'docs/new name.md', reason: 'no-changes' },
      { path: 'src/config.ts', reason: 'no-changes' },
    ]);
  });

  it('fetches the diff by the review’s SHAs, never by PR number', async () => {
    await pipeline().run(target);

    expect(github.getDiff).toHaveBeenCalledWith(
      160831076n,
      'masabinhok/pr-reviewer-testbed',
      'f17b224',
      'bc26a45',
    );
  });

  it('returns the stub reviewer’s findings, validated and fingerprinted', async () => {
    const outcome = await pipeline().run(target);
    if (outcome.kind !== 'completed') throw new Error(outcome.kind);

    expect(outcome.findings.map((f) => [f.path, f.line, f.severity])).toEqual([
      ['src/auth.ts', 26, Severity.LOW],
      ['src/helpers.ts', 10, Severity.LOW],
      ['src/new-feature.ts', 2, Severity.MEDIUM],
    ]);
    expect(
      outcome.findings.every((f) => /^[0-9a-f]{64}$/.test(f.fingerprint)),
    ).toBe(true);
  });

  it('gives the reviewer only the files it may comment on, and the PR’s metadata', async () => {
    const reviewer = { review: vi.fn().mockResolvedValue({ findings: [] }) };

    await pipeline(reviewer).run(target);

    const context = reviewer.review.mock.calls[0][0];
    expect(context.files.map((f: { path: string }) => f.path)).toEqual([
      'src/auth.ts',
      'src/helpers.ts',
      'src/new-feature.ts',
    ]);
    expect(context).toMatchObject({
      title: 'Diff shapes',
      body: '',
      headSha: 'bc26a45',
      prNumber: 3,
      installationId: 160831076n,
    });
    // The lockfile was filtered out, so a finding on it would not be commentable.
    expect(context.lines.canComment('package-lock.json', 4, 'RIGHT')).toBe(
      false,
    );
  });

  it('drops a finding the reviewer places outside the diff', async () => {
    const reviewer = {
      review: vi.fn().mockResolvedValue({
        findings: [
          {
            file: 'src/auth.ts',
            line: 21,
            side: 'RIGHT',
            severity: 'high',
            category: 'x',
            summary: 's',
            whyItBreaks: 'w',
          },
        ],
      }),
    };

    const outcome = await pipeline(reviewer).run(target);

    expect(outcome.kind === 'completed' && outcome.findings).toEqual([]);
  });

  describe('never paying the reviewer twice', () => {
    const run = {
      model: 'claude-opus-5',
      outcome: 'submitted',
      turns: 3,
      toolCalls: 2,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 0,
        costUsd: 0.01,
      },
    };

    it('stores the reviewer’s answer as soon as it arrives', async () => {
      const answer: ReviewerResult = { findings: [], run };
      const reviewer = { review: vi.fn().mockResolvedValue(answer) };

      const outcome = await pipeline(reviewer).run(target);

      expect(store.save).toHaveBeenCalledWith('rev-1', answer);
      expect(outcome.kind === 'completed' && outcome.reviewer).toEqual(run);
    });

    // The retry after a failure *after* the agent answered — completing the Check Run,
    // writing findings — must not call the agent again.
    it('reuses a stored answer instead of calling the reviewer again', async () => {
      store.load.mockResolvedValue({
        findings: [
          {
            file: 'src/auth.ts',
            line: 26,
            side: 'RIGHT',
            severity: 'low',
            category: 'debugging',
            summary: 's',
            whyItBreaks: 'w',
          },
        ],
        run,
      });
      const reviewer = { review: vi.fn() };

      const outcome = await pipeline(reviewer).run(target);

      expect(reviewer.review).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
      expect(github.getPullRequest).not.toHaveBeenCalled();
      // The stored answer still goes through validation.
      expect(
        outcome.kind === 'completed' && outcome.findings.map((f) => f.line),
      ).toEqual([26]);
    });

    it('does not store anything when the reviewer throws', async () => {
      const reviewer = {
        review: vi.fn().mockRejectedValue(new Error('agent unreachable')),
      };

      await expect(pipeline(reviewer).run(target)).rejects.toThrow(
        'agent unreachable',
      );
      expect(store.save).not.toHaveBeenCalled();
    });
  });

  // Too large is decided on the file list alone, so the diff — which GitHub may refuse
  // for a PR this size — is never requested.
  it('skips a PR over the size limit without fetching its diff', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
    }));
    github.listPullRequestFiles.mockResolvedValue(many);

    const outcome = await pipeline().run(target);

    expect(outcome).toEqual({
      kind: 'skipped',
      reason: '51 files to review, over the limit of 50',
      skipped: [],
    });
    expect(github.getDiff).not.toHaveBeenCalled();
  });
});
