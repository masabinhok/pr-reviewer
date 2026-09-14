-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('CONFIRMED', 'UNSURE', 'UNVERIFIED');

-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "demotedFrom" "Severity",
ADD COLUMN     "verdict" "Verdict",
ADD COLUMN     "verdictReason" TEXT;
