import test from "node:test";
import assert from "node:assert/strict";
import { Prisma, PrismaClient } from "@prisma/client";

// Runs against the dedicated test database prepared by scripts/run-tests.mjs
// (DATABASE_URL=file:./test.db). Never points at the development database.
const prisma = new PrismaClient();

function isKnownError(err, code) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
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
  await prisma.instructorProfile.deleteMany();
  await prisma.studentProfile.deleteMany();
  await prisma.user.deleteMany();
}

async function createUser(email = "owner@test.local") {
  return prisma.user.create({ data: { name: "Test User", email, passwordHash: "hash" } });
}

const baseDocument = (ownerId) => ({
  ownerId,
  storageKey: `key-${Math.random().toString(36).slice(2)}`,
  originalName: "draft.pdf",
  contentType: "application/pdf",
  sizeBytes: 1234,
});

test.after(async () => {
  await prisma.$disconnect();
});

test("Document requires an existing owner (foreign key enforced)", async () => {
  await reset();
  await assert.rejects(
    () => prisma.document.create({ data: { ...baseDocument("missing-user"), storageKey: "orphan" } }),
    (err) => isKnownError(err, "P2003"),
  );
});

test("storageKey is unique across documents", async () => {
  await reset();
  const user = await createUser();
  await prisma.document.create({ data: { ...baseDocument(user.id), storageKey: "duplicate-key" } });
  await assert.rejects(
    () => prisma.document.create({ data: { ...baseDocument(user.id), storageKey: "duplicate-key" } }),
    (err) => isKnownError(err, "P2002"),
  );
});

test("deleting a user cascades to their documents", async () => {
  await reset();
  const user = await createUser();
  await prisma.document.create({ data: baseDocument(user.id) });
  assert.equal(await prisma.document.count(), 1);
  await prisma.user.delete({ where: { id: user.id } });
  assert.equal(await prisma.document.count(), 0);
});

test("deleting a document cascades to analysis jobs and results", async () => {
  await reset();
  const user = await createUser();
  const doc = await prisma.document.create({ data: baseDocument(user.id) });
  const job = await prisma.analysisJob.create({
    data: { documentId: doc.id, requestedById: user.id, type: "SIMILARITY" },
  });
  await prisma.analysisResult.create({ data: { jobId: job.id, status: "UNCONFIGURED" } });

  await prisma.document.delete({ where: { id: doc.id } });
  assert.equal(await prisma.analysisJob.count(), 0);
  assert.equal(await prisma.analysisResult.count(), 0);
});

test("AnalysisResult is unique per job", async () => {
  await reset();
  const user = await createUser();
  const doc = await prisma.document.create({ data: baseDocument(user.id) });
  const job = await prisma.analysisJob.create({
    data: { documentId: doc.id, requestedById: user.id, type: "AI_WRITING" },
  });
  await prisma.analysisResult.create({ data: { jobId: job.id, status: "UNCONFIGURED" } });
  await assert.rejects(
    () => prisma.analysisResult.create({ data: { jobId: job.id, status: "COMPLETED" } }),
    (err) => isKnownError(err, "P2002"),
  );
});

test("analysis defaults to unconfigured and scores stay null (no fabricated data)", async () => {
  await reset();
  const user = await createUser();
  const doc = await prisma.document.create({ data: baseDocument(user.id) });
  const job = await prisma.analysisJob.create({
    data: { documentId: doc.id, requestedById: user.id, type: "SIMILARITY" },
  });

  assert.equal(job.provider, "unconfigured");
  assert.equal(job.status, "UNCONFIGURED");
  assert.equal(job.providerJobId, null);
  assert.equal(job.providerStatus, null);
  assert.equal(job.providerVersion, null);
  assert.equal(job.activeKey, null);
  assert.equal(job.failureCount, 0);
  assert.equal(job.errorCategory, null);
  assert.equal(job.startedAt, null);
  assert.equal(job.submittedAt, null);
  assert.equal(job.nextAttemptAt, null);
  assert.equal(job.completedAt, null);
  assert.equal(job.failedAt, null);

  const result = await prisma.analysisResult.create({
    data: { jobId: job.id, status: "UNCONFIGURED" },
  });
  assert.equal(result.similarityPercent, null);
  assert.equal(result.aiLikelihood, null);
  assert.equal(result.matches, null);
  assert.equal(result.segments, null);
  assert.equal(result.providerVersion, null);
  assert.equal(result.metadata, null);
  assert.equal(result.providerPayload, null);
});

test("document status defaults to AVAILABLE", async () => {
  await reset();
  const user = await createUser();
  const doc = await prisma.document.create({ data: baseDocument(user.id) });
  assert.equal(doc.status, "AVAILABLE");
});

test("document scan state defaults to UNSCANNED with no attempts", async () => {
  await reset();
  const user = await createUser();
  const doc = await prisma.document.create({ data: baseDocument(user.id) });
  assert.equal(doc.scanStatus, "UNSCANNED");
  assert.equal(doc.scanAttempts, 0);
  assert.equal(doc.scanReason, null);
  assert.equal(doc.scanSignature, null);
  assert.equal(doc.scannedAt, null);
});

test("audit events persist with non-sensitive metadata", async () => {
  await reset();
  const user = await createUser();
  const event = await prisma.auditEvent.create({
    data: {
      actorId: user.id,
      action: "document.upload",
      targetType: "Document",
      targetId: "doc-1",
      metadata: JSON.stringify({ contentType: "application/pdf", sizeBytes: 1234 }),
      ipAddress: "127.0.0.1",
      userAgent: "test-agent",
    },
  });
  assert.equal(event.action, "document.upload");
  assert.deepEqual(JSON.parse(event.metadata), { contentType: "application/pdf", sizeBytes: 1234 });

  const stored = await prisma.auditEvent.findUnique({ where: { id: event.id } });
  assert.equal(stored.ipAddress, "127.0.0.1");
});

test("deleting a user preserves audit events but nulls the actor (SetNull)", async () => {
  await reset();
  const user = await createUser();
  await prisma.auditEvent.create({ data: { actorId: user.id, action: "document.download" } });
  await prisma.user.delete({ where: { id: user.id } });

  const events = await prisma.auditEvent.findMany();
  assert.equal(events.length, 1);
  assert.equal(events[0].actorId, null);
});

