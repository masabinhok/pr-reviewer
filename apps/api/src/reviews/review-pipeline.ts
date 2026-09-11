import { Inject, Injectable, Logger } from '@nestjs/common';
import { GithubApiService } from '../github/github-api.service.js';
import { filterDiffFiles, filterFileList } from '../filters/review-filter.js';
import { parseDiff } from '../diff/parse-diff.js';
import { LineMap } from '../diff/line-map.js';
import { REVIEWER, type Reviewer } from '../reviewer/reviewer.js';
import { validateFindings } from '../reviewer/validate-findings.js';
import type { ReviewOutcome } from './review-outcome.js';
import type { ReviewTarget } from './review.processor.js';

/**
 * One review, start to finish, as data: list the files, filter, fetch and parse the diff,
 * filter again, run the reviewer, validate what it proposes. It reads from GitHub and
 * returns an outcome; it writes nothing — the worker owns the Review row and the Check
 * Run, and settles both from what this returns.
 */
@Injectable()
export class ReviewPipeline {
  private readonly logger = new Logger(ReviewPipeline.name);

  constructor(
    private readonly github: GithubApiService,
    @Inject(REVIEWER) private readonly reviewer: Reviewer,
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

    const pr = await this.github.getPullRequest(installationId, repo, prNumber);
    const proposed = await this.reviewer.review({
      repo,
      prNumber,
      title: pr.title,
      body: pr.body ?? '',
      baseSha,
      headSha,
      files: parsed.kept,
      lines,
    });

    const { accepted, dropped } = validateFindings(proposed, lines);
    for (const { finding, reason } of dropped) {
      // Not an error in the review, but a bug in the reviewer worth seeing.
      this.logger.warn(`review ${reviewId}: dropped a finding at ${finding.file}:${finding.line} ${finding.side} (${reason})`);
    }

    return {
      kind: 'completed',
      reviewed: parsed.kept.map((f) => f.path),
      skipped: [...listed.skipped, ...parsed.skipped],
      findings: accepted,
    };
  }
}
