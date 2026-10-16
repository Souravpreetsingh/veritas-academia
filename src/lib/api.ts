import { NextResponse } from "next/server";
import { AuthError } from "@/lib/session";

export function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { error: message, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** Map an AuthError to an HTTP response, or return null if it isn't one. */
export function authErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof AuthError) {
    const status = error.code === "UNAUTHENTICATED" ? 401 : 403;
    return jsonError(error.message, status);
  }
  return null;
}
