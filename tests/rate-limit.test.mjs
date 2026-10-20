import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db.ts";
import {
  RATE_LIMITS,
  RATE_LIMIT_RETENTION_MS,
  checkRateLimit,
  cleanupExpiredBuckets,
  hashRateLimitIdentifier,
  loginRateLimitChecks,
  rateLimitSourceIdentifier,
  setRateLimitStoreForTesting,
  windowStartFor,
} from "../src/lib/rate-limit.ts";
import { enforceRateLimits, guardLoginCallback } from "../src/lib/rate-limit-guard.ts";

// Core rate-limiter tests: fixed-window maths, atomic counters (real Prisma
// store against prisma/test.db), key derivation, concurrent behaviour, expiry,
// and the documented fail-closed policy when the store is unavailable.

// A stable, window-aligned timestamp so every expectation is exact.
const T0 = 1_800_000_000_000; // divisible by 60s / 90s / 1h window sizes

const LOGIN_URL = "http://localhost/api/auth/callback/credentials";

function formRequest(email, ip) {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (ip) headers["x-forwarded-for"] = ip;
  return new Request(LOGIN_URL, {
    method: "POST",
    headers,
    body: new URLSearchParams({
      email,
      password: "not-a-real-password",
      csrfToken: "test",
      callbackUrl: "http://localhost/login",
      json: "true",
    }).toString(),
  });
}

const previousTrust = process.env.TRUST_PROXY_HEADERS;
process.env.TRUST_PROXY_HEADERS = "true";

test.after(async () => {
  if (previousTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
  else process.env.TRUST_PROXY_HEADERS = previousTrust;
  setRateLimitStoreForTesting(null);
  await prisma.$disconnect();
});

test("windowStartFor aligns timestamps to fixed window boundaries", () => {
  assert.equal(windowStartFor(0, 60_000), 0);
  assert.equal(windowStartFor(59_999, 60_000), 0);
  assert.equal(windowStartFor(60_000, 60_000), 60_000);
  assert.equal(windowStartFor(119_999, 60_000), 60_000);
  assert.equal(windowStartFor(T0 + 30_000, 60_000), T0);
});

test("hashed identifiers are deterministic, scope-separated and opaque", () => {
  const digest = hashRateLimitIdentifier("login.account", "email:person@example.com");
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, hashRateLimitIdentifier("login.account", "email:person@example.com"));
  assert.notEqual(digest, hashRateLimitIdentifier("login.source", "email:person@example.com"));
  assert.equal(digest.includes("person@example.com"), false);
});

test("a fixed window allows exactly `limit` attempts and denies the next", async () => {
  await prisma.rateLimitBucket.deleteMany();
  const scope = "test.window.limit";
  const rule = { limit: 3, windowMs: 60_000 };
  const check = { scope, identifier: "subject:one", rule, nowMs: T0 };

  const first = await checkRateLimit(check);
  assert.equal(first.status, "allowed");
  assert.equal(first.remaining, 2);
  assert.equal((await checkRateLimit(check)).remaining, 1);
  assert.equal((await checkRateLimit(check)).remaining, 0);

  const denied = await checkRateLimit(check);
  assert.equal(denied.status, "limited");
  assert.equal(denied.remaining, 0);
  assert.equal(denied.retryAfterSeconds, 60);
  assert.equal(denied.resetAtMs, T0 + rule.windowMs);

  // one row per (scope, keyHash, windowStart)
  assert.equal(await prisma.rateLimitBucket.count({ where: { scope } }), 1);
});

test("counters reset when the window advances", async () => {
  await prisma.rateLimitBucket.deleteMany();
  const scope = "test.window.reset";
  const rule = { limit: 2, windowMs: 60_000 };
  const base = { scope, identifier: "subject:two", rule };

  await checkRateLimit({ ...base, nowMs: T0 });
  await checkRateLimit({ ...base, nowMs: T0 });
  assert.equal((await checkRateLimit({ ...base, nowMs: T0 })).status, "limited");

  const next = await checkRateLimit({ ...base, nowMs: T0 + rule.windowMs });
  assert.equal(next.status, "allowed");
  assert.equal(next.remaining, 1);
  assert.equal(await prisma.rateLimitBucket.count({ where: { scope } }), 2);
});

test("Retry-After counts down to the end of the current window", async () => {
  await prisma.rateLimitBucket.deleteMany();
  const scope = "test.window.retry";
  const rule = { limit: 1, windowMs: 90_000 };
  const base = { scope, identifier: "subject:three", rule };

  assert.equal((await checkRateLimit({ ...base, nowMs: T0 + 10_000 })).status, "allowed");
  const denied = await checkRateLimit({ ...base, nowMs: T0 + 30_000 });
  assert.equal(denied.status, "limited");
  assert.equal(denied.retryAfterSeconds, 60);
  assert.ok(denied.retryAfterSeconds >= 1 && denied.retryAfterSeconds <= rule.windowMs / 1000);
});

test("concurrent checks cannot bypass the limit (atomic counter)", async () => {
  await prisma.rateLimitBucket.deleteMany();
  const scope = "test.concurrent";
  const rule = { limit: 10, windowMs: 60_000 };

  const results = await Promise.all(
    Array.from({ length: 25 }, () =>
      checkRateLimit({ scope, identifier: "same-subject", rule, nowMs: T0 }),
    ),
  );

  assert.equal(results.filter((r) => r.status === "allowed").length, 10);
  assert.equal(results.filter((r) => r.status === "limited").length, 15);

  const rows = await prisma.rateLimitBucket.findMany({ where: { scope } });
  assert.equal(rows.length, 1, "all attempts land in one counter row");
  assert.equal(rows[0].count, 25, "every attempt was counted exactly once");
});

