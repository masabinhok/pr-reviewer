import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { feedbackRate } from '../feedback/feedback-rate.js';
import {
  FeedbackSignal,
  FindingStatus,
  Prisma,
  ResolvedBy,
  ReviewStatus,
  Severity,
  Verdict,
} from '../generated/prisma/client.js';
import type { ReviewerResult } from '../reviewer/reviewer.js';
import type {
  FindingDetail,
  InstallationSummary,
  Overview,
  ReviewDetail,
  ReviewPage,
  ReviewSummary,
} from './dashboard.types.js';

const DAYS = 30;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;

const reviewSelect = {
  id: true,
  prNumber: true,
  baseSha: true,
  headSha: true,
  status: true,
  startedAt: true,
  completedAt: true,
  error: true,
  skipReason: true,
  checkRunId: true,
  agentResult: true,
  repo: { select: { fullName: true } },
  _count: { select: { findings: true } },
} satisfies Prisma.ReviewSelect;

type ReviewRow = Prisma.ReviewGetPayload<{ select: typeof reviewSelect }>;

/**
 * The dashboard's reads. Nothing here writes. Numbers that also exist elsewhere — the
 * feedback rate — come from the one definition of them, not a second copy.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(now = new Date()): Promise<Overview> {
    const since = startOfDay(new Date(now.getTime() - (DAYS - 1) * DAY));
    const [
      statuses,
      severities,
      posted,
      repeats,
      resolved,
      verdicts,
      feedback,
      answers,
      recent,
      postedRecent,
    ] = await Promise.all([
      this.prisma.review.groupBy({ by: ['status'], _count: true }),
      this.prisma.finding.groupBy({ by: ['severity'], _count: true }),
      this.prisma.finding.count({ where: { githubCommentId: { not: null } } }),
      this.prisma.finding.count({ where: { repeatOfId: { not: null } } }),
      this.prisma.finding.groupBy({
        by: ['resolvedBy'],
        where: { status: FindingStatus.RESOLVED },
        _count: true,
      }),
      this.prisma.finding.groupBy({
        by: ['verdict'],
        where: { verdict: { not: null } },
        _count: true,
      }),
      feedbackRate(this.prisma),
      this.prisma.review.findMany({
        where: { agentResult: { not: Prisma.DbNull } },
        select: { agentResult: true, startedAt: true, completedAt: true },
      }),
      this.prisma.review.findMany({
        where: { startedAt: { gte: since } },
        select: { startedAt: true, _count: { select: { findings: true } } },
      }),
      this.prisma.finding.findMany({
        where: {
          githubCommentId: { not: null },
          review: { startedAt: { gte: since } },
        },
        select: { review: { select: { startedAt: true } } },
      }),
    ]);

    const byStatus = (s: ReviewStatus) =>
      statuses.find((r) => r.status === s)?._count ?? 0;
    const bySeverity = (s: Severity) =>
      severities.find((r) => r.severity === s)?._count ?? 0;
    const byVerdict = (v: Verdict) =>
      verdicts.find((r) => r.verdict === v)?._count ?? 0;
    const byResolver = (r: ResolvedBy) =>
      resolved.find((x) => x.resolvedBy === r)?._count ?? 0;

    const runs = answers
      .map((a) => ({
        answer: a.agentResult as unknown as ReviewerResult | null,
        seconds: seconds(a.startedAt, a.completedAt),
      }))
      .filter((a) => a.answer?.run);
    const sum = (f: (r: (typeof runs)[number]) => number) =>
      runs.reduce((total, r) => total + f(r), 0);
    const timed = runs.filter((r) => r.seconds !== null);

    const perDay = new Map<
      string,
      { day: string; reviews: number; findings: number; posted: number }
    >();
    for (let i = 0; i < DAYS; i++) {
      const day = dayKey(new Date(since.getTime() + i * DAY));
      perDay.set(day, { day, reviews: 0, findings: 0, posted: 0 });
    }
    for (const r of recent) {
      const entry = perDay.get(dayKey(r.startedAt));
      if (entry) {
        entry.reviews++;
        entry.findings += r._count.findings;
      }
    }
    for (const f of postedRecent) {
      const entry = perDay.get(dayKey(f.review.startedAt));
      if (entry) entry.posted++;
    }

    return {
      reviews: {
        total: statuses.reduce((t, r) => t + r._count, 0),
        completed: byStatus(ReviewStatus.COMPLETED),
        failed: byStatus(ReviewStatus.FAILED),
        skipped: byStatus(ReviewStatus.SKIPPED),
        inProgress:
          byStatus(ReviewStatus.PENDING) + byStatus(ReviewStatus.RUNNING),
      },
      findings: {
        total: severities.reduce((t, r) => t + r._count, 0),
        bySeverity: {
          high: bySeverity(Severity.HIGH),
          medium: bySeverity(Severity.MEDIUM),
          low: bySeverity(Severity.LOW),
        },
        posted,
        repeats,
        resolved: {
          byApp: byResolver(ResolvedBy.APP),
          byPerson: byResolver(ResolvedBy.PERSON),
        },
        verdicts: {
          confirmed: byVerdict(Verdict.CONFIRMED),
          unsure: byVerdict(Verdict.UNSURE),
          unverified: byVerdict(Verdict.UNVERIFIED),
        },
        droppedOnSecondLook: runs.reduce(
          (t, r) => t + (r.answer?.dropped?.length ?? 0),
          0,
        ),
      },
      feedback,
      agent: {
        reviews: runs.length,
        averageSeconds: timed.length
          ? Math.round(timed.reduce((t, r) => t + r.seconds!, 0) / timed.length)
          : null,
        averageTurns: runs.length
          ? round1(sum((r) => r.answer!.run!.turns) / runs.length)
          : null,
        tokensIn: sum((r) => tokensIn(r.answer!.run!.usage)),
        tokensOut: sum((r) => r.answer!.run!.usage.outputTokens),
        costUsd: sum((r) => r.answer!.run!.usage.costUsd ?? 0),
      },
      perDay: [...perDay.values()],
    };
  }

  async installations(): Promise<InstallationSummary[]> {
    const rows = await this.prisma.installation.findMany({
      orderBy: { accountLogin: 'asc' },
      include: {
        repos: {
          orderBy: { fullName: 'asc' },
          include: {
            _count: { select: { reviews: true } },
            reviews: {
              orderBy: { startedAt: 'desc' },
              take: 1,
              select: { startedAt: true },
            },
          },
        },
      },
    });
    return rows.map((i) => ({
      id: i.id,
      githubId: i.githubId,
      account: i.accountLogin,
      accountType: i.accountType,
      suspendedAt: i.suspendedAt,
      deletedAt: i.deletedAt,
      repos: i.repos.map((r) => ({
        id: r.id,
        fullName: r.fullName,
        private: r.private,
        deletedAt: r.deletedAt,
        reviews: r._count.reviews,
        lastReviewAt: r.reviews[0]?.startedAt ?? null,
      })),
    }));
  }

  /** Newest first. `cursor` is the last review ID of the previous page. */
  async reviews(query: {
    repo?: string;
    status?: string;
    cursor?: string;
    limit?: number;
  }): Promise<ReviewPage> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
    const status =
      query.status &&
      (Object.values(ReviewStatus) as string[]).includes(query.status)
        ? (query.status as ReviewStatus)
        : undefined;
    const rows = await this.prisma.review.findMany({
      where: {
        ...(query.repo ? { repo: { fullName: query.repo } } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: reviewSelect,
    });
    const page = rows.slice(0, limit);
    const posted = await this.postedCounts(page.map((r) => r.id));
    return {
      items: page.map((r) => summarise(r, posted.get(r.id) ?? 0)),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async review(id: string): Promise<ReviewDetail> {
    const row = await this.prisma.review.findUnique({
      where: { id },
      select: reviewSelect,
    });
    if (!row) throw new NotFoundException(`No review ${id}`);

    const findings = await this.prisma.finding.findMany({
      where: { reviewId: id },
      orderBy: [{ filePath: 'asc' }, { line: 'asc' }],
      include: { feedbacks: { select: { signal: true } } },
    });
    const repo = row.repo.fullName;
    const answer = row.agentResult as unknown as ReviewerResult | null;
    const { findings: _count, ...summary } = summarise(
      row,
      findings.filter((f) => f.githubCommentId !== null).length,
    );

    return {
      ...summary,
      baseSha: row.baseSha,
      checkRunUrl:
        row.checkRunId === null
          ? null
          : `https://github.com/${repo}/runs/${row.checkRunId}`,
      findings: findings.map((f): FindingDetail => ({
        id: f.id,
        path: f.filePath,
        line: f.line,
        side: f.side,
        severity: f.severity,
        category: f.category,
        summary: f.summary,
        whyItBreaks: f.whyItBreaks,
        suggestedFix: f.suggestedFix,
        verdict: f.verdict,
        verdictReason: f.verdictReason,
        demotedFrom: f.demotedFrom,
        status: f.status,
        resolvedBy: f.resolvedBy,
        resolvedAt: f.resolvedAt,
        posted: f.githubCommentId !== null,
        commentUrl:
          f.githubCommentId === null
            ? null
            : `https://github.com/${repo}/pull/${row.prNumber}#discussion_r${f.githubCommentId}`,
        repeatOf: f.repeatOfId,
        feedback: {
          up: f.feedbacks.filter((x) => x.signal === FeedbackSignal.UP).length,
          down: f.feedbacks.filter((x) => x.signal === FeedbackSignal.DOWN)
            .length,
        },
      })),
      dropped: (answer?.dropped ?? []).map((d) => ({
        path: d.finding.file,
        line: d.finding.line,
        severity: d.finding.severity,
        summary: d.finding.summary,
        reason: d.reason,
      })),
    };
  }

  private async postedCounts(
    reviewIds: string[],
  ): Promise<Map<string, number>> {
    if (reviewIds.length === 0) return new Map();
    const rows = await this.prisma.finding.groupBy({
      by: ['reviewId'],
      where: { reviewId: { in: reviewIds }, githubCommentId: { not: null } },
      _count: true,
    });
    return new Map(rows.map((r) => [r.reviewId, r._count]));
  }
}

function summarise(r: ReviewRow, posted: number): ReviewSummary {
  const answer = r.agentResult as unknown as ReviewerResult | null;
  const run = answer?.run;
  return {
    id: r.id,
    repo: r.repo.fullName,
    prNumber: r.prNumber,
    prUrl: `https://github.com/${r.repo.fullName}/pull/${r.prNumber}`,
    headSha: r.headSha,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    seconds: seconds(r.startedAt, r.completedAt),
    error: r.error,
    skipReason: r.skipReason,
    model: run?.model ?? null,
    outcome: run?.outcome ?? null,
    turns: run?.turns ?? null,
    toolCalls: run?.toolCalls ?? null,
    verifyCalls: run?.verifyCalls ?? null,
    tokensIn: run ? tokensIn(run.usage) : null,
    tokensOut: run?.usage.outputTokens ?? null,
    costUsd: run?.usage.costUsd ?? null,
    findings: r._count.findings,
    posted,
    droppedOnSecondLook: answer?.dropped?.length ?? 0,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const startOfDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const round1 = (n: number) => Math.round(n * 10) / 10;
const seconds = (start: Date, end: Date | null) =>
  end ? Math.round((end.getTime() - start.getTime()) / 1000) : null;
const tokensIn = (u: {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}) => u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
