import { LineMap } from '../diff/line-map.js';
import type { Severity } from '../generated/prisma/client.js';
import type { Reviewer } from '../reviewer/reviewer.js';
import { validateFindings } from '../reviewer/validate-findings.js';
import { meetsPostingBar } from '../reviews/review-publisher.js';
import type { Fixture } from './fixture.js';
import type { FixtureResult } from './score.js';

/**
 * One review of one fixture through the production path: the same Reviewer the worker uses,
 * the same validation, the same posting bar. Nothing is stored or posted; what would have been
 * is recorded.
 *
 * Dedupe across pushes has nothing to do here — every fixture is a first push — and within a
 * review it is `validateFindings`' one-finding-per-line rule, which runs.
 *
 * A failed review is a result too, with its error: its bugs count as missed rather than the
 * fixture vanishing from the numbers.
 */
export async function reviewFixture(
  reviewer: Reviewer,
  fixture: Fixture,
  run: number,
  options: { bar: Severity; installationId: bigint | null; now?: () => number },
): Promise<FixtureResult> {
  const now = options.now ?? Date.now;
  const lines = new LineMap(fixture.request.files);
  const base = { fixture: fixture.id, run, kind: fixture.kind, split: fixture.split };
  const started = now();

  try {
    const answer = await reviewer.review({ ...fixture.request, installationId: options.installationId, lines });
    const seconds = (now() - started) / 1000;
    const { accepted, dropped } = validateFindings(answer.findings, lines);
    const u = answer.run?.usage;
    return {
      ...base,
      seconds,
      error: null,
      model: answer.run?.model ?? null,
      outcome: answer.run?.outcome ?? null,
      turns: answer.run?.turns ?? 0,
      toolCalls: answer.run?.toolCalls ?? 0,
      verifyCalls: answer.run?.verifyCalls ?? 0,
      tokensIn: u ? u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens : 0,
      tokensOut: u?.outputTokens ?? 0,
      findings: accepted.map((f) => ({
        path: f.path,
        line: f.line,
        side: f.side,
        severity: f.severity,
        category: f.category,
        summary: f.summary,
        whyItBreaks: f.whyItBreaks,
        verdict: f.verdict,
        demotedFrom: f.demotedFrom,
        posted: meetsPostingBar(f.severity, options.bar),
      })),
      refuted: answer.dropped?.length ?? 0,
      invalid: dropped.length,
    };
  } catch (e) {
    return {
      ...base,
      seconds: (now() - started) / 1000,
      error: e instanceof Error ? e.message : String(e),
      model: null,
      outcome: null,
      turns: 0,
      toolCalls: 0,
      verifyCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      findings: [],
      refuted: 0,
      invalid: 0,
    };
  }
}
