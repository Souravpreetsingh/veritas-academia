// Application-level error types used by domain services.
//
// These are deliberately free of Next.js / next-auth imports so services can be
// unit-tested in isolation. Route handlers map them to HTTP responses via
// `appErrorResponse` in src/lib/api.ts.

export type AppErrorCode =
  | "VALIDATION"
  | "FORBIDDEN"
  | "CONFLICT"
  | "NOT_FOUND"
  | "UNAVAILABLE";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;

  constructor(code: AppErrorCode, message: string, status: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export class ValidationError extends AppError {
  /** Field-level messages, safe to surface to the client. */
  readonly fields: Record<string, string>;

  constructor(message: string, fields: Record<string, string> = {}) {
    super("VALIDATION", message, 422);
    this.name = "ValidationError";
    this.fields = fields;
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.") {
    super("FORBIDDEN", message, 403);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message, 409);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found.") {
    super("NOT_FOUND", message, 404);
    this.name = "NotFoundError";
  }
}

/** A caller lacks eligibility (e.g. an unapproved instructor). */
export class IneligibleError extends AppError {
  readonly reasons: string[];

  constructor(message: string, reasons: string[] = []) {
    super("FORBIDDEN", message, 403);
    this.name = "IneligibleError";
    this.reasons = reasons;
  }
}

/**
 * A server-side integration is not configured (e.g. missing payment
 * credentials). Callers must never simulate success or bypass verification —
 * they return this safe, descriptive error instead.
 */
export class ConfigurationError extends AppError {
  constructor(message = "This feature is not configured on the server.") {
    super("UNAVAILABLE", message, 503);
    this.name = "ConfigurationError";
  }
}

/** The external provider failed or is unreachable. No state was changed. */
export class ProviderError extends AppError {
  constructor(message = "The payment provider is currently unavailable. Please try again.") {
    super("UNAVAILABLE", message, 502);
    this.name = "ProviderError";
  }
}
