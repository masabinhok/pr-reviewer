import type { CheckConclusion, CheckRunOutput } from '../github/github-api.service.js';
import type { FindingSummary, ReviewOutcome } from './review-outcome.js';
import type { DroppedFinding, ReviewerRun } from '../reviewer/reviewer.js';
import type { Publication } from './review-publisher.js';
import { Severity } from '../generated/prisma/client.js';

export const CHECK_RUN_NAME = 'pr-reviewer';

// GitHub rejects a Check Run summary over 65535 characters; stay well clear of it.
const MAX_SUMMARY = 60_000;
const MAX_FINDING_ROWS = 50;

const SEVERITY_ORDER: Severity[] = [Severity.HIGH, Severity.MEDIUM, Severity.LOW];

export type CheckResult =
  | ReviewOutcome
  | { kind: 'failed'; error: string; attempts: number };

/**
 * Turns how a review ended into the Check Run GitHub shows on the PR:
 *
 * | outcome   | conclusion | why                                                   |
 * |-----------|------------|-------------------------------------------------------|
 * | completed | success    | the review ran; findings are its content, not a fail |
 * | skipped   | skipped    | deliberately not reviewed — too large                 |
 * | failed    | failure    | the review itself broke, after every retry            |
 *
 * A pure function, so every wording and edge case is testable without GitHub.
 */
export function renderCheck(
  result: CheckResult,
  headSha: string,
  publication?: Publication,
  resolved = 0,
): { conclusion: CheckConclusion; output: CheckRunOutput } {
  const at = `\`${headSha.slice(0, 7)}\``;

  if (result.kind === 'failed') {
    return {
      conclusion: 'failure',
      output: {
        title: 'Review failed',
        summary: cap(
          `The review of ${at} failed after ${result.attempts} attempt${result.attempts === 1 ? '' : 's'}.\n\n` +
            `\`\`\`\n${result.error}\n\`\`\``,
        ),
      },
    };
  }

  if (result.kind === 'skipped') {
    return {
      conclusion: 'skipped',
      output: {
        title: `Not reviewed: ${result.reason}`,
        summary: cap(
          `This pull request was too large to review at ${at}: ${result.reason}.\n\n` +
            `Smaller pull requests get reviewed; lockfiles, generated and vendored files don't count toward the limit.` +
            skippedSection(result.skipped),
        ),
      },
    };
  }

  const { reviewed, findings, skipped, reviewer, dropped = [] } = result;
  const files = `${reviewed.length} file${reviewed.length === 1 ? '' : 's'}`;
  const count = `${findings.length} finding${findings.length === 1 ? '' : 's'}`;

  return {
    conclusion: 'success',
    output: {
      title: findings.length ? `${count} in ${files}` : `No findings in ${files}`,
      summary: cap(
        `Reviewed ${files} at ${at}.\n\n` +
          reviewerNote(reviewer) +
          publicationNote(publication, findings.length) +
          resolvedNote(resolved) +
          findingsSection(findings) +
          droppedSection(dropped) +
          skippedSection(skipped) +
          reviewerFooter(reviewer),
      ),
    },
  };
}

// When an agent run ended some way other than submitting, the findings may be partial or
// absent for reasons the author should know — say so above them.
const OUTCOME_NOTES: Record<string, string> = {
  refused: 'The reviewer declined to review this change, so there are no findings.',
  budget: 'The reviewer ran out of its turn budget before finishing; the findings may be incomplete.',
  'no-submission': 'The reviewer stopped without submitting a review, so there are no findings.',
  truncated: 'The reviewer hit its output limit before submitting a review, so there are no findings.',
};

function reviewerNote(run: ReviewerRun | undefined): string {
  const note = run && OUTCOME_NOTES[run.outcome];
  return note ? `> ${note}\n\n` : '';
}

const BARS: Record<Publication['minSeverity'], string> = {
  HIGH: 'high severity',
  MEDIUM: 'high and medium severity',
  LOW: 'every severity',
};

