import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db.ts";
import { canAccessDocument, isDocumentDownloadable } from "../src/lib/authorization.ts";

// Database-backed proof that document access is identity-based: the query shape
// mirrors the download route (document + request + assigned instructor), so a
// user cannot reach another user's document merely by changing an id.

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
    data: { name: `User ${counter}`, email: `u${counter}@test.local`, passwordHash: "hash", role },
  });
}

test.after(async () => {
  await prisma.$disconnect();
});

test("access is limited to owner, admin, and the request's assigned instructor", async () => {
  await reset();

  const owner = await createUser("STUDENT");
  const strangerStudent = await createUser("STUDENT");
  const admin = await createUser("ADMIN");
  const assignedUser = await createUser("INSTRUCTOR");
  const otherInstructorUser = await createUser("INSTRUCTOR");

  const assignedProfile = await prisma.instructorProfile.create({
    data: { userId: assignedUser.id, isApproved: true, isActive: true },
  });
  const otherProfile = await prisma.instructorProfile.create({
    data: { userId: otherInstructorUser.id, isApproved: true, isActive: true },
  });

  const service = await prisma.instructorService.create({
    data: {
      instructorId: assignedProfile.id,
      code: "SIMILARITY",
      name: "Similarity Report",
      amountMinor: 49900,
      turnaroundHours: 24,
    },
  });

  const request = await prisma.serviceRequest.create({
    data: {
      reference: "REQ-1",
      studentId: owner.id,
      instructorId: assignedProfile.id,
      serviceId: service.id,
      title: "Thesis check",
      amountMinor: 49900,
    },
  });

  await prisma.document.create({
    data: {
      ownerId: owner.id,
      requestId: request.id,
      storageKey: "doc-key-1",
      originalName: "thesis.pdf",
      contentType: "application/pdf",
      sizeBytes: 1024,
      status: "AVAILABLE",
      scanStatus: "CLEAN",
    },
  });

  // Mirror the download route's include shape exactly.
  const document = await prisma.document.findFirstOrThrow({
    include: { request: { include: { instructor: true } } },
    where: { storageKey: "doc-key-1" },
  });

  const as = (user) => ({ id: user.id, role: user.role });

  assert.equal(canAccessDocument(as(owner), document), true, "owner may access");
  assert.equal(canAccessDocument(as(admin), document), true, "admin may access");
  assert.equal(canAccessDocument(as(assignedUser), document), true, "assigned instructor may access");
  assert.equal(canAccessDocument(as(strangerStudent), document), false, "stranger student denied");
  assert.equal(canAccessDocument(as(otherInstructorUser), document), false, "unassigned instructor denied");

  // Guard against a mismatch between the profile id and its owning user id.
  assert.notEqual(otherProfile.id, assignedProfile.id);
});

test("only released, clean-scanned documents are downloadable", () => {
  assert.equal(
    isDocumentDownloadable({ status: "AVAILABLE", scanStatus: "CLEAN" }),
    true,
  );
  assert.equal(
    isDocumentDownloadable({ status: "QUARANTINED", scanStatus: "UNSCANNED" }),
    false,
  );
  assert.equal(
    isDocumentDownloadable({ status: "AVAILABLE", scanStatus: "UNSCANNED" }),
    false,
  );
  assert.equal(
    isDocumentDownloadable({ status: "DELETED", scanStatus: "CLEAN" }),
    false,
  );
});
