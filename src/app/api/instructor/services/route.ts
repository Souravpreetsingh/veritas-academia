import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { publishInstructorService } from "@/lib/instructor-services";
import { REQUEST_BODY_LIMITS, readJsonBodyWithLimit } from "@/lib/request-body";

export const runtime = "nodejs";

// Publish an instructor service. Server-enforced: only an approved, active
// instructor may publish (see evaluateInstructorEligibility).
export async function POST(request: Request) {
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
  const body = parsed.value;

  try {
    const service = await publishInstructorService({
      actor: user,
      input: (body ?? {}) as Record<string, unknown>,
      request,
    });
    return NextResponse.json(
      { service },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error("[instructor-services] publish failed:", error);
    return jsonError("Failed to publish service.", 500);
  }
}
