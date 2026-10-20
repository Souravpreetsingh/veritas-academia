import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { decideInstructorApplication } from "@/lib/instructor-applications";
import { REQUEST_BODY_LIMITS, readJsonBodyWithLimit } from "@/lib/request-body";

export const runtime = "nodejs";

// Admin-only decision (approve/reject). The acting admin comes from the session;
// a rejection requires a meaningful reason.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let user;
  try {
    user = await requireRole(["ADMIN"]);
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
  const body = (parsed.value ?? {}) as {
    decision?: unknown;
    rejectionReason?: unknown;
    reviewNotes?: unknown;
  };

  const decision = body.decision === "APPROVE" || body.decision === "REJECT" ? body.decision : null;
  if (!decision) {
    return jsonError("Decision must be APPROVE or REJECT.", 400);
  }

  try {
    const application = await decideInstructorApplication({
      actor: user,
      applicationId: id,
      decision,
      rejectionReason: body.rejectionReason,
      reviewNotes: body.reviewNotes,
      request,
    });
    return NextResponse.json({ application }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error("[admin-applications] decision failed:", error);
    return jsonError("Failed to record decision.", 500);
  }
}
