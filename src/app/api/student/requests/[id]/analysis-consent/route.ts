import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { setLlmProcessingConsent } from "@/lib/analysis/consent";
import { REQUEST_BODY_LIMITS, readJsonBodyWithLimit } from "@/lib/request-body";

export const runtime = "nodejs";

/**
 * Record or withdraw the owning student's consent for external LLM review.
 * The client sends only `{ consent: boolean }`; the request id is checked
 * against the authenticated student and never trusted from the body.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

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
    const result = await setLlmProcessingConsent({
      actor: user,
      requestId: id,
      consent: (body as Record<string, unknown> | null)?.consent,
      request,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error("[analysis-consent] update failed:", error);
    return jsonError("Failed to update LLM processing consent.", 500);
  }
}
