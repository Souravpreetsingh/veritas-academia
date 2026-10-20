import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { acceptServiceRequest } from "@/lib/instructor-requests";

export const runtime = "nodejs";

// Accept a service request. The acting instructor, the assignment and the
// current eligibility are all re-derived server-side (see
// src/lib/instructor-requests.ts); any request body is ignored entirely.
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

  try {
    const result = await acceptServiceRequest({ actor: user, requestId: id, request });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error("[instructor-requests] accept failed:", error);
    return jsonError("Failed to accept the service request.", 500);
  }
}
