import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { readEnv } from "@/lib/env";
import { normalizeEmail } from "@/lib/password";
import { readBodyTextWithLimit } from "@/lib/request-body";
import { resolveClientIp } from "@/lib/request-ip";

// Reusable server-side rate limiting.
//
// Algorithm: fixed window. Every attempt atomically increments a counter row
// keyed by (scope, HMAC-SHA256(identifier), windowStart). `windowStart` is the
// window boundary the attempt falls into, so counters reset deterministically
// and `Retry-After` is always <= the configured window length.
//
// Storage: the Prisma-backed `rate_limit_buckets` table, written with a single
// `INSERT ... ON CONFLICT DO UPDATE` (Prisma native upsert) so concurrent
// requests cannot race past a limit. State survives restarts and is shared by
// every process on the same database. On SQLite this is single-host only;
// multi-host deployments require the PostgreSQL migration documented in
// docs/deployment-render.md. There is deliberately NO in-memory fallback:
// when the store cannot be reached the decision is "unavailable" and each
// security-sensitive caller fails closed with a 503 (see
// src/lib/rate-limit-guard.ts).
//
// Privacy: identifiers (client IPs, account emails, user ids) are never stored
// raw — only a keyed HMAC digest. Passwords, session cookies, API keys and
// tokens must never be passed to this module.
//
// Note: intentionally not wrapped in `server-only` so the Node test suite can
// exercise it with an injected store (same convention as src/lib/payments.ts).

