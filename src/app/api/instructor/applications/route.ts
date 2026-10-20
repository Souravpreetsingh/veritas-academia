import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { submitInstructorApplication } from "@/lib/instructor-applications";
import { REQUEST_BODY_LIMITS, readJsonBodyWithLimit } from "@/lib/request-body";

export const runtime = "nodejs";

// Submit an instructor application. The applicant identity is derived from the
// authenticated session — never from the request body.
export async function POST(request: Request) {
  let user;
  try {
    user = await requireRole(["STUDENT"]);
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
    const application = await submitInstructorApplication({
      actor: user,
      input: (body ?? {}) as Record<string, unknown>,
      request,
    });
    return NextResponse.json(
      { application },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error("[instructor-applications] submit failed:", error);
    return jsonError("Failed to submit application. Please try again.", 500);
  }
}
