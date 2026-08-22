-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "status" TEXT NOT NULL,
    "stage" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedItemEvent" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "fromStage" TEXT,
    "toStatus" TEXT NOT NULL,
    "toStage" TEXT,
    "by" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackedItemEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackedItem_shop_status_stage_idx" ON "TrackedItem"("shop", "status", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedItem_shop_lineItemId_key" ON "TrackedItem"("shop", "lineItemId");

-- CreateIndex
CREATE INDEX "TrackedItemEvent_itemId_at_idx" ON "TrackedItemEvent"("itemId", "at");

-- AddForeignKey
ALTER TABLE "TrackedItemEvent" ADD CONSTRAINT "TrackedItemEvent_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "TrackedItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

