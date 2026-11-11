import type { PrismaService } from '../../src/prisma/prisma.service.js';

/** Empties every table the app writes. Only ever pointed at pr_reviewer_test. */
export async function truncateAll(prisma: PrismaService): Promise<void> {
  const database = await prisma.$queryRaw<
    { db: string }[]
  >`select current_database() as db`;
  if (database[0]?.db !== 'pr_reviewer_test') {
    throw new Error(
      `refusing to truncate "${database[0]?.db}" — e2e tests only run against pr_reviewer_test`,
    );
  }

  await prisma.$executeRawUnsafe(
    'TRUNCATE "Feedback", "Finding", "Review", "Repo", "Installation", "WebhookDelivery" RESTART IDENTITY CASCADE',
  );
}
