import { Inject, Injectable, Logger } from '@nestjs/common';
import { GithubApiService } from '../github/github-api.service.js';
import { filterDiffFiles, filterFileList } from '../filters/review-filter.js';
import { parseDiff } from '../diff/parse-diff.js';
import { LineMap } from '../diff/line-map.js';
import { REVIEWER, type Reviewer } from '../reviewer/reviewer.js';
import { validateFindings } from '../reviewer/validate-findings.js';
import type { ReviewOutcome } from './review-outcome.js';
import type { ReviewTarget } from './review.processor.js';
import { ReviewerResultStore } from './reviewer-result.store.js';

/**
 * One review, start to finish, as data: list the files, filter, fetch and parse the diff,
 * filter again, run the reviewer, validate what it proposes. It reads from GitHub and
 * returns an outcome; the worker owns the Review row and the Check Run, and settles both
 * from what this returns. The single exception is the reviewer's answer, stored as soon as
 * it arrives — see ReviewerResultStore.
 */
@Injectable()
export class ReviewPipeline {
  private readonly logger = new Logger(ReviewPipeline.name);

  constructor(
    private readonly github: GithubApiService,
    @Inject(REVIEWER) private readonly reviewer: Reviewer,
    private readonly results: ReviewerResultStore,
  ) {}

  async run(target: ReviewTarget): Promise<ReviewOutcome> {
    const { installationId, repo, prNumber, baseSha, headSha, reviewId } = target;

    // Stage one filters on the file list, before the diff is fetched: GitHub refuses a
    // very large diff outright, so the size check has to come first.
    const files = await this.github.listPullRequestFiles(installationId, repo, prNumber);
    const listed = filterFileList(files);
    if (listed.tooLarge) {
      return { kind: 'skipped', reason: listed.tooLarge, skipped: listed.skipped };
    }

    // By SHA, never by PR number: the PR may have moved on since this review was queued.
    const diff = await this.github.getDiff(installationId, repo, baseSha, headSha);
    const parsed = filterDiffFiles(parseDiff(diff), new Set(listed.kept.map((f) => f.filename)));
    const lines = new LineMap(parsed.kept);

    // Never pay twice: a retry after the reviewer already answered reuses that answer.
    let answer = await this.results.load(reviewId);
    if (answer) {
      this.logger.log(`review ${reviewId}: reusing the reviewer's stored answer`);
    } else {
      const pr = await this.github.getPullRequest(installationId, repo, prNumber);
      answer = await this.reviewer.review({
        installationId,
        repo,
        prNumber,
        title: pr.title,
        body: pr.body ?? '',
        baseSha,
        headSha,
        files: parsed.kept,
        lines,
      });
      await this.results.save(reviewId, answer);
    }

    // Validated every time, stored answer or not: the check is cheap and deterministic.
    const { accepted, dropped } = validateFindings(answer.findings, lines);
    for (const { finding, reason } of dropped) {
      // Not an error in the review, but a bug in the reviewer worth seeing.
      this.logger.warn(`review ${reviewId}: dropped a finding at ${finding.file}:${finding.line} ${finding.side} (${reason})`);
    }

    return {
      kind: 'completed',
      reviewed: parsed.kept.map((f) => f.path),
      skipped: [...listed.skipped, ...parsed.skipped],
      findings: accepted,
      reviewer: answer.run,
    };
  }
}
