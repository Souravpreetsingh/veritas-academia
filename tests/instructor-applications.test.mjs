import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db.ts";
import {
  submitInstructorApplication,
  getMyInstructorApplication,
  withdrawInstructorApplication,
  listInstructorApplications,
  getAdminOverviewStats,
  getInstructorApplication,
  decideInstructorApplication,
} from "../src/lib/instructor-applications.ts";
import { publishInstructorService } from "../src/lib/instructor-services.ts";

// Database-backed tests for the instructor-application + approval workflow.
// Runs against prisma/test.db, prepared by scripts/run-tests.mjs. The test files
// are executed sequentially (--test-concurrency=1), so this suite never races
// the other database-backed suite.

const isCode = (code) => (err) => err && err.code === code;
const isName = (name) => (err) => err && err.name === name;

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

let counter = 0;
async function createUser(role = "STUDENT") {
  counter += 1;
  return prisma.user.create({
    data: {
      name: `User ${counter}`,
      email: `user${counter}@test.local`,
      passwordHash: "hash",
      role,
    },
  });
}

const actor = (user) => ({ id: user.id, role: user.role });

const validInput = (overrides = {}) => ({
  fullName: "Dr. Ada Lovelace",
  email: "ada@example.com",
  bio: "I hold a doctorate in computational mathematics and have supervised many theses.",
  expertise: "Statistics, Research Methods",
  qualifications: "PhD Computational Mathematics",
  termsAccepted: true,
  ...overrides,
});

const auditCount = (action) => prisma.auditEvent.count({ where: { action } });

test.after(async () => {
  await prisma.$disconnect();
});

test("a student can submit an application; it starts PENDING and is audited", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const application = await submitInstructorApplication({
    actor: actor(student),
    input: validInput(),
  });

  assert.equal(application.status, "PENDING");
  assert.equal(application.userId, student.id);

  const row = await prisma.instructorApplication.findUnique({ where: { id: application.id } });
  assert.equal(row.activeKey, student.id);
  assert.equal(await auditCount("instructor.application.submitted"), 1);
});

test("a second pending application is rejected and row count stays at one", async () => {
  await reset();
  const student = await createUser("STUDENT");
  await submitInstructorApplication({ actor: actor(student), input: validInput() });
  await assert.rejects(
    () => submitInstructorApplication({ actor: actor(student), input: validInput({ email: "other@example.com" }) }),
    isCode("CONFLICT"),
  );
  assert.equal(await prisma.instructorApplication.count({ where: { status: "PENDING" } }), 1);
  assert.equal(await auditCount("instructor.application.submit.denied"), 1);
});

test("non-students cannot submit an application", async () => {
  await reset();
  const instructor = await createUser("INSTRUCTOR");
  const admin = await createUser("ADMIN");
  await assert.rejects(
    () => submitInstructorApplication({ actor: actor(instructor), input: validInput() }),
    isCode("FORBIDDEN"),
  );
  await assert.rejects(
    () => submitInstructorApplication({ actor: actor(admin), input: validInput() }),
    isCode("FORBIDDEN"),
  );
  assert.equal(await prisma.instructorApplication.count(), 0);
});

test("validation errors block submission without creating a row", async () => {
  await reset();
  const student = await createUser("STUDENT");
  await assert.rejects(
    () =>
      submitInstructorApplication({
        actor: actor(student),
        input: validInput({ bio: "short", termsAccepted: false }),
      }),
    isCode("VALIDATION"),
  );
  assert.equal(await prisma.instructorApplication.count(), 0);
});

test("non-admins cannot list or decide applications", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const stranger = await createUser("STUDENT");
  const application = await submitInstructorApplication({ actor: actor(student), input: validInput() });

  await assert.rejects(
    () => listInstructorApplications({ actor: actor(student) }),
    isCode("FORBIDDEN"),
  );
  // The owner may view their own application, but a stranger may not.
  await assert.rejects(
    () => getInstructorApplication({ actor: actor(stranger), applicationId: application.id }),
    isCode("FORBIDDEN"),
  );
  await assert.rejects(
    () =>
      decideInstructorApplication({
        actor: actor(student),
        applicationId: application.id,
        decision: "APPROVE",
      }),
    isCode("FORBIDDEN"),
  );
  assert.ok((await auditCount("instructor.application.review.denied")) >= 3);
});