function publicationNote(publication: Publication | undefined, total: number): string {
  if (!publication || total === 0) return '';
  const bar = BARS[publication.minSeverity];
  const { repeated } = publication;
  const already = repeated
    ? ` ${repeated} ${repeated === 1 ? 'was' : 'were'} already commented on in an earlier review, so ${repeated === 1 ? 'it was' : 'they were'} not posted again.`
    : '';
  if (publication.posted === 0) {
    return repeated
      ? `Nothing new to post.${already}\n\n`
      : `None of these met the bar for a comment on the pull request (${bar}).\n\n`;
  }
  const comments = `${publication.posted} comment${publication.posted === 1 ? '' : 's'}`;
  const where = publication.url ? `[a review](${publication.url})` : 'a review';
  return `Posted ${comments} on the pull request in ${where}; ${bar} only.${already}\n\n`;
}

/** Comments from earlier reviews that this one retired, because their code is gone. */
function resolvedNote(resolved: number): string {
  if (resolved === 0) return '';
  const comments = `${resolved} earlier comment${resolved === 1 ? '' : 's'}`;
  return `Resolved ${comments}: the code ${resolved === 1 ? 'it pointed' : 'they pointed'} at has changed and this review did not find the problem again.\n\n`;
}

function reviewerFooter(run: ReviewerRun | undefined): string {
  if (!run) return '';
  const { usage } = run;
  const tokens = `${(usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens).toLocaleString('en-US')} in / ${usage.outputTokens.toLocaleString('en-US')} out`;
  const cost = usage.costUsd === null ? '' : ` · $${usage.costUsd.toFixed(2)}`;
  const checks = run.verifyCalls ? `, ${run.verifyCalls} check${run.verifyCalls === 1 ? '' : 's'}` : '';
  const turns = `${run.turns} turn${run.turns === 1 ? '' : 's'}, ${run.toolCalls} tool call${run.toolCalls === 1 ? '' : 's'}${checks}`;
  return `\n\n<sub>Reviewed by \`${run.model}\` in ${turns} · ${tokens} tokens${cost}</sub>`;
}

function findingsSection(findings: FindingSummary[]): string {
  if (findings.length === 0) return 'No findings.';

  const tally = SEVERITY_ORDER.map((s) => `${findings.filter((f) => f.severity === s).length} ${s.toLowerCase()}`).join(' · ');
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const rows = sorted
    .slice(0, MAX_FINDING_ROWS)
    .map((f) => `| ${severityCell(f)} | ${code(`${f.path}:${f.line}`)} | ${cell(f.summary)} |`);
  const more = sorted.length > MAX_FINDING_ROWS ? `\n\n…and ${sorted.length - MAX_FINDING_ROWS} more.` : '';

  return `**Findings:** ${tally}\n\n| Severity | Where | Finding |\n|---|---|---|\n${rows.join('\n')}${more}`;
}

/** A finding the second look couldn't confirm was demoted; say what it was before. */
function severityCell(f: FindingSummary): string {
  const severity = f.severity.toLowerCase();
  return f.demotedFrom ? `${severity} (was ${f.demotedFrom.toLowerCase()}, not confirmed)` : severity;
}

function droppedSection(dropped: DroppedFinding[]): string {
  if (dropped.length === 0) return '';
  const rows = dropped
    .slice(0, MAX_FINDING_ROWS)
    .map(({ finding, reason }) => `| ${code(`${finding.file}:${finding.line}`)} | ${cell(finding.summary)} | ${cell(reason)} |`)
    .join('\n');
  const label = `${dropped.length} finding${dropped.length === 1 ? '' : 's'} dropped on a second look`;
  return `\n\n<details><summary>${label}</summary>\n\nThe reviewer proposed these; a separate check of each against the code refuted them.\n\n| Where | Finding | Why it was dropped |\n|---|---|---|\n${rows}\n\n</details>`;
}

function skippedSection(skipped: { path: string; reason: string }[]): string {
  if (skipped.length === 0) return '';
  const rows = skipped.map((s) => `| ${code(s.path)} | ${s.reason} |`).join('\n');
  const label = `${skipped.length} file${skipped.length === 1 ? '' : 's'} not reviewed`;
  return `\n\n<details><summary>${label}</summary>\n\n| File | Why |\n|---|---|\n${rows}\n\n</details>`;
}

/** A table cell: pipes would end the cell, newlines the row. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/** Inline code that survives a backtick in the text, inside a table cell. */
function code(text: string): string {
  const fence = text.includes('`') ? '``' : '`';
  return `${fence}${cell(text)}${fence}`;
}

function cap(summary: string): string {
  return summary.length <= MAX_SUMMARY ? summary : `${summary.slice(0, MAX_SUMMARY)}\n\n…summary truncated.`;
}
