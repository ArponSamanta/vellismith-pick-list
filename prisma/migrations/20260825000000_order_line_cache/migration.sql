-- CreateTable
CREATE TABLE "OrderLineCache" (
    "shop" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "lineCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OrderLineCache_pkey" PRIMARY KEY ("shop")
);

