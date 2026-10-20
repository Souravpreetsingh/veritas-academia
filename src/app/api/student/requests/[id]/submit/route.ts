import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { submitServiceRequest } from "@/lib/service-requests";

export const runtime = "nodejs";

// Submit a draft request for payment. Only the owning student may submit, and
// the transition is validated server-side. Payment is NOT recorded here.
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

  try {
    const result = await submitServiceRequest({ actor: user, requestId: id, request });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error("[student-requests] submit failed:", error);
    return jsonError("Failed to submit the service request.", 500);
  }
}
