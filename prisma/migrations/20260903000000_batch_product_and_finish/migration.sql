-- A run used to be a set of VARIANTS with a quantity each. It is now a set of
-- PRODUCTS with a raw quantity each, plus an allocation across finishes that
-- is decided later.
--
-- The reason is physical: a gold-plated ring and a silver one are the same
-- object until the last step. Committing to "12 gold, 8 silver" at casting
-- time guesses at a decision nobody has to make until the pieces are polished.
--
--   before:  Batch ── BatchVariant(variant, planned) ── BatchItem
--                                                    └─ BatchScrap
--
--   after:   Batch ── BatchProduct(product, raw planned)
--                       ├─ BatchFinish(variant, quantity)
--                       ├─ BatchItem(lineItemId, variantId)
--                       └─ BatchScrap(variantId nullable)
--
-- Written as a transform so existing runs survive. Each old BatchVariant
-- becomes a product carrying exactly one finish — which is what it always
-- was — and where a run held two variants of the SAME product, they merge
-- into one product with two finishes and their quantities summed.

-- ── 1. New tables ─────────────────────────────────────────────────────────

CREATE TABLE "BatchProduct" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "imageUrl" TEXT,
    "plannedQuantity" INTEGER NOT NULL,
    "splitStage" TEXT DEFAULT 'PLATING',
    "splitDecidedAt" TIMESTAMP(3),

    CONSTRAINT "BatchProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BatchFinish" (
    "id" TEXT NOT NULL,
    "batchProductId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "inventoryDelta" INTEGER,

    CONSTRAINT "BatchFinish_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VariantRoute" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "skipStages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantRoute_pkey" PRIMARY KEY ("id")
);

-- ── 2. Collapse variants into products ────────────────────────────────────
-- One product row per (batch, product). Where a run held two variants of the
-- same product, their planned quantities sum into the raw count — they were
-- always the same castings.

INSERT INTO "BatchProduct" (
    "id", "batchId", "productId", "productTitle", "imageUrl",
    "plannedQuantity", "splitStage", "splitDecidedAt"
)
SELECT
    'bp_' || MIN("id"),
    "batchId",
    "productId",
    MIN("productTitle"),
    MIN("imageUrl"),
    SUM("plannedQuantity"),
    'PLATING',
    -- A run that already held more than one variant of a product had its
    -- split made, by hand, at creation time.
    CASE WHEN COUNT(*) > 1 THEN NOW() ELSE NULL END
FROM "BatchVariant"
GROUP BY "batchId", "productId";

-- Each old variant row becomes a finish carrying its own quantity.
INSERT INTO "BatchFinish" (
    "id", "batchProductId", "variantId", "variantTitle", "sku",
    "quantity", "inventoryDelta"
)
SELECT
    'bf_' || v."id",
    p."id",
    v."variantId",
    v."variantTitle",
    v."sku",
    v."plannedQuantity",
    v."inventoryDelta"
FROM "BatchVariant" v
JOIN "BatchProduct" p
  ON p."batchId" = v."batchId" AND p."productId" = v."productId";

-- Seed remembered routes from what each run had recorded. DISTINCT ON keeps
-- the most recent decision when a variant appeared in several runs.
INSERT INTO "VariantRoute" ("id", "shop", "productId", "variantId", "skipStages", "updatedAt")
SELECT DISTINCT ON (b."shop", v."variantId")
    'vr_' || v."id", b."shop", v."productId", v."variantId", v."skipStages", NOW()
FROM "BatchVariant" v
JOIN "Batch" b ON b."id" = v."batchId"
ORDER BY b."shop", v."variantId", b."updatedAt" DESC;

-- ── 3. Re-point the children ──────────────────────────────────────────────

ALTER TABLE "BatchItem" ADD COLUMN "batchProductId" TEXT;
ALTER TABLE "BatchItem" ADD COLUMN "variantId" TEXT;

UPDATE "BatchItem" i
SET "batchProductId" = p."id",
    -- The variant it belonged to IS the finish that order wanted.
    "variantId" = v."variantId"
FROM "BatchVariant" v
JOIN "BatchProduct" p
  ON p."batchId" = v."batchId" AND p."productId" = v."productId"
WHERE i."batchVariantId" = v."id";

-- Any orphan predating this transform has nothing to point at.
DELETE FROM "BatchItem" WHERE "batchProductId" IS NULL;

ALTER TABLE "BatchItem" ALTER COLUMN "batchProductId" SET NOT NULL;
ALTER TABLE "BatchItem" ALTER COLUMN "variantId" SET NOT NULL;

ALTER TABLE "BatchScrap" ADD COLUMN "batchProductId" TEXT;
ALTER TABLE "BatchScrap" ADD COLUMN "variantId" TEXT;

UPDATE "BatchScrap" s
SET "batchProductId" = p."id",
    -- Historic losses were recorded against a variant, so keep that; new
    -- ones before the split will leave it null.
    "variantId" = v."variantId"
FROM "BatchVariant" v
JOIN "BatchProduct" p
  ON p."batchId" = v."batchId" AND p."productId" = v."productId"
WHERE s."batchVariantId" = v."id";

DELETE FROM "BatchScrap" WHERE "batchProductId" IS NULL;
ALTER TABLE "BatchScrap" ALTER COLUMN "batchProductId" SET NOT NULL;

-- ── 4. Drop the old shape ─────────────────────────────────────────────────

ALTER TABLE "BatchItem" DROP CONSTRAINT "BatchItem_batchVariantId_fkey";
ALTER TABLE "BatchScrap" DROP CONSTRAINT "BatchScrap_batchVariantId_fkey";
DROP INDEX "BatchItem_batchVariantId_lineItemId_key";
DROP INDEX "BatchScrap_batchVariantId_idx";
ALTER TABLE "BatchItem" DROP COLUMN "batchVariantId";
ALTER TABLE "BatchScrap" DROP COLUMN "batchVariantId";

DROP TABLE "BatchVariant";

-- ── 5. Constraints and indexes for the new shape ──────────────────────────

CREATE UNIQUE INDEX "BatchProduct_batchId_productId_key" ON "BatchProduct"("batchId", "productId");
CREATE INDEX "BatchProduct_productId_idx" ON "BatchProduct"("productId");

CREATE UNIQUE INDEX "BatchFinish_batchProductId_variantId_key" ON "BatchFinish"("batchProductId", "variantId");
CREATE INDEX "BatchFinish_variantId_idx" ON "BatchFinish"("variantId");

CREATE UNIQUE INDEX "VariantRoute_shop_variantId_key" ON "VariantRoute"("shop", "variantId");
CREATE INDEX "VariantRoute_shop_productId_idx" ON "VariantRoute"("shop", "productId");

CREATE UNIQUE INDEX "BatchItem_batchProductId_lineItemId_key" ON "BatchItem"("batchProductId", "lineItemId");
CREATE INDEX "BatchScrap_batchProductId_idx" ON "BatchScrap"("batchProductId");

ALTER TABLE "BatchProduct" ADD CONSTRAINT "BatchProduct_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BatchFinish" ADD CONSTRAINT "BatchFinish_batchProductId_fkey" FOREIGN KEY ("batchProductId") REFERENCES "BatchProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BatchItem" ADD CONSTRAINT "BatchItem_batchProductId_fkey" FOREIGN KEY ("batchProductId") REFERENCES "BatchProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BatchScrap" ADD CONSTRAINT "BatchScrap_batchProductId_fkey" FOREIGN KEY ("batchProductId") REFERENCES "BatchProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
