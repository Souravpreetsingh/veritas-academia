import { NextResponse } from "next/server";
import {
  RATE_LIMITS,
  checkRateLimit,
  loginRateLimitChecks,
  rateLimitSourceIdentifier,
  type RateLimitCheck,
} from "@/lib/rate-limit";

// HTTP mapping for rate limiting. Route handlers call the small `guard*`
// helpers below; every guard returns a ready response when the request must be
// rejected, or null when processing may continue.
//
// Failure policy: when the limiter store cannot be reached, security-sensitive
// routes fail closed with 503 rather than falling back to an unbounded or
// process-local limiter. 429 responses always carry a consistent, non-sensitive
// body and a `Retry-After` header (whole seconds until the window resets).

export const RATE_LIMIT_ERROR = {
  limited: "Too many requests. Please wait and try again.",
  unavailable: "This action is temporarily unavailable. Please try again shortly.",
  /** NextAuth-shaped error codes surfaced on the login screen query string. */
  limitedCode: "RateLimited",
  unavailableCode: "RateLimitUnavailable",
} as const;

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function rateLimitedResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: RATE_LIMIT_ERROR.limited },
    {
      status: 429,
      headers: { ...NO_STORE, "Retry-After": String(retryAfterSeconds) },
    },
  );
}

export function rateLimitUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: RATE_LIMIT_ERROR.unavailable },
    { status: 503, headers: { ...NO_STORE } },
  );
}

type CheckOutcome =
  | { kind: "ok" }
  | { kind: "limited"; retryAfterSeconds: number }
  | { kind: "unavailable" };

async function runChecks(checks: RateLimitCheck[], nowMs?: number): Promise<CheckOutcome> {
  for (const check of checks) {
    const decision = await checkRateLimit({ ...check, nowMs });
    if (decision.status === "unavailable") return { kind: "unavailable" };
    if (decision.status === "limited") {
      return { kind: "limited", retryAfterSeconds: decision.retryAfterSeconds };
    }
  }
  return { kind: "ok" };
}

/**
 * Run every check for an endpoint. Returns null when the request may proceed,
 * otherwise a 429 (limit exceeded) or 503 (limiter store unavailable) response.
 */
export async function enforceRateLimits(
  checks: RateLimitCheck[],
  nowMs?: number,
): Promise<NextResponse | null> {
  const outcome = await runChecks(checks, nowMs);
  if (outcome.kind === "limited") return rateLimitedResponse(outcome.retryAfterSeconds);
  if (outcome.kind === "unavailable") return rateLimitUnavailableResponse();
  return null;
}

// --- Endpoint guards ---------------------------------------------------------

/** Public student registration: one shared limit per source. */
export function guardRegistration(request: Request): Promise<NextResponse | null> {
  return enforceRateLimits([
    {
      scope: "register.source",
      identifier: rateLimitSourceIdentifier(request),
      rule: RATE_LIMITS.registerSource,
    },
  ]);
}

/** Public instructor onboarding: account creation, separate from registration. */
export function guardInstructorRegistration(request: Request): Promise<NextResponse | null> {
  return enforceRateLimits([
    {
      scope: "instructor-register.source",
      identifier: rateLimitSourceIdentifier(request),
      rule: RATE_LIMITS.instructorRegisterSource,
    },
  ]);
}

/** Authenticated document uploads: bounded per account. */
export function guardUpload(userId: string): Promise<NextResponse | null> {
  return enforceRateLimits([
    { scope: "upload.user", identifier: `user:${userId}`, rule: RATE_LIMITS.uploadUser },
  ]);
}

/**
 * Payment order creation: bounded per account so repeated clicks or scripts
 * cannot hammer the payment provider. Resumed orders keep working because the
 * limit only counts attempts, not distinct orders.
 */
export function guardPaymentOrder(userId: string): Promise<NextResponse | null> {
  return enforceRateLimits([
    {
      scope: "payment-order.user",
      identifier: `user:${userId}`,
      rule: RATE_LIMITS.paymentOrderUser,
    },
  ]);
}

/** Checkout verification: bounded per account (each call may reach the provider). */
export function guardPaymentVerify(userId: string): Promise<NextResponse | null> {
  return enforceRateLimits([
    {
      scope: "payment-verify.user",
      identifier: `user:${userId}`,
      rule: RATE_LIMITS.paymentVerifyUser,
    },
  ]);
}

// --- Credentials sign-in -----------------------------------------------------

/** True for the POST that NextAuth exposes as `/api/auth/callback/credentials`. */
export function isCredentialsCallback(request: Request): boolean {
  if (request.method !== "POST") return false;
  try {
    return new URL(request.url).pathname.endsWith("/api/auth/callback/credentials");
  } catch {
    return false;
  }
}

/**
 * Gate used by the NextAuth catch-all route: applies the login rate limits only
 * to the credentials callback POST and returns null for every other auth
 * request. Kept separate from `isCredentialsCallback` so the routing decision
 * and the limiting are testable without importing next-auth itself.
 */
export function guardCredentialsCallback(
  request: Request,
  nowMs?: number,
): Promise<NextResponse | null> {
  if (!isCredentialsCallback(request)) return Promise.resolve(null);
  return guardLoginCallback(request, nowMs);
}

// The next-auth react client unconditionally parses the response body and
// derives the error from `data.url`, so a rejection must still look like a
// NextAuth redirect payload. The response status (429/503) is what the login
// form keys on.
function nextAuthSignInError(
  request: Request,
  status: 429 | 503,
  code: string,
  retryAfterSeconds?: number,
): NextResponse {
  let origin = "";
  try {
    origin = new URL(request.url).origin;
  } catch {
    origin = "";
  }
  const headers: Record<string, string> = { ...NO_STORE };
  if (retryAfterSeconds !== undefined) headers["Retry-After"] = String(retryAfterSeconds);
  return NextResponse.json(
    { url: `${origin}/login?error=${code}` },
    { status, headers },
  );
}

/**
 * Rate-limit a credentials sign-in attempt before NextAuth processes it.
 *
 * The response is shaped for the next-auth react client (see above) while
 * keeping the documented 429 status and `Retry-After` header. The checks do
 * not touch the user table, so the response is identical whether or not the
 * submitted email belongs to an account.
 */
export async function guardLoginCallback(
  request: Request,
  nowMs?: number,
): Promise<NextResponse | null> {
  const checks = await loginRateLimitChecks(request);
  const outcome = await runChecks(checks, nowMs);
  if (outcome.kind === "limited") {
    return nextAuthSignInError(
      request,
      429,
      RATE_LIMIT_ERROR.limitedCode,
      outcome.retryAfterSeconds,
    );
  }
  if (outcome.kind === "unavailable") {
    return nextAuthSignInError(request, 503, RATE_LIMIT_ERROR.unavailableCode);
  }
  return null;
}
