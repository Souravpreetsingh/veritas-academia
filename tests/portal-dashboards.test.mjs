import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db.ts";
import {
  getStudentDashboard,
  getInstructorDashboard,
  listStudentDocuments,
} from "../src/lib/portal-dashboard.ts";

// Database-backed tests for the student and instructor dashboard read models.
// Runs against prisma/test.db, prepared by scripts/run-tests.mjs. Every test
// asserts that data is scoped to the authenticated actor: no cross-user or
// cross-instructor leakage, and no fabricated figures when nothing exists.

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

async function createStudent() {
  counter += 1;
  return prisma.user.create({
    data: {
      name: `Dashboard Student ${counter}`,
      email: `dashboard-student${counter}@test.local`,
      passwordHash: "hash",
      role: "STUDENT",
    },
  });
}

async function createAdmin() {
  counter += 1;
  return prisma.user.create({
    data: {
      name: `Dashboard Admin ${counter}`,
      email: `dashboard-admin${counter}@test.local`,
      passwordHash: "hash",
      role: "ADMIN",
    },
  });
}

async function createInstructor({ approved = true, active = true, suspended = false } = {}) {
  counter += 1;
  const user = await prisma.user.create({
    data: {
      name: `Dashboard Instructor ${counter}`,
      email: `dashboard-instructor${counter}@test.local`,
      passwordHash: "hash",
      role: "INSTRUCTOR",
      suspended,
      instructorProfile: {
        create: {
          headline: "Test faculty",
          isApproved: approved,
          isActive: active,
          services: {
            create: [
              {
                code: `DSVC-${counter}`,
                name: "Manuscript Audit",
                amountMinor: 8500,
                currency: "INR",
                turnaroundHours: 24,
              },
            ],
          },
        },
      },
    },
    include: { instructorProfile: { include: { services: true } } },
  });
  return {
    user,
    profile: user.instructorProfile,
    service: user.instructorProfile.services[0],
  };
}

async function createRequest({
  studentId,
  instructorProfileId,
  serviceId,
  status = "DRAFT",
  amountMinor = 8500,
}) {
  counter += 1;
  return prisma.serviceRequest.create({
    data: {
      reference: `REQ-DASH-${counter}`,
      studentId,
      instructorId: instructorProfileId,
      serviceId,
      title: `Dashboard request ${counter}`,
      status,
      amountMinor,
      currency: "INR",
    },
  });
}

async function createDocument({ ownerId, status = "AVAILABLE", scanStatus, requestId = null }) {
  counter += 1;
  return prisma.document.create({
    data: {
      ownerId,
      requestId,
      storageKey: `dashboard-test/${counter}`,
      originalName: `dashboard-file-${counter}.pdf`,
      contentType: "application/pdf",
      sizeBytes: 2048,
      status,
      scanStatus: scanStatus ?? (status === "AVAILABLE" ? "CLEAN" : "UNSCANNED"),
    },
  });
}

const actor = (user) => ({ id: user.id, role: user.role });

test("student dashboard counts and rows are scoped to the signed-in student", async () => {
  await reset();
  const studentA = await createStudent();
  const studentB = await createStudent();
  const { profile, service } = await createInstructor();

  await createRequest({
    studentId: studentA.id,
    instructorProfileId: profile.id,
    serviceId: service.id,
    status: "DRAFT",
  });
  await createRequest({
    studentId: studentA.id,
    instructorProfileId: profile.id,
    serviceId: service.id,
    status: "AWAITING_PAYMENT",
  });
  await createRequest({
    studentId: studentA.id,
    instructorProfileId: profile.id,
    serviceId: service.id,
    status: "COMPLETED",
  });
  const foreignRequest = await createRequest({
    studentId: studentB.id,
    instructorProfileId: profile.id,
    serviceId: service.id,
    status: "DRAFT",
  });

  await createDocument({ ownerId: studentA.id, status: "QUARANTINED" });
  await createDocument({ ownerId: studentA.id, status: "AVAILABLE" });
  await createDocument({ ownerId: studentB.id, status: "AVAILABLE" });

  const dashboard = await getStudentDashboard(actor(studentA));

  assert.equal(dashboard.totalRequests, 3);
  assert.equal(dashboard.openRequests, 2, "COMPLETED is terminal; draft and awaiting payment are open");
  assert.equal(dashboard.countsByStatus.DRAFT, 1);
  assert.equal(dashboard.countsByStatus.AWAITING_PAYMENT, 1);
  assert.equal(dashboard.countsByStatus.COMPLETED, 1);
  assert.equal(dashboard.recentRequests.length, 3);
  assert.ok(
    dashboard.recentRequests.every((request) => request.reference !== foreignRequest.reference),
    "another student's request must never appear",
  );
  assert.deepEqual(dashboard.documents, { total: 2, pendingScan: 1 });

  const other = await getStudentDashboard(actor(studentB));
  assert.equal(other.totalRequests, 1);
  assert.equal(other.recentRequests.length, 1);
  assert.equal(other.recentRequests[0].reference, foreignRequest.reference);
  assert.deepEqual(other.documents, { total: 1, pendingScan: 0 });
});