test("admin overview stats are zero on an empty database", async () => {
  await reset();
  const admin = await createUser("ADMIN");

  const stats = await getAdminOverviewStats({ actor: actor(admin) });
  assert.deepEqual(stats.applications, {
    pending: 0,
    approved: 0,
    rejected: 0,
    withdrawn: 0,
    total: 0,
  });
  assert.deepEqual(stats.accounts, { students: 0, instructors: 0, admins: 1 });
});

test("admin overview stats reflect real application and account counts", async () => {
  await reset();
  const pendingStudent = await createUser("STUDENT");
  const approvedStudent = await createUser("STUDENT");
  const rejectedStudent = await createUser("STUDENT");
  const withdrawnStudent = await createUser("STUDENT");
  await createUser("INSTRUCTOR");
  const admin = await createUser("ADMIN");

  await submitInstructorApplication({
    actor: actor(pendingStudent),
    input: validInput({ email: "pending@example.com" }),
  });
  const toApprove = await submitInstructorApplication({
    actor: actor(approvedStudent),
    input: validInput({ email: "approved@example.com" }),
  });
  const toReject = await submitInstructorApplication({
    actor: actor(rejectedStudent),
    input: validInput({ email: "rejected@example.com" }),
  });
  const toWithdraw = await submitInstructorApplication({
    actor: actor(withdrawnStudent),
    input: validInput({ email: "withdrawn@example.com" }),
  });

  await decideInstructorApplication({
    actor: actor(admin),
    applicationId: toApprove.id,
    decision: "APPROVE",
  });
  await decideInstructorApplication({
    actor: actor(admin),
    applicationId: toReject.id,
    decision: "REJECT",
    rejectionReason: "Qualifications could not be verified.",
  });
  await withdrawInstructorApplication({
    actor: actor(withdrawnStudent),
    applicationId: toWithdraw.id,
  });

  const stats = await getAdminOverviewStats({ actor: actor(admin) });
  assert.deepEqual(stats.applications, {
    pending: 1,
    approved: 1,
    rejected: 1,
    withdrawn: 1,
    total: 4,
  });
  // One explicit instructor plus the approved applicant, who is promoted out of
  // the student role by the approval transaction.
  assert.deepEqual(stats.accounts, { students: 3, instructors: 2, admins: 1 });
});

test("admin overview stats are denied to non-admins and audited", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const instructor = await createUser("INSTRUCTOR");

  await assert.rejects(
    () => getAdminOverviewStats({ actor: actor(student) }),
    isCode("FORBIDDEN"),
  );
  await assert.rejects(
    () => getAdminOverviewStats({ actor: actor(instructor) }),
    isCode("FORBIDDEN"),
  );
  assert.equal(await auditCount("instructor.application.review.denied"), 2);
});

test("an administrator who is also the applicant cannot decide their own application", async () => {
  await reset();
  const applicant = await createUser("STUDENT");
  const application = await submitInstructorApplication({
    actor: actor(applicant),
    input: validInput(),
  });
  const admin = await prisma.user.update({
    where: { id: applicant.id },
    data: { role: "ADMIN" },
  });

  await assert.rejects(
    () =>
      decideInstructorApplication({
        actor: actor(admin),
        applicationId: application.id,
        decision: "APPROVE",
      }),
    isCode("FORBIDDEN"),
  );

  // The application is untouched and the applicant keeps the role they had; the
  // denied self-review is audited.
  const row = await prisma.instructorApplication.findUnique({ where: { id: application.id } });
  assert.equal(row.status, "PENDING");
  assert.equal(row.instructorProfileId, null);
  assert.equal((await prisma.user.findUnique({ where: { id: applicant.id } })).role, "ADMIN");
  assert.equal(await prisma.instructorProfile.count({ where: { userId: applicant.id } }), 0);
  assert.equal(await auditCount("instructor.application.review.denied"), 1);
});

test("an admin approval promotes the applicant and creates an instructor profile", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const admin = await createUser("ADMIN");
  const application = await submitInstructorApplication({ actor: actor(student), input: validInput() });

  const decided = await decideInstructorApplication({
    actor: actor(admin),
    applicationId: application.id,
    decision: "APPROVE",
  });

  assert.equal(decided.status, "APPROVED");
  assert.equal(decided.reviewedById, admin.id);
  assert.ok(decided.instructorProfileId);

  const user = await prisma.user.findUnique({ where: { id: student.id } });
  assert.equal(user.role, "INSTRUCTOR");

  const profile = await prisma.instructorProfile.findUnique({ where: { userId: student.id } });
  assert.equal(profile.isApproved, true);
  assert.equal(profile.isActive, true);
  assert.equal(profile.approvedById, admin.id);

  assert.equal(await auditCount("instructor.application.approved"), 1);
});

