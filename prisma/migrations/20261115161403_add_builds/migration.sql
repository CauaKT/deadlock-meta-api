-- CreateTable
CREATE TABLE "builds" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "hero_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "author_name" TEXT,
    "phases" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "builds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "builds_hero_id_created_at_idx" ON "builds"("hero_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "builds" ADD CONSTRAINT "builds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
