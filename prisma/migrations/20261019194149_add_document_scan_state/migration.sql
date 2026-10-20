-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "requestId" TEXT,
    "storageDriver" TEXT NOT NULL DEFAULT 'local',
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "scanStatus" TEXT NOT NULL DEFAULT 'UNSCANNED',
    "scanEngine" TEXT,
    "scanReason" TEXT,
    "scanSignature" TEXT,
    "scanAttempts" INTEGER NOT NULL DEFAULT 0,
    "scanStartedAt" DATETIME,
    "scannedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "documents_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "documents_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_documents" ("checksumSha256", "contentType", "createdAt", "id", "originalName", "ownerId", "requestId", "sizeBytes", "status", "storageDriver", "storageKey", "updatedAt") SELECT "checksumSha256", "contentType", "createdAt", "id", "originalName", "ownerId", "requestId", "sizeBytes", "status", "storageDriver", "storageKey", "updatedAt" FROM "documents";
DROP TABLE "documents";
ALTER TABLE "new_documents" RENAME TO "documents";
CREATE UNIQUE INDEX "documents_storageKey_key" ON "documents"("storageKey");
CREATE INDEX "documents_ownerId_idx" ON "documents"("ownerId");
CREATE INDEX "documents_requestId_idx" ON "documents"("requestId");
CREATE INDEX "documents_status_idx" ON "documents"("status");
CREATE INDEX "documents_scanStatus_idx" ON "documents"("scanStatus");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