export interface RateLimitRule {
  /** Accepted attempts per window. Attempt `limit + 1` and later are denied. */
  limit: number;
  /** Fixed window length in milliseconds. */
  windowMs: number;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// Limits are the values recommended in docs/deployment-render.md §8 (reviewed
// before this phase). `login.source` doubles as the fallback bucket for the
// whole instance while trusted proxy headers are disabled, which is why it is
// deliberately coarser than `login.account`.
export const RATE_LIMITS = {
  loginSource: { limit: 60, windowMs: HOUR_MS },
  loginAccount: { limit: 10, windowMs: MINUTE_MS },
  registerSource: { limit: 5, windowMs: HOUR_MS },
  instructorRegisterSource: { limit: 5, windowMs: HOUR_MS },
  uploadUser: { limit: 30, windowMs: HOUR_MS },
  paymentOrderUser: { limit: 10, windowMs: MINUTE_MS },
  paymentVerifyUser: { limit: 30, windowMs: HOUR_MS },
} as const satisfies Record<string, RateLimitRule>;

/** Rows older than this are inert and may be deleted by cleanup. */
export const RATE_LIMIT_RETENTION_MS = 24 * HOUR_MS;

// Opportunistic cleanup: one in every N checks triggers a delete of expired
// rows, so the table cannot grow without bound without a scheduler.
const CLEANUP_PROBABILITY = 1 / 32;

/** Login form bodies are small; anything larger is not a credentials payload. */
const LOGIN_FORM_MAX_BYTES = 16 * 1024;

export type RateLimitDecision =
  | {
      status: "allowed";
      count: number;
      remaining: number;
      retryAfterSeconds: 0;
      resetAtMs: number;
    }
  | {
      status: "limited";
      count: number;
      remaining: 0;
      retryAfterSeconds: number;
      resetAtMs: number;
    }
  | { status: "unavailable" };

export interface RateLimitStore {
  /** Atomically increment and return the count for this window. */
  increment(input: {
    scope: string;
    keyHash: string;
    windowStartMs: number;
  }): Promise<number>;
  /** Optional removal of rows whose window ended before `cutoffMs`. */
  cleanup?(cutoffMs: number): Promise<number>;
}

/** Durable store backed by the `rate_limit_buckets` table. */
export const prismaRateLimitStore: RateLimitStore = {
  async increment({ scope, keyHash, windowStartMs }) {
    const windowStart = new Date(windowStartMs);
    const row = await prisma.rateLimitBucket.upsert({
      where: { scope_keyHash_windowStart: { scope, keyHash, windowStart } },
      create: { scope, keyHash, windowStart, count: 1 },
      update: { count: { increment: 1 } },
    });
    return row.count;
  },
  async cleanup(cutoffMs) {
    const result = await prisma.rateLimitBucket.deleteMany({
      where: { windowStart: { lt: new Date(cutoffMs) } },
    });
    return result.count;
  },
};

let activeStore: RateLimitStore = prismaRateLimitStore;

/**
 * Swap the store used by `checkRateLimit`. TEST-ONLY seam: production code
 * must never call this. Pass null to restore the durable Prisma store.
 */
export function setRateLimitStoreForTesting(store: RateLimitStore | null): void {
  activeStore = store ?? prismaRateLimitStore;
}

/** Delete counters whose window ended before `cutoffMs`. */
export async function cleanupExpiredBuckets(
  cutoffMs: number = Date.now() - RATE_LIMIT_RETENTION_MS,
): Promise<number> {
  return prismaRateLimitStore.cleanup ? prismaRateLimitStore.cleanup(cutoffMs) : 0;
}

/** Start (ms) of the fixed window that contains `nowMs`. */
export function windowStartFor(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

// The digest secret keeps stored keys non-reversible. RATE_LIMIT_HASH_SECRET is
// optional; AUTH_SECRET always exists in a real deployment (NextAuth requires
// it). The constant fallback applies only to local/test environments that set
// neither, so stored keys are still unlinkable to their inputs.
function hashSecret(): string {
  return (
    readEnv("RATE_LIMIT_HASH_SECRET") ??
    readEnv("AUTH_SECRET") ??
    readEnv("NEXTAUTH_SECRET") ??
    "veritas-rate-limit-local-dev"
  );
}

/** Keyed digest of an identifier; the raw value never reaches storage. */
export function hashRateLimitIdentifier(scope: string, identifier: string): string {
  return createHmac("sha256", hashSecret()).update(`${scope}\u0000${identifier}`).digest("hex");
}

/**
 * Coarse, privacy-conscious source identifier for anonymous endpoints.
 *
 * When TRUST_PROXY_HEADERS=true the trusted client IP is used; otherwise (or
 * when no header is present) every unidentified source shares one fallback
 * bucket. The fallback is deliberately bounded — it is never skipped — but it
 * cannot distinguish clients, so operators should verify proxy behavior and
 * enable trusted headers before launch (docs/deployment-render.md §8).
 */
export function rateLimitSourceIdentifier(request?: Request): string {
  const ip = resolveClientIp(request);
  return ip ? `ip:${ip}` : "source:unidentified";
}

/** The email submitted to the credentials login form (normalized), if any. */
async function readLoginEmail(request: Request): Promise<string | null> {
  try {
    const body = await readBodyTextWithLimit(request.clone().body, LOGIN_FORM_MAX_BYTES);
    if (!body.ok) return null;
    const raw = new URLSearchParams(body.text).get("email");
    if (!raw) return null;
    const normalized = normalizeEmail(raw);
    if (normalized.valid && normalized.normalized) return normalized.normalized;
    const fallback = raw.trim().toLowerCase().slice(0, 254);
    return fallback === "" ? null : fallback;
  } catch {
    return null;
  }
}

export interface RateLimitCheck {
  scope: string;
  identifier: string;
  rule: RateLimitRule;
}

/**
 * Check one rule and consume one attempt when allowed.
 *
 * Returns "unavailable" (never "allowed") when the store throws, so callers
 * fail closed instead of silently disabling protection.
 */
export async function checkRateLimit(
  check: RateLimitCheck & { nowMs?: number },
): Promise<RateLimitDecision> {
  const nowMs = check.nowMs ?? Date.now();
  const windowStartMs = windowStartFor(nowMs, check.rule.windowMs);
  const keyHash = hashRateLimitIdentifier(check.scope, check.identifier);

  let count: number;
  try {
    count = await activeStore.increment({ scope: check.scope, keyHash, windowStartMs });
  } catch (error) {
    console.error(
      "[rate-limit] store unavailable for scope",
      check.scope,
      error instanceof Error ? error.name : "UnknownError",
    );
    return { status: "unavailable" };
  }

  if (activeStore.cleanup && Math.random() < CLEANUP_PROBABILITY) {
    void activeStore.cleanup(nowMs - RATE_LIMIT_RETENTION_MS).catch(() => undefined);
  }

  const resetAtMs = windowStartMs + check.rule.windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));

  if (count > check.rule.limit) {
    return { status: "limited", count, remaining: 0, retryAfterSeconds, resetAtMs };
  }
  return {
    status: "allowed",
    count,
    remaining: Math.max(0, check.rule.limit - count),
    retryAfterSeconds: 0,
    resetAtMs,
  };
}

/**
 * Every rate-limit check that applies to a credentials sign-in POST:
 *
 *  1. login.source — all attempts from one source (IP, or the shared fallback
 *     when proxy headers are untrusted). This also bounds email-rotation
 *     attacks, because changing the email does not change the source.
 *  2. login.account — all attempts against one normalized email. This bounds
 *     distributed guessing against a single account.
 *
 * The checks never consult the user table, so a rate-limit response cannot
 * reveal whether an account exists.
 */
export async function loginRateLimitChecks(request: Request): Promise<RateLimitCheck[]> {
  const checks: RateLimitCheck[] = [
    {
      scope: "login.source",
      identifier: rateLimitSourceIdentifier(request),
      rule: RATE_LIMITS.loginSource,
    },
  ];

  const email = await readLoginEmail(request);
  if (email) {
    checks.push({
      scope: "login.account",
      identifier: `email:${email}`,
      rule: RATE_LIMITS.loginAccount,
    });
  }
  return checks;
}
