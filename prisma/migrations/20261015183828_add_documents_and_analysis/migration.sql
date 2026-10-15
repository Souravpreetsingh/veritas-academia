-- CreateTable
CREATE TABLE "documents" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "documents_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "documents_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "analysis_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNCONFIGURED',
    "provider" TEXT NOT NULL DEFAULT 'unconfigured',
    "providerJobId" TEXT,
    "providerMeta" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "analysis_jobs_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "analysis_jobs_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "analysis_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "similarityPercent" REAL,
    "aiLikelihood" REAL,
    "matches" TEXT,
    "providerPayload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "analysis_results_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "analysis_jobs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_storageKey_key" ON "documents"("storageKey");

-- CreateIndex
CREATE INDEX "documents_ownerId_idx" ON "documents"("ownerId");

-- CreateIndex
CREATE INDEX "documents_requestId_idx" ON "documents"("requestId");

-- CreateIndex
CREATE INDEX "documents_status_idx" ON "documents"("status");

-- CreateIndex
CREATE INDEX "analysis_jobs_documentId_idx" ON "analysis_jobs"("documentId");

-- CreateIndex
CREATE INDEX "analysis_jobs_status_idx" ON "analysis_jobs"("status");

-- CreateIndex
CREATE INDEX "analysis_jobs_type_idx" ON "analysis_jobs"("type");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_results_jobId_key" ON "analysis_results"("jobId");
