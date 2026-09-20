import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Fixture } from './fixture.js';
import type { ProposedFinding, ReviewContext, Reviewer, ReviewerResult } from '../reviewer/reviewer.js';
import { reviewFixture } from './review-fixture.js';

// A committed fixture, reviewed by a scripted reviewer: what reaches the numbers is what the
// production validation and posting bar let through.
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../evals/fixtures/cookie-maxage-zero.json', import.meta.url)), 'utf8'),
) as Fixture;

function proposed(overrides: Partial<ProposedFinding>): ProposedFinding {
  return {
    file: 'index.js',
    line: 17,
    side: 'RIGHT',
    severity: 'high',
    category: 'correctness',
    summary: 'maxAge 0 is ignored.',
    whyItBreaks: 'serialize("a", "b", { maxAge: 0 }) sets no Max-Age.',
    verification: { verdict: 'confirmed', reason: 'The truthiness check drops 0.', demotedFrom: null },
    ...overrides,
  };
}

function scripted(answer: ReviewerResult | Error) {
  const seen: ReviewContext[] = [];
  const reviewer: Reviewer = {
    review: async (context) => {
      seen.push(context);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { reviewer, seen };
}

let clock = 0;
const now = () => (clock += 30_000);

describe('reviewFixture', () => {
  it("sends the fixture's request as it is, with no installation for a public repository", async () => {
    const { reviewer, seen } = scripted({ findings: [] });

    await reviewFixture(reviewer, fixture, 1, { bar: 'HIGH', installationId: null, now });

    expect(seen[0]).toMatchObject({ ...fixture.request, installationId: null });
  });

  it('keeps what validation keeps, and marks what meets the posting bar', async () => {
    const { reviewer } = scripted({
      findings: [
        proposed({}),
        proposed({ line: 19, severity: 'low', summary: 'Style.' }),
        proposed({ line: 400, summary: 'Not in the diff.' }),
        proposed({ line: 18, whyItBreaks: ' ', summary: 'No failure scenario.' }),
      ],
      dropped: [{ finding: proposed({ line: 20 }), reason: 'The code handles it.' }],
      run: {
        model: 'pr-reviewer:qwen2.5-7b',
        outcome: 'submitted',
        turns: 3,
        toolCalls: 2,
        verifyCalls: 3,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, costUsd: 0 },
      },
    });

    const result = await reviewFixture(reviewer, fixture, 2, { bar: 'HIGH', installationId: null, now });

    expect(result).toMatchObject({
      fixture: 'cookie-maxage-zero',
      run: 2,
      kind: 'bug',
      error: null,
      seconds: 30,
      model: 'pr-reviewer:qwen2.5-7b',
      tokensIn: 115,
      tokensOut: 50,
      refuted: 1,
      invalid: 2,
    });
    // Kept so a later run can ask whether the second look is dropping real bugs.
    expect(result.refutedFindings).toEqual([
      { path: 'index.js', line: 20, side: 'RIGHT', severity: 'high', summary: 'maxAge 0 is ignored.', reason: 'The code handles it.' },
    ]);
    expect(result.findings.map((f) => [f.line, f.severity, f.posted, f.verdict])).toEqual([
      [17, 'HIGH', true, 'CONFIRMED'],
      [19, 'LOW', false, 'CONFIRMED'],
    ]);
  });

  it('a lower bar posts more', async () => {
    const { reviewer } = scripted({ findings: [proposed({ severity: 'low' })] });

    const result = await reviewFixture(reviewer, fixture, 1, { bar: 'LOW', installationId: null, now });

    expect(result.findings[0].posted).toBe(true);
  });

  it('records a failed review with its error, instead of losing the fixture', async () => {
    const { reviewer } = scripted(new Error('agent answered 503 for x: Ollama unavailable, retry later'));

    const result = await reviewFixture(reviewer, fixture, 1, { bar: 'HIGH', installationId: 7n, now });

    expect(result).toMatchObject({ error: 'agent answered 503 for x: Ollama unavailable, retry later', findings: [], seconds: 30 });
  });
});
