-- Two things a production run needs that the first cut assumed away.
--
-- 1. Not every piece passes through every stage. A silver piece is never
--    plated; a plain band is never set. Stored as the stages a variant SKIPS,
--    so adding a stage to the workshop later applies to existing runs rather
--    than silently bypassing them.
--
-- 2. Pieces break. What a run intended to make and what survives are different
--    numbers, and it is the survivors that may be sold — so scrap is recorded
--    per incident and subtracted before anything reaches Shopify inventory.

-- AlterTable
ALTER TABLE "BatchVariant" ADD COLUMN "skipStages" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "BatchVariant" SET "skipStages" = ARRAY[]::TEXT[] WHERE "skipStages" IS NULL;
ALTER TABLE "BatchVariant" ALTER COLUMN "skipStages" SET NOT NULL;

-- CreateTable
CREATE TABLE "BatchScrap" (
    "id" TEXT NOT NULL,
    "batchVariantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "stage" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatchScrap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BatchScrap_batchVariantId_idx" ON "BatchScrap"("batchVariantId");

-- AddForeignKey
ALTER TABLE "BatchScrap" ADD CONSTRAINT "BatchScrap_batchVariantId_fkey" FOREIGN KEY ("batchVariantId") REFERENCES "BatchVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
