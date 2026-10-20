import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { initiateAnalysis } from "@/lib/analysis/jobs";
import { REQUEST_BODY_LIMITS, readJsonBodyWithLimit } from "@/lib/request-body";

export const runtime = "nodejs";

/**
 * Initiate provider-independent document analysis for a request.
 *
 * Only the assigned instructor may call this; the service re-checks approval,
 * active status, assignment, paid state, and document quarantine/association.
 * The client supplies only the document id and analysis type — never a
 * provider, score, amount, or status.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let user;
  try {
    user = await requireRole(["INSTRUCTOR"]);
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }

  const parsed = await readJsonBodyWithLimit(request.body, REQUEST_BODY_LIMITS.jsonBytes);
  if (!parsed.ok) {
    return jsonError(
      parsed.tooLarge ? "The request body is too large." : "Invalid request body.",
      parsed.tooLarge ? 413 : 400,
    );
  }
  const input = (parsed.value ?? {}) as Record<string, unknown>;

  try {
    const result = await initiateAnalysis({
      actor: user,
      requestId: id,
      documentId: input.documentId,
      type: input.type,
      request,
    });

    return NextResponse.json(result, {
      status: result.created ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error("[analysis] initiation failed:", error);
    return jsonError("Failed to initiate analysis. Please try again.", 500);
  }
}
