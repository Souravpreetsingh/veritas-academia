import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db.ts";
import { POST } from "../src/app/api/register/route.ts";

// Integration tests for the public registration endpoint. These import the REAL
// route handler and hit the dedicated test database, so they prove that no
// request body can escalate a new account beyond STUDENT.
//
// The endpoint is rate-limited per source (see tests/rate-limit-routes.test.mjs
// for that behavior). To keep these functional tests independent of the
// limiter, each request is given a distinct trusted source IP.

const previousTrust = process.env.TRUST_PROXY_HEADERS;
process.env.TRUST_PROXY_HEADERS = "true";

let ipSequence = 1;

function registerRequest(payload, ip = `198.18.0.${(ipSequence += 1) % 250}`) {
  return new Request("http://localhost/api/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

async function reset() {
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

test.after(async () => {
  if (previousTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
  else process.env.TRUST_PROXY_HEADERS = previousTrust;
  await prisma.$disconnect();
});

test("registration creates a STUDENT and ignores a body-supplied ADMIN role", async () => {
  await reset();
  const res = await POST(
    registerRequest({
      name: "Eve Attacker",
      email: "eve@example.com",
      password: "correct horse battery",
      role: "ADMIN",
    }),
  );

  assert.equal(res.status, 201);
  const user = await prisma.user.findUnique({ where: { email: "eve@example.com" } });
  assert.ok(user);
  assert.equal(user.role, "STUDENT");
  const profile = await prisma.studentProfile.findUnique({ where: { userId: user.id } });
  assert.ok(profile, "a student profile is created");
});

test("a body-supplied INSTRUCTOR role is likewise ignored", async () => {
  await reset();
  await POST(
    registerRequest({
      name: "Mallory",
      email: "mallory@example.com",
      password: "correct horse battery",
      role: "INSTRUCTOR",
    }),
  );

  const user = await prisma.user.findUnique({ where: { email: "mallory@example.com" } });
  assert.equal(user.role, "STUDENT");
  assert.equal(await prisma.instructorProfile.count({ where: { userId: user.id } }), 0);
});

test("duplicate email is rejected with 409 and does not create a second row", async () => {
  await reset();
  const body = { name: "Ada Love", email: "dup@example.com", password: "correct horse battery" };
  assert.equal((await POST(registerRequest(body))).status, 201);

  const res = await POST(registerRequest(body));
  assert.equal(res.status, 409);
  assert.equal(await prisma.user.count({ where: { email: "dup@example.com" } }), 1);
});

test("invalid input is rejected without creating a user", async () => {
  await reset();
  const cases = [
    { name: "A", email: "a@example.com", password: "correct horse battery" }, // name too short
    { name: "Valid Name", email: "not-an-email", password: "correct horse battery" },
    { name: "Valid Name", email: "b@example.com", password: "short" }, // fails policy
  ];
  for (const c of cases) {
    const res = await POST(registerRequest(c));
    assert.equal(res.status, 400);
  }
  assert.equal(await prisma.user.count(), 0);
});

test("malformed JSON is rejected with 400", async () => {
  await reset();
  const res = await POST(registerRequest("{ not json"));
  assert.equal(res.status, 400);
  assert.equal(await prisma.user.count(), 0);
});
