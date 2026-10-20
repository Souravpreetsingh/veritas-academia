// Authorized read model for the instructor analysis workbench.
//
// The page reads persisted jobs/results; it never runs analysis during a render
// and never invents a completed state. Provider availability is a safe status
// snapshot (no credentials, endpoints, or raw diagnostics).

import { prisma } from "@/lib/db";
import {
  canViewInstructorRequest,
  isPaidRequestStatusForAnalysis,
  type AuthUser,
} from "@/lib/authorization";
import { isAnalysisJobType, type AnalysisJobType } from "@/lib/domain";
import {
  analysisAvailability,
  type AnalysisAvailability,
} from "@/lib/analysis/index";
import {
  toAnalysisJobSummary,
  type AnalysisJobSummary,
} from "@/lib/analysis/jobs";

export interface AnalysisDocumentOption {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  status: string;
  scanStatus: string;
}

export interface AnalysisOverview {
  requestId: string;
  requestStatus: string;
  canInitiate: boolean;
  documents: AnalysisDocumentOption[];
  /** Latest job per analysis type for each document, newest first. */
  latestJobsByDocument: Record<
    string,
    Partial<Record<AnalysisJobType, AnalysisJobSummary>>
  >;
  availability: AnalysisAvailability;
  llmConsentAt: Date | null;
  llmConsentVersion: string | null;
}

/**
 * Return the analysis overview only to the assigned instructor or an admin.
 * Any other actor gets null (the page converts this to a 404).
 */
export async function getAnalysisOverview(
  actor: AuthUser,
  requestId: unknown,
): Promise<AnalysisOverview | null> {
  if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 64) {
    return null;
  }

  const request = await prisma.serviceRequest.findUnique({
    where: { id: requestId.trim() },
    select: {
      id: true,
      status: true,
      llmProcessingConsentAt: true,
      llmProcessingConsentVersion: true,
      instructor: {
        select: {
          userId: true,
          isApproved: true,
          isActive: true,
          user: { select: { role: true, suspended: true } },
        },
      },
      documents: {
        select: {
          id: true,
          originalName: true,
          contentType: true,
          sizeBytes: true,
          status: true,
          scanStatus: true,
        },
        orderBy: { createdAt: "asc" },
      },
      analysisJobs: {
        orderBy: { createdAt: "desc" },
        include: { result: true },
      },
    },
  });
  if (!request) return null;

  if (!canViewInstructorRequest(actor, request)) {
    return null;
  }

  const latestJobsByDocument: Record<
    string,
    Partial<Record<AnalysisJobType, AnalysisJobSummary>>
  > = {};
  for (const job of request.analysisJobs) {
    if (!isAnalysisJobType(job.type)) continue;
    const byType = (latestJobsByDocument[job.documentId] ??= {});
    if (byType[job.type]) continue;
    byType[job.type] = toAnalysisJobSummary({
      ...job,
      type: job.type,
    });
  }

  const instructorEligible =
    actor.role === "INSTRUCTOR" &&
    request.instructor.userId === actor.id &&
    request.instructor.isApproved &&
    request.instructor.isActive &&
    request.instructor.user.role === "INSTRUCTOR" &&
    !request.instructor.user.suspended;

  return {
    requestId: request.id,
    requestStatus: request.status,
    canInitiate:
      instructorEligible &&
      isPaidRequestStatusForAnalysis(request.status) &&
      request.documents.some(
        (document) =>
          document.status === "AVAILABLE" && document.scanStatus === "CLEAN",
      ),
    documents: request.documents,
    latestJobsByDocument,
    availability: analysisAvailability(),
    llmConsentAt: request.llmProcessingConsentAt,
    llmConsentVersion: request.llmProcessingConsentVersion,
  };
}
