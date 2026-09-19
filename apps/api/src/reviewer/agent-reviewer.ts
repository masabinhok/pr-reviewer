import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { InstallationTokenService } from '../github/installation-token.service.js';
import type { FindingVerification, ProposedFinding, ReviewContext, Reviewer, ReviewerResult, ReviewerRun } from './reviewer.js';

/** What the agent answers — apps/agent/src/pr_agent/models.py, `ReviewResponse`. */
interface AgentResponse {
  findings: AgentFinding[];
  model: string;
  outcome: string;
  turns: number;
  toolCalls: number;
  usage: ReviewerRun['usage'];
  // Absent from an agent older than the second look; the API and agent deploy separately.
  dropped?: { finding: AgentFinding; reason: string }[];
  verifyCalls?: number;
}

type AgentFinding = Omit<ProposedFinding, 'suggestedFix' | 'verification'> & {
  suggestedFix: string | null;
  verification: FindingVerification | null;
};

/** Python's nulls become TypeScript's absent optionals. */
function toProposed({ suggestedFix, verification, ...f }: AgentFinding): ProposedFinding {
  return { ...f, suggestedFix: suggestedFix ?? undefined, verification: verification ?? undefined };
}

/**
 * The review agent (apps/agent), called over HTTP like any other dependency. It gets the
 * reviewable files, the PR's metadata and a fresh installation token, and answers with
 * findings — which then go through exactly the validation the stub's did.
 *
 * Errors are sorted by whether a retry could help, because a retry costs money:
 * - the agent's 503, a 5xx, a timeout or a network failure → a plain Error, and BullMQ retries;
 * - its 401 or 422 → UnrecoverableError: the request is wrong or the repository can't be
 *   reviewed, and asking again would only pay to get the same answer.
 */
@Injectable()
export class AgentReviewer implements Reviewer {
  private readonly logger = new Logger(AgentReviewer.name);
  private readonly url: string;
  private readonly secret: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService,
    private readonly tokens: InstallationTokenService,
  ) {
    // Fail at boot, not on the first pull request, when the agent is selected but unset.
    this.url = config.getOrThrow<string>('agent.url');
    this.secret = config.getOrThrow<string>('agent.sharedSecret');
    this.timeoutMs = config.getOrThrow<number>('agent.timeoutMs');
  }

  async review(context: ReviewContext): Promise<ReviewerResult> {
    const where = `${context.repo}#${context.prNumber}@${context.headSha.slice(0, 7)}`;
    const token = context.installationId === null ? undefined : await this.tokens.getToken(context.installationId);

    let response: Response;
    try {
      response = await fetch(`${this.url}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Secret': this.secret },
        body: JSON.stringify({
          repo: context.repo,
          prNumber: context.prNumber,
          title: context.title,
          body: context.body,
          baseSha: context.baseSha,
          headSha: context.headSha,
          // Left out of the JSON when undefined: the agent then reads a public repository.
          installationToken: token,
          files: context.files,
        }),
        // A review is many model turns; minutes, not seconds. Past this, give up and retry.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // Connection refused, DNS, timeout — the agent may simply be restarting.
      throw new Error(`agent unreachable for ${where}: ${e instanceof Error ? e.name : String(e)}`);
    }

    if (!response.ok) {
      const detail = await response
        .json()
        .then((b: { detail?: unknown }) => (typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail)))
        .catch(() => response.statusText);
      const message = `agent answered ${response.status} for ${where}: ${detail}`;
      if (response.status === 401 || response.status === 422 || response.status === 400) {
        throw new UnrecoverableError(message);
      }
      throw new Error(message);
    }

    const answer = (await response.json()) as AgentResponse;
    const dropped = answer.dropped ?? [];
    this.logger.log(
      `${where}: agent ${answer.outcome} after ${answer.turns} turn(s), ${answer.toolCalls} tool call(s), ` +
        `${answer.findings.length} finding(s), ${dropped.length} dropped on a second look` +
        (answer.usage.costUsd === null ? '' : `, $${answer.usage.costUsd.toFixed(4)}`),
    );

    return {
      findings: answer.findings.map(toProposed),
      dropped: dropped.map((d) => ({ finding: toProposed(d.finding), reason: d.reason })),
      run: {
        model: answer.model,
        outcome: answer.outcome,
        turns: answer.turns,
        toolCalls: answer.toolCalls,
        verifyCalls: answer.verifyCalls,
        usage: answer.usage,
      },
    };
  }
}
