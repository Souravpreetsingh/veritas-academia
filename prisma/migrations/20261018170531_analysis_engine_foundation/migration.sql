-- AlterTable
ALTER TABLE "analysis_results" ADD COLUMN "metadata" TEXT;
ALTER TABLE "analysis_results" ADD COLUMN "providerVersion" TEXT;
ALTER TABLE "analysis_results" ADD COLUMN "segments" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_analysis_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "requestId" TEXT,
    "requestedById" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNCONFIGURED',
    "provider" TEXT NOT NULL DEFAULT 'unconfigured',
    "providerJobId" TEXT,
    "providerStatus" TEXT,
    "providerVersion" TEXT,
    "providerMeta" TEXT,
    "activeKey" TEXT,
    "errorCategory" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" DATETIME,
    "startedAt" DATETIME,
    "lastAttemptAt" DATETIME,
    "nextAttemptAt" DATETIME,
    "completedAt" DATETIME,
    "failedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "analysis_jobs_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "analysis_jobs_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "analysis_jobs_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_analysis_jobs" ("attempts", "completedAt", "createdAt", "documentId", "errorMessage", "id", "provider", "providerJobId", "providerMeta", "requestedById", "startedAt", "status", "type", "updatedAt") SELECT "attempts", "completedAt", "createdAt", "documentId", "errorMessage", "id", "provider", "providerJobId", "providerMeta", "requestedById", "startedAt", "status", "type", "updatedAt" FROM "analysis_jobs";
DROP TABLE "analysis_jobs";
ALTER TABLE "new_analysis_jobs" RENAME TO "analysis_jobs";
CREATE UNIQUE INDEX "analysis_jobs_activeKey_key" ON "analysis_jobs"("activeKey");
CREATE INDEX "analysis_jobs_documentId_idx" ON "analysis_jobs"("documentId");
CREATE INDEX "analysis_jobs_requestId_idx" ON "analysis_jobs"("requestId");
CREATE INDEX "analysis_jobs_status_nextAttemptAt_idx" ON "analysis_jobs"("status", "nextAttemptAt");
CREATE INDEX "analysis_jobs_type_idx" ON "analysis_jobs"("type");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
