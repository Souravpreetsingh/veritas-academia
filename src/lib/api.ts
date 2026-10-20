import { NextResponse } from "next/server";
import { AuthError } from "@/lib/session";
import { AppError, ValidationError } from "@/lib/app-errors";

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

/** Map a domain AppError (validation/forbidden/conflict/not-found) to HTTP. */
export function appErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof AppError) {
    const extra = error instanceof ValidationError ? { fields: error.fields } : undefined;
    return jsonError(error.message, error.status, extra);
  }
  return null;
}

/** Try the auth mapping first, then the domain mapping. */
export function errorResponse(error: unknown): NextResponse | null {
  return authErrorResponse(error) ?? appErrorResponse(error);
}
