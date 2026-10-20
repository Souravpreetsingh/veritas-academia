import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { getMyInstructorApplication } from "@/lib/instructor-applications";

export const runtime = "nodejs";

// The caller's own application status.
export async function GET() {
  let user;
  try {
    user = await requireRole(["STUDENT", "INSTRUCTOR"]);
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const application = await getMyInstructorApplication({ actor: user });
    return NextResponse.json({ application }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error("[instructor-applications] get-mine failed:", error);
    return jsonError("Failed to load application.", 500);
  }
}
