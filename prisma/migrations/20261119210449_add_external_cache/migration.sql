-- CreateTable
CREATE TABLE "external_cache" (
    "key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_cache_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "external_cache_expires_at_idx" ON "external_cache"("expires_at");
