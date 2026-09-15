-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "anchor" TEXT,
ADD COLUMN     "repeatOfId" TEXT;

-- CreateIndex
CREATE INDEX "Finding_anchor_idx" ON "Finding"("anchor");

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_repeatOfId_fkey" FOREIGN KEY ("repeatOfId") REFERENCES "Finding"("id") ON DELETE SET NULL ON UPDATE CASCADE;