test("rejection requires a reason and never promotes the applicant", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const admin = await createUser("ADMIN");
  const application = await submitInstructorApplication({ actor: actor(student), input: validInput() });

  await assert.rejects(
    () =>
      decideInstructorApplication({
        actor: actor(admin),
        applicationId: application.id,
        decision: "REJECT",
        rejectionReason: "no",
      }),
    isCode("VALIDATION"),
  );

  const decided = await decideInstructorApplication({
    actor: actor(admin),
    applicationId: application.id,
    decision: "REJECT",
    rejectionReason: "Qualifications could not be verified for this subject area.",
  });
  assert.equal(decided.status, "REJECTED");
  assert.match(decided.rejectionReason, /verified/);

  const user = await prisma.user.findUnique({ where: { id: student.id } });
  assert.equal(user.role, "STUDENT");
  assert.equal(await prisma.instructorProfile.count({ where: { userId: student.id } }), 0);
  assert.equal(await auditCount("instructor.application.rejected"), 1);
});

test("a decided application cannot be decided twice", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const admin = await createUser("ADMIN");
  const application = await submitInstructorApplication({ actor: actor(student), input: validInput() });

  await decideInstructorApplication({ actor: actor(admin), applicationId: application.id, decision: "APPROVE" });
  await assert.rejects(
    () => decideInstructorApplication({ actor: actor(admin), applicationId: application.id, decision: "APPROVE" }),
    isCode("CONFLICT"),
  );
  assert.equal(await auditCount("instructor.application.decision.conflict"), 1);
});

test("a suspended applicant cannot be approved", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const admin = await createUser("ADMIN");
  const application = await submitInstructorApplication({ actor: actor(student), input: validInput() });
  await prisma.user.update({ where: { id: student.id }, data: { suspended: true } });

  await assert.rejects(
    () => decideInstructorApplication({ actor: actor(admin), applicationId: application.id, decision: "APPROVE" }),
    isCode("CONFLICT"),
  );
});

test("a student may withdraw a pending application and then reapply", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const application = await submitInstructorApplication({ actor: actor(student), input: validInput() });

  const withdrawn = await withdrawInstructorApplication({
    actor: actor(student),
    applicationId: application.id,
  });
  assert.equal(withdrawn.status, "WITHDRAWN");
  const row = await prisma.instructorApplication.findUnique({ where: { id: application.id } });
  assert.equal(row.activeKey, null);

  const reapplied = await submitInstructorApplication({ actor: actor(student), input: validInput() });
  assert.equal(reapplied.status, "PENDING");
  assert.notEqual(reapplied.id, application.id);
});

test("withdrawing another user's application is forbidden", async () => {
  await reset();
  const owner = await createUser("STUDENT");
  const stranger = await createUser("STUDENT");
  const application = await submitInstructorApplication({ actor: actor(owner), input: validInput() });

  await assert.rejects(
    () => withdrawInstructorApplication({ actor: actor(stranger), applicationId: application.id }),
    isCode("FORBIDDEN"),
  );
});

test("an already-approved applicant cannot submit again", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const admin = await createUser("ADMIN");
  const application = await submitInstructorApplication({ actor: actor(student), input: validInput() });
  await decideInstructorApplication({ actor: actor(admin), applicationId: application.id, decision: "APPROVE" });

  // Simulate a stale session still carrying the STUDENT role.
  await assert.rejects(
    () =>
      submitInstructorApplication({
        actor: { id: student.id, role: "STUDENT" },
        input: validInput({ email: "again@example.com" }),
      }),
    isCode("CONFLICT"),
  );
});

