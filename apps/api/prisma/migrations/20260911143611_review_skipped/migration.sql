-- AlterEnum
ALTER TYPE "ReviewStatus" ADD VALUE 'SKIPPED';

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "skipReason" TEXT;
