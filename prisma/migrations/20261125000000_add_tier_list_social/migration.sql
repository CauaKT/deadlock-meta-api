ALTER TABLE "tier_lists"
ADD COLUMN "description" TEXT,
ADD COLUMN "views_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "posts"
ADD COLUMN "tier_list_id" TEXT;

CREATE TABLE "tier_list_likes" (
    "id" TEXT NOT NULL,
    "tier_list_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tier_list_likes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tier_list_comments" (
    "id" TEXT NOT NULL,
    "tier_list_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tier_list_comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tier_lists_created_at_idx" ON "tier_lists"("created_at" DESC);
CREATE INDEX "posts_tier_list_id_idx" ON "posts"("tier_list_id");
CREATE INDEX "tier_list_likes_tier_list_id_idx" ON "tier_list_likes"("tier_list_id");
CREATE UNIQUE INDEX "tier_list_likes_tier_list_id_user_id_key" ON "tier_list_likes"("tier_list_id", "user_id");
CREATE INDEX "tier_list_comments_tier_list_id_created_at_idx" ON "tier_list_comments"("tier_list_id", "created_at");

ALTER TABLE "posts" ADD CONSTRAINT "posts_tier_list_id_fkey" FOREIGN KEY ("tier_list_id") REFERENCES "tier_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tier_list_likes" ADD CONSTRAINT "tier_list_likes_tier_list_id_fkey" FOREIGN KEY ("tier_list_id") REFERENCES "tier_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tier_list_likes" ADD CONSTRAINT "tier_list_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tier_list_comments" ADD CONSTRAINT "tier_list_comments_tier_list_id_fkey" FOREIGN KEY ("tier_list_id") REFERENCES "tier_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tier_list_comments" ADD CONSTRAINT "tier_list_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;