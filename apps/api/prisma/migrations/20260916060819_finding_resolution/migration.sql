-- CreateEnum
CREATE TYPE "ResolvedBy" AS ENUM ('APP', 'PERSON');

-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedBy" "ResolvedBy";

