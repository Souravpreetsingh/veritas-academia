import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { declineServiceRequest } from "@/lib/instructor-requests";
import { REQUEST_BODY_LIMITS, readBodyTextWithLimit } from "@/lib/request-body";

export const runtime = "nodejs";

// Decline a service request. Only the optional `reason` is read from the body;
// every other client-supplied value is ignored. Assignment, eligibility and the
// transition are re-checked server-side.
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

  let body: unknown = {};
  const text = await readBodyTextWithLimit(request.body, REQUEST_BODY_LIMITS.textBytes);
  if (!text.ok) {
    return jsonError(
      text.reason === "too_large" ? "The request body is too large." : "Invalid request body.",
      text.reason === "too_large" ? 413 : 400,
    );
  }
  try {
    body = text.text.trim() === "" ? {} : JSON.parse(text.text);
  } catch {
    return jsonError("Invalid request body.", 400);
  }

  try {
    const result = await declineServiceRequest({
      actor: user,
      requestId: id,
      input: (body ?? {}) as Record<string, unknown>,
      request,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error("[instructor-requests] decline failed:", error);
    return jsonError("Failed to decline the service request.", 500);
  }
}
