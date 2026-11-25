-- AlterTable
ALTER TABLE "tier_lists" ADD COLUMN     "quadrant" JSONB,
ADD COLUMN     "style" TEXT NOT NULL DEFAULT 'classic';
