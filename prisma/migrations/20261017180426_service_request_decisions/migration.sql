-- AlterTable
ALTER TABLE "service_requests" ADD COLUMN "decisionAt" DATETIME;
ALTER TABLE "service_requests" ADD COLUMN "declineReason" TEXT;
