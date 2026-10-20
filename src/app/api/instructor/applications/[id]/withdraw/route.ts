import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { withdrawInstructorApplication } from "@/lib/instructor-applications";

export const runtime = "nodejs";

// Withdraw the caller's own pending application.
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
    const application = await withdrawInstructorApplication({
      actor: user,
      applicationId: id,
      request,
    });
    return NextResponse.json({ application }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error("[instructor-applications] withdraw failed:", error);
    return jsonError("Failed to withdraw application.", 500);
  }
}
