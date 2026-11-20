-- CreateTable
CREATE TABLE "leaderboard_snapshot" (
    "account_id" BIGINT NOT NULL,
    "points" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leaderboard_snapshot_pkey" PRIMARY KEY ("account_id")
);

-- CreateIndex
CREATE INDEX "leaderboard_snapshot_points_account_id_idx" ON "leaderboard_snapshot"("points" DESC, "account_id");
