-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_instructor_applications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "bio" TEXT NOT NULL,
    "expertise" TEXT,
    "qualifications" TEXT,
    "proposedServices" TEXT,
    "termsAcceptedAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewedAt" DATETIME,
    "reviewedById" TEXT,
    "rejectionReason" TEXT,
    "reviewNotes" TEXT,
    "instructorProfileId" TEXT,
    "activeKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "instructor_applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "instructor_applications_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "instructor_applications_instructorProfileId_fkey" FOREIGN KEY ("instructorProfileId") REFERENCES "instructor_profiles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_instructor_applications" ("bio", "createdAt", "email", "expertise", "fullName", "id", "phone", "proposedServices", "qualifications", "reviewNotes", "reviewedAt", "reviewedById", "status", "termsAcceptedAt", "updatedAt", "userId") SELECT "bio", "createdAt", "email", "expertise", "fullName", "id", "phone", "proposedServices", "qualifications", "reviewNotes", "reviewedAt", "reviewedById", "status", "termsAcceptedAt", "updatedAt", "userId" FROM "instructor_applications";
DROP TABLE "instructor_applications";
ALTER TABLE "new_instructor_applications" RENAME TO "instructor_applications";
CREATE UNIQUE INDEX "instructor_applications_instructorProfileId_key" ON "instructor_applications"("instructorProfileId");
CREATE UNIQUE INDEX "instructor_applications_activeKey_key" ON "instructor_applications"("activeKey");
CREATE INDEX "instructor_applications_userId_status_idx" ON "instructor_applications"("userId", "status");
CREATE INDEX "instructor_applications_status_idx" ON "instructor_applications"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
