-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "windowStart" DATETIME NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "rate_limit_buckets_windowStart_idx" ON "rate_limit_buckets"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_buckets_scope_keyHash_windowStart_key" ON "rate_limit_buckets"("scope", "keyHash", "windowStart");