test("simultaneous decisions resolve to exactly one winner", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const admin = await createUser("ADMIN");
  const application = await submitInstructorApplication({ actor: actor(student), input: validInput() });

  const results = await Promise.allSettled([
    decideInstructorApplication({ actor: actor(admin), applicationId: application.id, decision: "APPROVE" }),
    decideInstructorApplication({
      actor: actor(admin),
      applicationId: application.id,
      decision: "REJECT",
      rejectionReason: "Insufficient evidence of subject-matter expertise.",
    }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.equal(fulfilled.length, 1);

  const row = await prisma.instructorApplication.findUnique({ where: { id: application.id } });
  assert.ok(["APPROVED", "REJECTED"].includes(row.status));
});

test("listing supports status filtering and admin-only access", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const admin = await createUser("ADMIN");
  await submitInstructorApplication({ actor: actor(student), input: validInput() });

  const pending = await listInstructorApplications({ actor: actor(admin), status: "PENDING" });
  assert.equal(pending.total, 1);

  const rejected = await listInstructorApplications({ actor: actor(admin), status: "REJECTED" });
  assert.equal(rejected.total, 0);

  await assert.rejects(
    () => listInstructorApplications({ actor: actor(admin), status: "BOGUS" }),
    isCode("VALIDATION"),
  );
});

test("an unapproved or non-instructor account cannot publish a service", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const bareInstructor = await createUser("INSTRUCTOR");
  const unapproved = await createUser("INSTRUCTOR");
  await prisma.instructorProfile.create({ data: { userId: unapproved.id, isApproved: false } });

  const service = { code: "SIMILARITY", name: "Similarity Report", amountMinor: 49900, turnaroundHours: 24 };
  await assert.rejects(
    () => publishInstructorService({ actor: actor(student), input: service }),
    isName("IneligibleError"),
  );
  await assert.rejects(
    () => publishInstructorService({ actor: actor(bareInstructor), input: service }),
    isName("IneligibleError"),
  );
  await assert.rejects(
    () => publishInstructorService({ actor: actor(unapproved), input: service }),
    isName("IneligibleError"),
  );
  assert.equal(await prisma.instructorService.count(), 0);
});

test("an approved instructor can publish a service and duplicates are rejected", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const admin = await createUser("ADMIN");
  const application = await submitInstructorApplication({ actor: actor(student), input: validInput() });
  await decideInstructorApplication({ actor: actor(admin), applicationId: application.id, decision: "APPROVE" });

  const instructor = await prisma.user.findUnique({ where: { id: student.id } });
  assert.equal(instructor.role, "INSTRUCTOR");

  const service = await publishInstructorService({
    actor: actor(instructor),
    input: { code: "SIMILARITY", name: "Similarity Report", amountMinor: 49900, turnaroundHours: 24 },
  });
  assert.equal(service.code, "SIMILARITY");
  assert.equal(await auditCount("instructor.service.published"), 1);

  await assert.rejects(
    () =>
      publishInstructorService({
        actor: actor(instructor),
        input: { code: "SIMILARITY", name: "Duplicate", amountMinor: 100, turnaroundHours: 1 },
      }),
    isCode("CONFLICT"),
  );
});

test("getMyInstructorApplication returns the latest application or null", async () => {
  await reset();
  const student = await createUser("STUDENT");
  assert.equal(await getMyInstructorApplication({ actor: actor(student) }), null);

  await submitInstructorApplication({ actor: actor(student), input: validInput() });
  const mine = await getMyInstructorApplication({ actor: actor(student) });
  assert.equal(mine.status, "PENDING");
});

test("a suspended instructor cannot publish, even with an approved profile", async () => {
  await reset();
  const student = await createUser("STUDENT");
  const admin = await createUser("ADMIN");
  const application = await submitInstructorApplication({ actor: actor(student), input: validInput() });
  await decideInstructorApplication({ actor: actor(admin), applicationId: application.id, decision: "APPROVE" });

  // The account was approved, then suspended. Its stale JWT still carries the
  // INSTRUCTOR role, but the server must re-read state and refuse to publish.
  await prisma.user.update({ where: { id: student.id }, data: { suspended: true } });
  const suspended = await prisma.user.findUnique({ where: { id: student.id } });
  assert.equal(suspended.role, "INSTRUCTOR");

  await assert.rejects(
    () =>
      publishInstructorService({
        actor: { id: student.id, role: "INSTRUCTOR" },
        input: { code: "SIMILARITY", name: "Similarity Report", amountMinor: 49900, turnaroundHours: 24 },
      }),
    isName("IneligibleError"),
  );
  assert.equal(await prisma.instructorService.count(), 0);
  assert.equal(await auditCount("instructor.service.publish.denied"), 1);
});
