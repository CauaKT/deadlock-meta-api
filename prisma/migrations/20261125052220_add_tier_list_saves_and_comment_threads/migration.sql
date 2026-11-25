-- AlterTable
ALTER TABLE "tier_list_comments" ADD COLUMN     "parent_id" TEXT;

-- CreateTable
CREATE TABLE "tier_list_saves" (
    "id" TEXT NOT NULL,
    "tier_list_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tier_list_saves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tier_list_comment_likes" (
    "id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tier_list_comment_likes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tier_list_saves_tier_list_id_idx" ON "tier_list_saves"("tier_list_id");

-- CreateIndex
CREATE INDEX "tier_list_saves_user_id_created_at_idx" ON "tier_list_saves"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tier_list_saves_tier_list_id_user_id_key" ON "tier_list_saves"("tier_list_id", "user_id");

-- CreateIndex
CREATE INDEX "tier_list_comment_likes_comment_id_idx" ON "tier_list_comment_likes"("comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "tier_list_comment_likes_comment_id_user_id_key" ON "tier_list_comment_likes"("comment_id", "user_id");

-- CreateIndex
CREATE INDEX "tier_list_comments_parent_id_created_at_idx" ON "tier_list_comments"("parent_id", "created_at");

-- AddForeignKey
ALTER TABLE "tier_list_saves" ADD CONSTRAINT "tier_list_saves_tier_list_id_fkey" FOREIGN KEY ("tier_list_id") REFERENCES "tier_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tier_list_saves" ADD CONSTRAINT "tier_list_saves_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tier_list_comments" ADD CONSTRAINT "tier_list_comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "tier_list_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tier_list_comment_likes" ADD CONSTRAINT "tier_list_comment_likes_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "tier_list_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tier_list_comment_likes" ADD CONSTRAINT "tier_list_comment_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
