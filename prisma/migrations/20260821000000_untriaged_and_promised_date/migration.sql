-- AlterTable
ALTER TABLE "TrackedItem" ADD COLUMN     "promisedDate" TEXT,
ALTER COLUMN "status" DROP NOT NULL;

-- AlterTable
ALTER TABLE "TrackedItemEvent" ALTER COLUMN "toStatus" DROP NOT NULL;

