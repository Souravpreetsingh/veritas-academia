-- AlterTable
ALTER TABLE "analysis_results" ADD COLUMN "observations" TEXT;

-- AlterTable
ALTER TABLE "service_requests" ADD COLUMN "llmProcessingConsentAt" DATETIME;
ALTER TABLE "service_requests" ADD COLUMN "llmProcessingConsentVersion" TEXT;