test("student dashboard shows an honest empty state without fabricated data", async () => {
  await reset();
  const student = await createStudent();

  const dashboard = await getStudentDashboard(actor(student));

  assert.equal(dashboard.totalRequests, 0);
  assert.equal(dashboard.openRequests, 0);
  assert.deepEqual(dashboard.countsByStatus, {});
  assert.deepEqual(dashboard.recentRequests, []);
  assert.deepEqual(dashboard.documents, { total: 0, pendingScan: 0 });
});

test("student document list only ever returns the owner's files", async () => {
  await reset();
  const studentA = await createStudent();
  const studentB = await createStudent();
  const { profile, service } = await createInstructor();

  const request = await createRequest({
    studentId: studentA.id,
    instructorProfileId: profile.id,
    serviceId: service.id,
    status: "DRAFT",
  });
  const attached = await createDocument({
    ownerId: studentA.id,
    status: "AVAILABLE",
    requestId: request.id,
  });
  await createDocument({ ownerId: studentA.id, status: "QUARANTINED" });
  const foreign = await createDocument({ ownerId: studentB.id, status: "AVAILABLE" });

  const documents = await listStudentDocuments(actor(studentA));

  assert.equal(documents.length, 2);
  assert.ok(documents.every((document) => document.id !== foreign.id));
  const attachedRow = documents.find((document) => document.id === attached.id);
  assert.equal(attachedRow.requestReference, request.reference);
  const unattachedRow = documents.find((document) => document.id !== attached.id);
  assert.equal(unattachedRow.requestReference, null);
});

test("instructor dashboard is refused for students and administrators", async () => {
  await reset();
  const student = await createStudent();
  const admin = await createAdmin();

  const forStudent = await getInstructorDashboard(actor(student));
  assert.equal(forStudent.eligible, false);
  assert.deepEqual(forStudent.recentRequests, []);
  assert.equal(forStudent.totalAssigned, 0);
  assert.deepEqual(forStudent.counts, {});

  const forAdmin = await getInstructorDashboard(actor(admin));
  assert.equal(forAdmin.eligible, false);
  assert.deepEqual(forAdmin.recentRequests, []);
  assert.equal(forAdmin.totalAssigned, 0);
});

test("instructor dashboard is refused for suspended, unapproved and inactive instructors", async () => {
  await reset();
  const suspended = await createInstructor({ suspended: true });
  const unapproved = await createInstructor({ approved: false });
  const inactive = await createInstructor({ active: false });
  const student = await createStudent();

  for (const setup of [suspended, unapproved, inactive]) {
    await createRequest({
      studentId: student.id,
      instructorProfileId: setup.profile.id,
      serviceId: setup.service.id,
      status: "PAID",
    });
  }

  for (const setup of [suspended, unapproved, inactive]) {
    const dashboard = await getInstructorDashboard(actor(setup.user));
    assert.equal(dashboard.eligible, false, `${setup.user.email} must not be eligible`);
    assert.deepEqual(dashboard.recentRequests, []);
    assert.equal(dashboard.totalAssigned, 0);
    assert.deepEqual(dashboard.counts, {});
  }
});

test("instructor dashboard returns only this instructor's assigned requests", async () => {
  await reset();
  const instructorA = await createInstructor();
  const instructorB = await createInstructor();
  const student = await createStudent();

  const statuses = ["PAID", "ACCEPTED", "AWAITING_PAYMENT", "DRAFT", "DECLINED", "COMPLETED", "PAID"];
  const ownRequests = [];
  for (const status of statuses) {
    ownRequests.push(
      await createRequest({
        studentId: student.id,
        instructorProfileId: instructorA.profile.id,
        serviceId: instructorA.service.id,
        status,
      }),
    );
  }
  const foreignRequest = await createRequest({
    studentId: student.id,
    instructorProfileId: instructorB.profile.id,
    serviceId: instructorB.service.id,
    status: "PAID",
  });

  const dashboard = await getInstructorDashboard(actor(instructorA.user));

  assert.equal(dashboard.eligible, true);
  assert.equal(dashboard.totalAssigned, 7);
  assert.equal(dashboard.recentRequests.length, 5, "dashboard preview is capped at five rows");
  assert.equal(dashboard.counts.PAID, 2);
  assert.equal(dashboard.counts.ACCEPTED, 1);
  assert.equal(dashboard.counts.AWAITING_PAYMENT, 1);
  const ownReferences = new Set(ownRequests.map((request) => request.reference));
  assert.ok(
    dashboard.recentRequests.every((request) => ownReferences.has(request.reference)),
    "only assigned requests may appear",
  );
  assert.ok(
    dashboard.recentRequests.every((request) => request.reference !== foreignRequest.reference),
    "another instructor's request must never appear",
  );

  const other = await getInstructorDashboard(actor(instructorB.user));
  assert.equal(other.eligible, true);
  assert.equal(other.totalAssigned, 1);
  assert.equal(other.recentRequests[0].reference, foreignRequest.reference);
  assert.equal(other.counts.PAID, 1);
});
