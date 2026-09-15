-- DropIndex
DROP INDEX "Finding_anchor_idx";

-- AlterTable
ALTER TABLE "Finding" DROP COLUMN "anchor",
ADD COLUMN     "anchors" TEXT[];

-- CreateIndex
CREATE INDEX "Finding_anchors_idx" ON "Finding" USING GIN ("anchors");
