import { Prisma, type PrismaClient } from '../generated/prisma/client.js';

/**
 * Real review history, carried from a local database into the hosted demo's: `demo:export`
 * writes it, `demo:seed` loads it. Nothing in it is made up or re-dated.
 */
export type DemoReview = Prisma.ReviewGetPayload<{
  include: { findings: { include: { feedbacks: true } } };
}>;

export interface DemoData {
  exportedAt: Date;
  repos: { githubId: bigint; fullName: string; reviews: DemoReview[] }[];
}

export const DEMO_DATA_PATH = new URL(
  '../../prisma/demo/data.json',
  import.meta.url,
);

/** JSON has no Date or BigInt; both are tagged so `parseDemo` gets the same values back. */
export function stringifyDemo(data: DemoData): string {
  return (
    JSON.stringify(
      data,
      function (this: Record<string, unknown>, key, value: unknown) {
        const raw = this[key];
        if (raw instanceof Date) return { $date: raw.toISOString() };
        if (typeof value === 'bigint') return { $bigint: value.toString() };
        return value;
      },
      2,
    ) + '\n'
  );
}

export function parseDemo(text: string): DemoData {
  return JSON.parse(text, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const tagged = value as Record<string, unknown>;
      const keys = Object.keys(tagged);
      if (keys.length === 1 && typeof tagged.$date === 'string')
        return new Date(tagged.$date);
      if (keys.length === 1 && typeof tagged.$bigint === 'string')
        return BigInt(tagged.$bigint);
    }
    return value;
  }) as DemoData;
}

/** Anything that looks like a credential. The export refuses to write a file containing one. */
export const SECRET_SHAPE =
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-ant-|-----BEGIN [A-Z ]*PRIVATE KEY)/;

/**
 * Loads the history under the target database's own repo rows, matched by GitHub id: the
 * App must already be installed on a repo for its history to land. Upserts by id, so running
 * it again changes nothing.
 */
export async function seedDemo(
  prisma: PrismaClient,
  data: DemoData,
): Promise<{ seeded: string[]; skipped: string[] }> {
  const seeded: string[] = [];
  const skipped: string[] = [];

  for (const repo of data.repos) {
    const target = await prisma.repo.findUnique({
      where: { githubId: repo.githubId },
    });
    if (!target) {
      skipped.push(repo.fullName);
      continue;
    }

    const findings = repo.reviews.flatMap((r) => r.findings);
    for (const { findings: _, agentResult, ...review } of repo.reviews) {
      const row = {
        ...review,
        repoId: target.id,
        agentResult: (agentResult ?? Prisma.DbNull) as Prisma.InputJsonValue,
      };
      await prisma.review.upsert({
        where: { id: review.id },
        create: row,
        update: row,
      });
    }
    // A finding can repeat one from an earlier review: every row first, then the links.
    for (const { feedbacks: _, repeatOfId: __, ...finding } of findings) {
      await prisma.finding.upsert({
        where: { id: finding.id },
        create: finding,
        update: finding,
      });
    }
    for (const { id, repeatOfId } of findings) {
      if (repeatOfId)
        await prisma.finding.update({ where: { id }, data: { repeatOfId } });
    }
    for (const feedback of findings.flatMap((f) => f.feedbacks)) {
      await prisma.feedback.upsert({
        where: { id: feedback.id },
        create: feedback,
        update: feedback,
      });
    }
    seeded.push(`${repo.fullName}: ${repo.reviews.length} reviews`);
  }
  return { seeded, skipped };
}
