import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/db.ts";
import { POST as registerPOST } from "../src/app/api/register/route.ts";
import { POST as instructorRegisterPOST } from "../src/app/api/instructor/register/route.ts";
import {
  guardCredentialsCallback,
  guardLoginCallback,
  guardPaymentOrder,
  guardPaymentVerify,
  guardUpload,
  isCredentialsCallback,
} from "../src/lib/rate-limit-guard.ts";
import { setRateLimitStoreForTesting } from "../src/lib/rate-limit.ts";

// Endpoint-level rate-limit tests. These import the REAL route handlers and run
// against prisma/test.db (prepared by scripts/run-tests.mjs).

const previousTrust = process.env.TRUST_PROXY_HEADERS;
process.env.TRUST_PROXY_HEADERS = "true";

function jsonRequest(url, payload, ip) {
  const headers = { "content-type": "application/json" };
  if (ip) headers["x-forwarded-for"] = ip;
  return new Request(url, {
    method: "POST",
    headers,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

function registerRequest(payload, ip) {
  return jsonRequest("http://localhost/api/register", payload, ip);
}

function instructorRequest(payload, ip) {
  return jsonRequest("http://localhost/api/instructor/register", payload, ip);
}

function loginRequest(email, ip) {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (ip) headers["x-forwarded-for"] = ip;
  return new Request("http://localhost/api/auth/callback/credentials", {
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

async function reset() {
  await prisma.rateLimitBucket.deleteMany();
  await prisma.paymentWebhookEvent.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.analysisResult.deleteMany();
  await prisma.analysisJob.deleteMany();
  await prisma.document.deleteMany();
  await prisma.serviceRequest.deleteMany();
  await prisma.instructorService.deleteMany();
  await prisma.instructorApplication.deleteMany();
  await prisma.instructorProfile.deleteMany();
  await prisma.studentProfile.deleteMany();
  await prisma.user.deleteMany();
}

function studentPayload(i) {
  return {
    name: "Rate Limit User",
    email: `rate-limit-${i}@test.local`,
    password: "correct horse battery",
  };
}

test.after(async () => {
  if (previousTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
  else process.env.TRUST_PROXY_HEADERS = previousTrust;
  setRateLimitStoreForTesting(null);
  await prisma.$disconnect();
});

test("registration is limited per source and email rotation does not bypass it", async () => {
  await reset();
  const ip = "198.51.100.30";
  const responses = [];
  for (let i = 0; i < 6; i += 1) {
    responses.push(await registerPOST(registerRequest(studentPayload(i), ip)));
  }

  assert.deepEqual(
    responses.slice(0, 5).map((r) => r.status),
    [201, 201, 201, 201, 201],
    "the first five attempts succeed",
  );
  assert.equal(responses[5].status, 429, "the sixth attempt from the same source is denied");
  assert.equal(responses[5].headers.get("cache-control"), "no-store");

  const retryAfter = Number(responses[5].headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 3600);

  const body = await responses[5].json();
  assert.equal(body.error, "Too many requests. Please wait and try again.");

  assert.equal(await prisma.user.count(), 5, "denied attempts create no accounts");
});

test("limits are independent per category and per source", async () => {
  await reset();
  const exhaustedIp = "198.51.100.31";
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await registerPOST(registerRequest(studentPayload(i), exhaustedIp))).status, 201);
  }
  assert.equal((await registerPOST(registerRequest(studentPayload(99), exhaustedIp))).status, 429);

  // A different source still has its full budget.
  const other = await registerPOST(registerRequest(studentPayload(100), "198.51.100.32"));
  assert.equal(other.status, 201);

  // Other categories with the same fresh subject are unaffected.
  assert.equal(await guardUpload("user-independent"), null);
  assert.equal(await guardPaymentOrder("user-independent"), null);
  assert.equal(await guardPaymentVerify("user-independent"), null);
  assert.equal(await guardLoginCallback(loginRequest("person@test.local", "198.51.100.32")), null);
});

test("concurrent registration attempts cannot exceed the shared source limit", async () => {
  await reset();
  const ip = "198.51.100.33";
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, i) => registerPOST(registerRequest(studentPayload(i), ip))),
  );

  assert.equal(responses.filter((r) => r.status === 201).length, 5);
  assert.equal(responses.filter((r) => r.status === 429).length, 3);
  assert.equal(await prisma.user.count(), 5, "exactly the admitted attempts created accounts");
});

test("instructor onboarding is limited per source before any work runs", async () => {
  await reset();
  const ip = "198.51.100.34";
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    // Malformed bodies are rejected with 400 while the attempt is counted; the
    // sixth attempt is denied before the body is even read.
    statuses.push((await instructorRegisterPOST(instructorRequest("{ not json", ip))).status);
  }
  assert.deepEqual(statuses.slice(0, 5), [400, 400, 400, 400, 400]);
  assert.equal(statuses[5], 429);
  assert.equal(await prisma.user.count(), 0);
});

