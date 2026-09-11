import type { CheckConclusion, CheckRunOutput } from '../github/github-api.service.js';
import type { FindingSummary, ReviewOutcome } from './review-outcome.js';
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
export function renderCheck(result: CheckResult, headSha: string): { conclusion: CheckConclusion; output: CheckRunOutput } {
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

  const { reviewed, findings, skipped } = result;
  const files = `${reviewed.length} file${reviewed.length === 1 ? '' : 's'}`;
  const count = `${findings.length} finding${findings.length === 1 ? '' : 's'}`;

  return {
    conclusion: 'success',
    output: {
      title: findings.length ? `${count} in ${files}` : `No findings in ${files}`,
      summary: cap(
        `Reviewed ${files} at ${at}.\n\n` + findingsSection(findings) + skippedSection(skipped),
      ),
    },
  };
}

function findingsSection(findings: FindingSummary[]): string {
  if (findings.length === 0) return 'No findings.';

  const tally = SEVERITY_ORDER.map((s) => `${findings.filter((f) => f.severity === s).length} ${s.toLowerCase()}`).join(' · ');
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const rows = sorted
    .slice(0, MAX_FINDING_ROWS)
    .map((f) => `| ${f.severity.toLowerCase()} | ${code(`${f.path}:${f.line}`)} | ${cell(f.summary)} |`);
  const more = sorted.length > MAX_FINDING_ROWS ? `\n\n…and ${sorted.length - MAX_FINDING_ROWS} more.` : '';

  return `**Findings:** ${tally}\n\n| Severity | Where | Finding |\n|---|---|---|\n${rows.join('\n')}${more}`;
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
