-- AlterTable
ALTER TABLE "leaderboard_snapshot" ADD COLUMN     "region" TEXT;

-- CreateIndex
CREATE INDEX "leaderboard_snapshot_region_points_account_id_idx" ON "leaderboard_snapshot"("region", "points" DESC, "account_id");