test("credentials sign-in is limited and returns a NextAuth-shaped 429", async () => {
  await reset();
  const ip = "198.51.100.35";
  const email = "login-limit@test.local";

  for (let i = 0; i < 10; i += 1) {
    const allowed = await guardCredentialsCallback(loginRequest(email, ip));
    assert.equal(allowed, null, `attempt ${i + 1} is within the account budget`);
  }

  const denied = await guardCredentialsCallback(loginRequest(email, ip));
  assert.ok(denied);
  assert.equal(denied.status, 429);
  const retryAfter = Number(denied.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60);

  const body = await denied.json();
  const url = new URL(body.url);
  assert.equal(url.pathname, "/login");
  assert.equal(url.searchParams.get("error"), "RateLimited");

  // Non-credentials auth requests are never limited by this guard.
  assert.equal(
    await guardCredentialsCallback(new Request("http://localhost/api/auth/signout", { method: "POST" })),
    null,
  );
});

test("isCredentialsCallback only matches the credentials callback POST", () => {
  assert.equal(
    isCredentialsCallback(new Request("http://localhost/api/auth/callback/credentials", { method: "POST" })),
    true,
  );
  assert.equal(
    isCredentialsCallback(new Request("http://localhost/api/auth/callback/credentials")),
    false,
    "GET requests are not limited here",
  );
  assert.equal(
    isCredentialsCallback(new Request("http://localhost/api/auth/signout", { method: "POST" })),
    false,
  );
  assert.equal(
    isCredentialsCallback(new Request("http://localhost/api/auth/session")),
    false,
  );
});

test("limiter store failure fails closed with 503 and creates nothing", async () => {
  await reset();
  setRateLimitStoreForTesting({
    increment: async () => {
      throw new Error("store offline");
    },
  });
  try {
    const registration = await registerPOST(
      registerRequest(studentPayload(0), "198.51.100.36"),
    );
    assert.equal(registration.status, 503);
    assert.deepEqual(await registration.json(), {
      error: "This action is temporarily unavailable. Please try again shortly.",
    });
    assert.equal(await prisma.user.count(), 0);

    const onboarding = await instructorRegisterPOST(instructorRequest("{ not json", "198.51.100.37"));
    assert.equal(onboarding.status, 503);

    assert.equal((await guardUpload("user-store-failure")).status, 503);
    assert.equal((await guardPaymentOrder("user-store-failure")).status, 503);
    assert.equal((await guardPaymentVerify("user-store-failure")).status, 503);

    const login = await guardLoginCallback(loginRequest("person@test.local", "203.0.113.77"));
    assert.equal(login.status, 503);
    assert.match((await login.json()).url, /error=RateLimitUnavailable/);
  } finally {
    setRateLimitStoreForTesting(null);
  }
});

test("regression: every sensitive route still invokes its rate-limit guard", () => {
  const testsDir = path.dirname(fileURLToPath(import.meta.url));
  const expectations = [
    ["../src/app/api/register/route.ts", "guardRegistration"],
    ["../src/app/api/instructor/register/route.ts", "guardInstructorRegistration"],
    ["../src/app/api/documents/route.ts", "guardUpload"],
    ["../src/app/api/student/requests/[id]/payment/route.ts", "guardPaymentOrder"],
    ["../src/app/api/student/requests/[id]/payment/verify/route.ts", "guardPaymentVerify"],
    ["../src/app/api/auth/[...nextauth]/route.ts", "guardCredentialsCallback"],
  ];
  for (const [relative, guard] of expectations) {
    const source = readFileSync(path.join(testsDir, relative), "utf8");
    assert.ok(source.includes(guard), `${relative} must call ${guard}`);
  }

  // The Razorpay webhook deliberately stays unlimited: provider retries must
  // never be throttled; authenticity and idempotency come from its signature
  // and event-id checks instead.
  const webhook = readFileSync(
    path.join(testsDir, "../src/app/api/webhooks/razorpay/route.ts"),
    "utf8",
  );
  assert.equal(webhook.includes("rate-limit"), false);
});
