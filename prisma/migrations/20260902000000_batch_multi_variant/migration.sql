-- A batch was originally a run of ONE product variant. It is now a run that
-- holds MANY variants — a casting tree carries rings, pendants and studs
-- together — so the per-variant columns move off Batch onto a new BatchVariant
-- table, and order lines hang off that instead of off the batch directly.
--
--   before:  Batch(variant, planned) ── BatchItem
--   after:   Batch(name) ── BatchVariant(variant, planned) ── BatchItem
--
-- Written as a transform rather than a drop-and-recreate so existing runs
-- survive: each old batch becomes a run containing exactly one variant, which
-- is what it always was.

-- 1. A run needs a name of its own, since it is no longer identified by the
--    single product it made. Existing runs take their old product's title.
ALTER TABLE "Batch" ADD COLUMN "name" TEXT;
UPDATE "Batch" SET "name" = COALESCE(NULLIF("productTitle", ''), 'Run');
ALTER TABLE "Batch" ALTER COLUMN "name" SET NOT NULL;

-- 2. The new per-variant table.
CREATE TABLE "BatchVariant" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "sku" TEXT,
    "imageUrl" TEXT,
    "plannedQuantity" INTEGER NOT NULL,
    "inventoryDelta" INTEGER,

    CONSTRAINT "BatchVariant_pkey" PRIMARY KEY ("id")
);

-- 3. One variant row per existing batch. The id is derived from the batch id
--    so step 4 can re-point that batch's items without a temporary mapping.
INSERT INTO "BatchVariant" (
    "id", "batchId", "productId", "productTitle", "variantId", "variantTitle",
    "sku", "imageUrl", "plannedQuantity", "inventoryDelta"
)
SELECT
    'bv_' || "id", "id", "productId", "productTitle", "variantId", "variantTitle",
    "sku", "imageUrl", "plannedQuantity", "inventoryDelta"
FROM "Batch";

-- 4. Order lines now belong to a variant within the run, not to the run.
ALTER TABLE "BatchItem" ADD COLUMN "batchVariantId" TEXT;
UPDATE "BatchItem" SET "batchVariantId" = 'bv_' || "batchId";
ALTER TABLE "BatchItem" ALTER COLUMN "batchVariantId" SET NOT NULL;

ALTER TABLE "BatchItem" DROP CONSTRAINT "BatchItem_batchId_fkey";
DROP INDEX "BatchItem_batchId_lineItemId_key";
ALTER TABLE "BatchItem" DROP COLUMN "batchId";

-- 5. Drop what has moved to BatchVariant.
DROP INDEX "Batch_shop_variantId_status_idx";
ALTER TABLE "Batch"
    DROP COLUMN "productId",
    DROP COLUMN "productTitle",
    DROP COLUMN "variantId",
    DROP COLUMN "variantTitle",
    DROP COLUMN "sku",
    DROP COLUMN "imageUrl",
    DROP COLUMN "plannedQuantity",
    DROP COLUMN "inventoryDelta";

-- 6. Constraints and indexes for the new shape.
CREATE INDEX "BatchVariant_variantId_idx" ON "BatchVariant"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchVariant_batchId_variantId_key" ON "BatchVariant"("batchId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchItem_batchVariantId_lineItemId_key" ON "BatchItem"("batchVariantId", "lineItemId");

-- AddForeignKey
ALTER TABLE "BatchVariant" ADD CONSTRAINT "BatchVariant_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchItem" ADD CONSTRAINT "BatchItem_batchVariantId_fkey" FOREIGN KEY ("batchVariantId") REFERENCES "BatchVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
