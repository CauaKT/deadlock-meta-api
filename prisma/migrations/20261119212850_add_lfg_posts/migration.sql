-- CreateTable
CREATE TABLE "lfg_posts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "rank_tier" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "hero_ids" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lfg_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lfg_posts_created_at_idx" ON "lfg_posts"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "lfg_posts" ADD CONSTRAINT "lfg_posts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
