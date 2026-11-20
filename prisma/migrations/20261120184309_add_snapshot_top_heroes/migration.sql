-- AlterTable
ALTER TABLE "leaderboard_snapshot" ADD COLUMN     "top_heroes" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- CreateIndex
CREATE INDEX "leaderboard_snapshot_top_heroes_idx" ON "leaderboard_snapshot" USING GIN ("top_heroes");
