import { NextResponse } from "next/server";
import { AppError, ValidationError } from "@/lib/app-errors";
import { registerInstructorApplicant } from "@/lib/instructor-applications";
import { REQUEST_BODY_LIMITS, readJsonBodyWithLimit } from "@/lib/request-body";
import { guardInstructorRegistration } from "@/lib/rate-limit-guard";

export const runtime = "nodejs";

// Local error helpers (mirroring /api/register) keep this route free of the
// server-only session module, so it can be exercised directly by the test suite.
function fail(error: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { error, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

// Public instructor onboarding. Creates a STUDENT-role account plus a PENDING
// instructor application in one transaction — approval is still required before
// any instructor capability exists. The role is never taken from the request
// body, so this endpoint can never escalate privileges.
export async function POST(request: Request) {
  // Abuse protection first: onboarding creates an account plus an application
  // that a human reviews, so malformed requests still consume the source bucket.
  const limited = await guardInstructorRegistration(request);
  if (limited) return limited;

  const parsed = await readJsonBodyWithLimit(request.body, REQUEST_BODY_LIMITS.jsonBytes);
  if (!parsed.ok) {
    return fail(
      parsed.tooLarge ? "The request body is too large." : "Invalid request body.",
      parsed.tooLarge ? 413 : 400,
    );
  }

  try {
    const result = await registerInstructorApplicant({
      input: (parsed.value ?? {}) as Record<string, unknown>,
      request,
    });
    return NextResponse.json(
      { ok: true, application: result.application },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AppError) {
      const extra = error instanceof ValidationError ? { fields: error.fields } : undefined;
      return fail(error.message, error.status, extra);
    }
    console.error("[instructor-register] failed:", error);
    return fail("Failed to create the instructor application. Please try again.", 500);
  }
}
