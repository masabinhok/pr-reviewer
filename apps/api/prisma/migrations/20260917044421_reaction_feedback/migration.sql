-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN     "reactedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "commentGoneAt" TIMESTAMP(3),
ADD COLUMN     "reactionsEtag" TEXT;

