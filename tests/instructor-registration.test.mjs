import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db.ts";
import { POST } from "../src/app/api/instructor/register/route.ts";
import { verifyPassword } from "../src/lib/password.ts";
import { evaluateInstructorEligibility } from "../src/lib/instructor-eligibility.ts";
import { publishInstructorService } from "../src/lib/instructor-services.ts";
import {
  decideInstructorApplication,
  hasInstructorApplication,
} from "../src/lib/instructor-applications.ts";

// Integration tests for instructor-path onboarding
// (POST /api/instructor/register). The endpoint is public but can only create a
// STUDENT-role account plus a PENDING instructor application; approval remains a
// separate administrator decision, and no instructor capability is granted at
// onboarding time. Runs against prisma/test.db, prepared by scripts/run-tests.mjs.
//
// The endpoint is rate-limited per source (see tests/rate-limit-routes.test.mjs
// for that behavior). To keep these functional tests independent of the
// limiter, each request is given a distinct trusted source IP.

const previousTrust = process.env.TRUST_PROXY_HEADERS;
process.env.TRUST_PROXY_HEADERS = "true";

let ipSequence = 1;

function registerRequest(payload, ip = `198.18.1.${(ipSequence += 1) % 250}`) {
  return new Request("http://localhost/api/instructor/register", {
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

function validPayload(overrides = {}) {
  return {
    fullName: "Dr. Ada Lovelace",
    email: "ada.instructor@test.local",
    phone: "+1 555 0100",
    bio: "Fifteen years of experience teaching and supervising research in applied mathematics and statistics.",
    expertise: "Statistics, Research Methods",
    qualifications: "PhD Applied Mathematics",
    termsAccepted: true,
    password: "correct-horse-battery",
    ...overrides,
  };
}

test.after(async () => {
  if (previousTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
  else process.env.TRUST_PROXY_HEADERS = previousTrust;
  await prisma.$disconnect();
});

test("instructor onboarding creates a pending applicant account directly", async () => {
  await reset();
  const res = await POST(registerRequest(validPayload({ role: "ADMIN" })));
  assert.equal(res.status, 201);

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.application.status, "PENDING");

  const user = await prisma.user.findUnique({
    where: { email: "ada.instructor@test.local" },
  });
  assert.ok(user);
  assert.equal(user.role, "STUDENT", "instructor privileges are never granted at onboarding");
  assert.ok(
    await prisma.studentProfile.findUnique({ where: { userId: user.id } }),
    "the unified account keeps a consistent student profile",
  );
  assert.equal(
    await prisma.instructorProfile.count({ where: { userId: user.id } }),
    0,
    "no instructor profile exists before approval",
  );
  assert.equal(await verifyPassword("correct-horse-battery", user.passwordHash), true);

  const application = await prisma.instructorApplication.findUnique({
    where: { id: body.application.id },
  });
  assert.equal(application.userId, user.id);
  assert.equal(application.activeKey, user.id);
  assert.equal(await hasInstructorApplication(user.id), true);
});

test("a pending applicant cannot use instructor capabilities", async () => {
  await reset();
  assert.equal((await POST(registerRequest(validPayload()))).status, 201);
  const user = await prisma.user.findUnique({
    where: { email: "ada.instructor@test.local" },
  });

  const eligibility = evaluateInstructorEligibility({
    role: "STUDENT",
    suspended: false,
    profile: null,
  });
  assert.equal(eligibility.eligible, false);

  await assert.rejects(
    () =>
      publishInstructorService({
        actor: { id: user.id, role: "STUDENT" },
        input: {
          code: "SIMILARITY",
          name: "Similarity Report",
          amountMinor: 49900,
          turnaroundHours: 24,
        },
      }),
    (error) => error?.name === "IneligibleError",
  );
  assert.equal(await prisma.instructorService.count(), 0);
});

test("administrator approval promotes an onboarding applicant to instructor", async () => {
  await reset();
  assert.equal((await POST(registerRequest(validPayload()))).status, 201);
  const applicant = await prisma.user.findUnique({
    where: { email: "ada.instructor@test.local" },
  });
  const application = await prisma.instructorApplication.findFirst({
    where: { userId: applicant.id },
  });
  const admin = await prisma.user.create({
    data: { name: "Reviewer", email: "reviewer@test.local", passwordHash: "unused", role: "ADMIN" },
  });

  await decideInstructorApplication({
    actor: { id: admin.id, role: "ADMIN" },
    applicationId: application.id,
    decision: "APPROVE",
  });

  const promoted = await prisma.user.findUnique({ where: { id: applicant.id } });
  assert.equal(promoted.role, "INSTRUCTOR");
  const profile = await prisma.instructorProfile.findUnique({
    where: { userId: applicant.id },
  });
  assert.ok(profile);
  assert.equal(profile.isApproved, true);

  const eligibility = evaluateInstructorEligibility({
    role: promoted.role,
    suspended: promoted.suspended,
    profile,
  });
  assert.equal(eligibility.eligible, true);
});

test("duplicate instructor onboarding email is rejected without a second account", async () => {
  await reset();
  assert.equal((await POST(registerRequest(validPayload()))).status, 201);

  const res = await POST(registerRequest(validPayload()));
  assert.equal(res.status, 409);
  assert.equal(
    await prisma.user.count({ where: { email: "ada.instructor@test.local" } }),
    1,
  );
  assert.equal(await prisma.instructorApplication.count(), 1);
});

test("weak passwords and missing terms are rejected before any account is created", async () => {
  await reset();

  const weak = await POST(registerRequest(validPayload({ password: "short" })));
  assert.equal(weak.status, 422);

  const noTerms = await POST(registerRequest(validPayload({ termsAccepted: false })));
  assert.equal(noTerms.status, 422);

  assert.equal(await prisma.user.count(), 0);
  assert.equal(await prisma.instructorApplication.count(), 0);
});
