import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { createServiceRequest } from "@/lib/service-requests";
import { REQUEST_BODY_LIMITS, readJsonBodyWithLimit } from "@/lib/request-body";

export const runtime = "nodejs";

// Create a student service request. The student identity comes from the session;
// price, instructor eligibility and service ownership are all re-checked on the
// server (see src/lib/service-requests.ts).
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
    const result = await createServiceRequest({
      actor: user,
      input: (body ?? {}) as Record<string, unknown>,
      request,
    });
    return NextResponse.json(result, {
      status: result.duplicate ? 200 : 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error("[student-requests] create failed:", error);
    return jsonError("Failed to create the service request.", 500);
  }
}
