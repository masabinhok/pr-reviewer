import { Injectable } from '@nestjs/common';
import type {
  ProposedFinding,
  ReviewContext,
  Reviewer,
  ReviewerResult,
} from './reviewer.js';

interface Rule {
  test: RegExp;
  severity: ProposedFinding['severity'];
  category: string;
  summary: string;
  whyItBreaks: string;
  suggestedFix: string;
}

/**
 * Three deliberately dumb rules, each looking only at lines the PR *adds*. The point is
 * not the review — it is to give every step after the reviewer (validation, fingerprints,
 * storage, the Check Run summary) real findings to handle before the agent exists.
 */
const RULES: Rule[] = [
  {
    test: /\bdebugger\s*;?/,
    severity: 'medium',
    category: 'correctness',
    summary: 'A `debugger` statement is left in.',
    whyItBreaks:
      'Whenever this code runs with an inspector attached — a browser with devtools open, `node --inspect` — execution stops here until someone resumes it.',
    suggestedFix: 'Remove the `debugger` statement.',
  },
  {
    test: /\bconsole\.log\s*\(/,
    severity: 'low',
    category: 'debugging',
    summary: '`console.log` is left in.',
    whyItBreaks:
      'Every call writes to stdout in production, adding noise to the logs and possibly printing values that should not be logged.',
    suggestedFix:
      'Remove it, or use the application logger at an appropriate level.',
  },
  {
    test: /\/\/\s*TODO\b|\/\*\s*TODO\b|#\s*TODO\b/,
    severity: 'low',
    category: 'maintainability',
    summary: 'A new TODO is added.',
    whyItBreaks:
      'The TODO marks work this change leaves undone; once merged it is easy to forget, and the behaviour it describes stays missing.',
    suggestedFix:
      'Do the work in this PR, or track it in an issue and link it here.',
  },
];

@Injectable()
export class StubReviewer implements Reviewer {
  async review({ files }: ReviewContext): Promise<ReviewerResult> {
    const findings: ProposedFinding[] = [];

    for (const file of files) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.kind !== 'add') continue;
          for (const rule of RULES) {
            if (!rule.test.test(line.content)) continue;
            findings.push({
              file: file.path,
              line: line.newLine!,
              side: 'RIGHT',
              severity: rule.severity,
              category: rule.category,
              summary: rule.summary,
              whyItBreaks: rule.whyItBreaks,
              suggestedFix: rule.suggestedFix,
            });
          }
        }
      }
    }

    return { findings };
  }
}