test("different scopes and rules do not interfere", async () => {
  await prisma.rateLimitBucket.deleteMany();
  const identifier = "subject:shared";
  const rule = { limit: 1, windowMs: 60_000 };

  assert.equal((await checkRateLimit({ scope: "test.scope.a", identifier, rule, nowMs: T0 })).status, "allowed");
  assert.equal((await checkRateLimit({ scope: "test.scope.a", identifier, rule, nowMs: T0 })).status, "limited");
  assert.equal(
    (await checkRateLimit({ scope: "test.scope.b", identifier, rule, nowMs: T0 })).status,
    "allowed",
    "a separate scope starts with its own budget",
  );
  assert.equal(
    (await checkRateLimit({ scope: "test.scope.a", identifier: "subject:other", rule, nowMs: T0 })).status,
    "allowed",
    "a separate identifier starts with its own budget",
  );
});

test("without trusted proxy headers every source shares one bounded bucket", async () => {
  const restore = process.env.TRUST_PROXY_HEADERS;
  delete process.env.TRUST_PROXY_HEADERS;
  try {
    assert.equal(rateLimitSourceIdentifier(formRequest("a@test.local", "203.0.113.9")), "source:unidentified");
    assert.equal(rateLimitSourceIdentifier(formRequest("b@test.local", "198.51.100.9")), "source:unidentified");
    assert.equal(rateLimitSourceIdentifier(undefined), "source:unidentified");
  } finally {
    process.env.TRUST_PROXY_HEADERS = restore;
  }

  assert.equal(rateLimitSourceIdentifier(formRequest("c@test.local", "203.0.113.9")), "ip:203.0.113.9");
});

test("login checks bind the source dimension independently of the submitted email", async () => {
  const checksOne = await loginRateLimitChecks(formRequest("one@test.local", "203.0.113.50"));
  const checksTwo = await loginRateLimitChecks(formRequest("two@test.local", "203.0.113.50"));

  assert.equal(checksOne[0].scope, "login.source");
  assert.equal(checksOne[0].identifier, "ip:203.0.113.50");
  assert.equal(checksTwo[0].identifier, checksOne[0].identifier, "source is identical across rotated emails");
  assert.equal(checksOne[1].scope, "login.account");
  assert.notEqual(checksOne[1].identifier, checksTwo[1].identifier, "account dimension follows the email");

  const noEmail = await loginRateLimitChecks(
    new Request(LOGIN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=x" }),
  );
  assert.equal(noEmail.length, 1, "unparseable bodies still consume the source bucket");
});

test("email rotation from one source still hits the source limit", async () => {
  await prisma.rateLimitBucket.deleteMany();
  const ip = "198.51.100.77";

  for (let i = 0; i < RATE_LIMITS.loginSource.limit; i += 1) {
    const allowed = await guardLoginCallback(formRequest(`rotate-${i}@test.local`, ip), T0);
    assert.equal(allowed, null, `attempt ${i + 1} is within the source budget`);
  }

  const denied = await guardLoginCallback(formRequest("rotate-final@test.local", ip), T0);
  assert.ok(denied);
  assert.equal(denied.status, 429);
  const body = await denied.json();
  assert.match(body.url, /error=RateLimited/);
});

test("429 responses carry Retry-After and a consistent non-sensitive body", async () => {
  await prisma.rateLimitBucket.deleteMany();
  const rule = { limit: 1, windowMs: 60_000 };
  const check = { scope: "test.http.429", identifier: "subject:http", rule };

  assert.equal(await enforceRateLimits([check], T0), null);
  const response = await enforceRateLimits([check], T0);
  assert.ok(response);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "Too many requests. Please wait and try again.",
  });
});

test("store failure fails closed with 503 and never silently allows", async () => {
  setRateLimitStoreForTesting({
    increment: async () => {
      throw new Error("store offline");
    },
  });
  try {
    const decision = await checkRateLimit({
      scope: "test.store.failure",
      identifier: "subject:down",
      rule: { limit: 1, windowMs: 1000 },
    });
    assert.deepEqual(decision, { status: "unavailable" });

    const viaHttp = await enforceRateLimits([
      { scope: "register.source", identifier: "ip:203.0.113.1", rule: RATE_LIMITS.registerSource },
    ]);
    assert.ok(viaHttp);
    assert.equal(viaHttp.status, 503);
    assert.deepEqual(await viaHttp.json(), {
      error: "This action is temporarily unavailable. Please try again shortly.",
    });

    const viaLogin = await guardLoginCallback(formRequest("person@test.local", "203.0.113.7"));
    assert.ok(viaLogin);
    assert.equal(viaLogin.status, 503);
    const loginBody = await viaLogin.json();
    assert.match(loginBody.url, /error=RateLimitUnavailable/);
  } finally {
    setRateLimitStoreForTesting(null);
  }
});

test("cleanupExpiredBuckets removes only rows past the retention horizon", async () => {
  await prisma.rateLimitBucket.deleteMany();
  const now = Date.now();
  await prisma.rateLimitBucket.create({
    data: {
      scope: "test.cleanup",
      keyHash: "old",
      windowStart: new Date(now - RATE_LIMIT_RETENTION_MS - 60_000),
      count: 3,
    },
  });
  await prisma.rateLimitBucket.create({
    data: { scope: "test.cleanup", keyHash: "fresh", windowStart: new Date(now - 60_000), count: 1 },
  });

  const removed = await cleanupExpiredBuckets(now - RATE_LIMIT_RETENTION_MS);
  assert.equal(removed, 1);
  const remaining = await prisma.rateLimitBucket.findMany({ where: { scope: "test.cleanup" } });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].keyHash, "fresh");
});
