-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "sku" TEXT,
    "imageUrl" TEXT,
    "plannedQuantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "stage" TEXT,
    "note" TEXT,
    "inventorySyncedAt" TIMESTAMP(3),
    "inventoryDelta" INTEGER,
    "inventoryLocationId" TEXT,
    "inventoryLocation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Batch_shop_status_idx" ON "Batch"("shop", "status");

-- CreateIndex
CREATE INDEX "Batch_shop_variantId_status_idx" ON "Batch"("shop", "variantId", "status");

-- CreateIndex
CREATE INDEX "BatchItem_lineItemId_idx" ON "BatchItem"("lineItemId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchItem_batchId_lineItemId_key" ON "BatchItem"("batchId", "lineItemId");

-- AddForeignKey
ALTER TABLE "BatchItem" ADD CONSTRAINT "BatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
