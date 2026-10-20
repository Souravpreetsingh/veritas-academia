import { NextResponse } from "next/server";
import { requireRole } from "@/lib/session";
import { errorResponse, jsonError } from "@/lib/api";
import { listInstructorApplications } from "@/lib/instructor-applications";

export const runtime = "nodejs";

// Admin-only application queue with status filtering and pagination.
export async function GET(request: Request) {
  let user;
  try {
    user = await requireRole(["ADMIN"]);
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }

  const url = new URL(request.url);
  try {
    const result = await listInstructorApplications({
      actor: user,
      status: url.searchParams.get("status") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
      request,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    console.error("[admin-applications] list failed:", error);
    return jsonError("Failed to load applications.", 500);
  }
}
