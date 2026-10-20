import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { prisma } from "../src/lib/db.ts";
import {
  initiateAnalysis,
  processAnalysisJob,
  findDueAnalysisJobIds,
  getAnalysisJobSummary,
  retryDelayMs,
  ANALYSIS_PROCESSING_LIMITS,
} from "../src/lib/analysis/jobs.ts";
import {
  AI_DETECTION_DISCLAIMER,
  AnalysisProviderError,
  AnalysisUnavailableError,
  analysisAvailability,
  getSimilarityProvider,
  normalizeAiWritingResult,
  normalizePercent,
  normalizeSimilarityResult,
  unconfiguredAiWritingProvider,
  unconfiguredSimilarityProvider,
} from "../src/lib/analysis/index.ts";
import { canInitiateAnalysis } from "../src/lib/authorization.ts";
import {
  ConflictError,
  ConfigurationError,
  ForbiddenError,
  IneligibleError,
  NotFoundError,
} from "../src/lib/app-errors.ts";

// Provider-independent analysis foundation tests. Runs against the dedicated
// test database prepared by scripts/run-tests.mjs. All providers/storage are
// fakes injected through the service context, so no external call is made.

const DEFAULT_BYTES = Buffer.from("%PDF-1.7\nAnalysis foundation test manuscript.\n");

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
function unique(label) {
  counter += 1;
  return `${label}-${counter}`;
}

const actorFor = (user, role) => ({ id: user.id, role });
const studentActor = (user) => actorFor(user, "STUDENT");
const instructorActor = (user) => actorFor(user, "INSTRUCTOR");
const adminActor = (user) => actorFor(user, "ADMIN");

async function createStudent() {
  counter += 1;
  return prisma.user.create({
    data: {
      name: `Analysis Student ${counter}`,
      email: `analysis-student-${counter}@test.local`,
      passwordHash: "hash",
      role: "STUDENT",
    },
  });
}

async function createAdmin() {
  counter += 1;
  return prisma.user.create({
    data: {
      name: `Analysis Admin ${counter}`,
      email: `analysis-admin-${counter}@test.local`,
      passwordHash: "hash",
      role: "ADMIN",
    },
  });
}

async function createInstructor({
  approved = true,
  active = true,
  suspended = false,
} = {}) {
  counter += 1;
  const user = await prisma.user.create({
    data: {
      name: `Analysis Instructor ${counter}`,
      email: `analysis-instructor-${counter}@test.local`,
      passwordHash: "hash",
      role: "INSTRUCTOR",
      suspended,
      instructorProfile: {
        create: {
          headline: "Test instructor",
          isApproved: approved,
          isActive: active,
          services: {
            create: [
              {
                code: `AN-SVC-${counter}`,
                name: "Analysis fixture service",
                description: "A service used by analysis tests.",
                amountMinor: 8500,
                currency: "INR",
                turnaroundHours: 24,
                isActive: true,
              },
            ],
          },
        },
      },
    },
    include: { instructorProfile: { include: { services: true } } },
  });
  return { user, profile: user.instructorProfile, service: user.instructorProfile.services[0] };
}

async function createRequest(student, instructor, status = "PAID") {
  counter += 1;
  return prisma.serviceRequest.create({
    data: {
      reference: `AN-REQ-${counter}-${Date.now()}`,
      studentId: student.id,
      instructorId: instructor.profile.id,
      serviceId: instructor.service.id,
      title: "Analysis fixture request",
      instructions: "Check originality and AI-writing signals.",
      status,
      amountMinor: 8500,
      currency: "INR",
    },
  });
}

async function createDocument({
  ownerId,
  requestId = null,
  status = "AVAILABLE",
  scanStatus,
  bytes = DEFAULT_BYTES,
  checksum,
}) {
  counter += 1;
  return prisma.document.create({
    data: {
      ownerId,
      requestId,
      storageKey: unique("analysis-storage-key"),
      originalName: `analysis-manuscript-${counter}.pdf`,
      contentType: "application/pdf",
      sizeBytes: bytes.length,
      checksumSha256:
        checksum === undefined ? createHash("sha256").update(bytes).digest("hex") : checksum,
      status,
      scanStatus: scanStatus ?? (status === "AVAILABLE" ? "CLEAN" : "UNSCANNED"),
    },
  });
}

async function setup({
  requestStatus = "PAID",
  documentStatus = "AVAILABLE",
  documentScanStatus,
  bytes = DEFAULT_BYTES,
  checksum,
  instructorOptions = {},
} = {}) {
  const student = await createStudent();
  const instructor = await createInstructor(instructorOptions);
  const request = await createRequest(student, instructor, requestStatus);
  const document = await createDocument({
    ownerId: student.id,
    requestId: request.id,
    status: documentStatus,
    scanStatus: documentScanStatus,
    bytes,
    checksum,
  });
  return { student, instructor, request, document, bytes };
}

function makeProvider(kind, options = {}) {
  const id = kind === "SIMILARITY" ? "fake-similarity" : "fake-ai-writing";
  const calls = { submit: [], poll: [] };
  const provider = {
    id,
    kind,
    status: () => ({
      providerId: id,
      kind,
      state: "AVAILABLE",
      configured: true,
      message: "Fake provider available for tests.",
    }),
    async submit(input) {
      calls.submit.push(input);
      if (typeof options.submit === "function") return options.submit(input, calls);
      return {
        providerJobId: "provider-job-1",
        status: "QUEUED",
        metadata: {
          providerId: id,
          providerVersion: "test-adapter-1",
          modelVersion: null,
          thresholdPercent: null,
        },
      };
    },
    async poll(providerJobId) {
      calls.poll.push(providerJobId);
      if (typeof options.poll === "function") return options.poll(providerJobId, calls);
      return { state: "PROCESSING" };
    },
  };
  return { provider, calls };
}

function makeStorage(bytes = DEFAULT_BYTES, options = {}) {
  const calls = [];
  return {
    calls,
    async get(key) {
      calls.push(key);
      if (options.fail) throw new Error("simulated storage failure");
      return options.bytes ?? bytes;
    },
    async put() {
      throw new Error("not implemented in tests");
    },
    async getStream() {
      throw new Error("not implemented in tests");
    },
    async exists() {
      return !options.fail;
    },
    async remove() {
      if (options.fail) throw new Error("simulated storage failure");
    },
  };
}

function makeContext({ similarity, aiWriting, storage } = {}) {
  return {
    similarity: similarity?.provider ?? unconfiguredSimilarityProvider(),
    aiWriting: aiWriting?.provider ?? unconfiguredAiWritingProvider(),
    storage: storage ?? makeStorage(),
  };
}

async function initiate(fixture, type, context, actor) {
  return initiateAnalysis({
    actor: actor ?? instructorActor(fixture.instructor.user),
    requestId: fixture.request.id,
    documentId: fixture.document.id,
    type,
    context,
  });
}

async function rejectsWith(promise, errorClass) {
  await assert.rejects(promise, (error) => {
    assert.ok(
      error instanceof errorClass,
      `expected ${errorClass.name}, got ${error?.name}: ${error?.message}`,
    );
    return true;
  });
}

test.after(async () => {
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* Pure provider contract and normalization                            */
/* ------------------------------------------------------------------ */

test("unconfigured adapters report NOT_CONFIGURED and cannot produce results", async () => {
  for (const provider of [
    unconfiguredSimilarityProvider(),
    unconfiguredAiWritingProvider(),
  ]) {
    const status = provider.status();
    assert.equal(status.state, "NOT_CONFIGURED");
    assert.equal(status.configured, false);
    assert.match(status.message, /not configured/i);
    await rejectsWith(provider.submit({}), AnalysisUnavailableError);
    await rejectsWith(provider.poll("provider-job"), AnalysisUnavailableError);
  }
});

test("configured-but-unimplemented providers fail closed", async () => {
  const previous = process.env.SIMILARITY_PROVIDER;
  process.env.SIMILARITY_PROVIDER = "not-a-real-provider";
  try {
    const provider = getSimilarityProvider();
    assert.equal(provider.status().state, "UNAVAILABLE");
    assert.equal(provider.status().configured, false);
    await rejectsWith(provider.submit({}), AnalysisProviderError);
    const availability = analysisAvailability();
    assert.equal(availability.similarity.configured, false);
    assert.equal(availability.aiWriting.configured, false);
  } finally {
    if (previous === undefined) delete process.env.SIMILARITY_PROVIDER;
    else process.env.SIMILARITY_PROVIDER = previous;
  }
});

test("percent normalization preserves unavailable (null) and explicit zero", () => {
  assert.equal(normalizePercent(null, "score"), null);
  assert.equal(normalizePercent(undefined, "score"), null);
  assert.equal(normalizePercent(0, "score"), 0);
  assert.equal(normalizePercent(38.256, "score"), 38.26);

  for (const invalid of [-1, 100.0001, 101, Number.NaN, Number.POSITIVE_INFINITY, "42"]) {
    assert.throws(
      () => normalizePercent(invalid, "score"),
      /between 0 and 100/,
      `expected ${String(invalid)} to be rejected`,
    );
  }
});

test("similarity normalization retains offsets/sources but drops text and raw metadata", () => {
  const result = normalizeSimilarityResult(
    {
      providerJobId: "provider-job-1",
      overallSimilarityPercent: 42.5,
      matches: [
        {
          offset: 12,
          length: 40,
          similarityPercent: 42.5,
          sourceId: "source-1",
          sourceTitle: "A source",
          sourceUrl: "https://example.org/paper",
          // Deliberately unsupported/sensitive fields:
          matchedText: "This copied passage must not be persisted.",
          raw: { secret: "provider payload" },
        },
        {
          offset: 100,
          length: 10,
          similarityPercent: null,
          sourceTitle: "No URL source",
          sourceUrl: "javascript:alert(1)",
        },
      ],
      metadata: {
        providerId: "fake-similarity",
        providerVersion: "1.2.3",
        modelVersion: "model-x",
        thresholdPercent: 20,
        apiKey: "must-not-be-retained",
        raw: { anything: true },
      },
    },
    { providerId: "fake-similarity", providerJobId: "provider-job-1" },
  );

  assert.equal(result.overallSimilarityPercent, 42.5);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].offset, 12);
  assert.equal(result.matches[0].length, 40);
  assert.equal(result.matches[0].sourceUrl, "https://example.org/paper");
  assert.equal(result.matches[1].sourceUrl, null);
  assert.equal("matchedText" in result.matches[0], false);
  assert.deepEqual(Object.keys(result.metadata).sort(), [
    "modelVersion",
    "providerId",
    "providerVersion",
    "thresholdPercent",
  ]);
  assert.equal(JSON.stringify(result).includes("apiKey"), false);
  assert.equal(JSON.stringify(result).includes("copied passage"), false);
});

test("similarity normalization rejects invalid offsets, scores and job mismatches", () => {
  const context = { providerId: "fake-similarity", providerJobId: "provider-job-1" };
  assert.throws(() =>
    normalizeSimilarityResult(
      {
        providerJobId: "provider-job-1",
        overallSimilarityPercent: 10,
        matches: [{ offset: -1, length: 4 }],
      },
      context,
    ),
  );
  assert.throws(() =>
    normalizeSimilarityResult(
      {
        providerJobId: "provider-job-1",
        overallSimilarityPercent: 150,
        matches: [],
      },
      context,
    ),
  );
  assert.throws(() =>
    normalizeSimilarityResult(
      {
        providerJobId: "different-job",
        overallSimilarityPercent: 10,
        matches: [],
      },
      context,
    ),
  );
});

test("AI normalization keeps explicit zero and offsets, and the disclaimer is probabilistic", () => {
  const result = normalizeAiWritingResult(
    {
      providerJobId: "provider-job-1",
      aiLikelihood: 0,
      segments: [
        { offset: 4, length: 9, aiLikelihood: 0 },
        { offset: 30, length: 12, aiLikelihood: null },
      ],
      metadata: { providerVersion: "ai-1" },
    },
    { providerId: "fake-ai-writing", providerJobId: "provider-job-1" },
  );
  assert.equal(result.aiLikelihood, 0);
  assert.equal(result.segments[0].aiLikelihood, 0);
  assert.equal(result.segments[1].aiLikelihood, null);
  assert.match(AI_DETECTION_DISCLAIMER, /probabilistic/i);
  assert.match(AI_DETECTION_DISCLAIMER, /not proof of misconduct/i);
});

test("pure analysis authorization requires assignment, payment, association and availability", () => {
  const instructor = { id: "instructor-1", role: "INSTRUCTOR" };
  const base = {
    instructorUserId: "instructor-1",
    requestId: "request-1",
    studentId: "student-1",
    requestStatus: "PAID",
    documentOwnerId: "student-1",
    documentRequestId: "request-1",
    documentStatus: "AVAILABLE",
    documentScanStatus: "CLEAN",
  };
  assert.equal(canInitiateAnalysis(instructor, base), true);
  assert.equal(
    canInitiateAnalysis(instructor, { ...base, requestStatus: "ACCEPTED" }),
    true,
  );
  assert.equal(
    canInitiateAnalysis({ id: "student-1", role: "STUDENT" }, base),
    false,
  );
  assert.equal(canInitiateAnalysis({ id: "admin-1", role: "ADMIN" }, base), false);
  assert.equal(
    canInitiateAnalysis(instructor, { ...base, instructorUserId: "other-instructor" }),
    false,
  );
  assert.equal(
    canInitiateAnalysis(instructor, { ...base, requestStatus: "AWAITING_PAYMENT" }),
    false,
  );
  assert.equal(
    canInitiateAnalysis(instructor, { ...base, requestStatus: "DECLINED" }),
    false,
  );
  assert.equal(
    canInitiateAnalysis(instructor, { ...base, documentStatus: "QUARANTINED" }),
    false,
  );
  assert.equal(
    canInitiateAnalysis(instructor, { ...base, documentScanStatus: "UNSCANNED" }),
    false,
  );
  assert.equal(
    canInitiateAnalysis(instructor, { ...base, documentScanStatus: "ERROR" }),
    false,
  );
  assert.equal(
    canInitiateAnalysis(instructor, { ...base, documentRequestId: null }),
    false,
  );
  assert.equal(
    canInitiateAnalysis(instructor, { ...base, documentOwnerId: "another-student" }),
    false,
  );
});

test("retry backoff is bounded and exponential", () => {
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(2), 120_000);
  assert.equal(retryDelayMs(3), 240_000);
  assert.equal(retryDelayMs(20), 15 * 60_000);
});

/* ------------------------------------------------------------------ */
/* Initiation authorization and validation                             */
/* ------------------------------------------------------------------ */

test("only eligible, assigned instructors may initiate analysis", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY");
  const context = makeContext({ similarity });

  await rejectsWith(initiate(fixture, "SIMILARITY", context, studentActor(fixture.student)), ForbiddenError);
  const admin = await createAdmin();
  await rejectsWith(initiate(fixture, "SIMILARITY", context, adminActor(admin)), ForbiddenError);

  // Unapproved, inactive and suspended instructors are re-read from the DB.
  for (const options of [
    { approved: false },
    { active: false },
    { suspended: true },
  ]) {
    await reset();
    const blocked = await setup({ instructorOptions: options });
    await rejectsWith(
      initiate(blocked, "SIMILARITY", context, instructorActor(blocked.instructor.user)),
      IneligibleError,
    );
  }

  assert.equal(await prisma.analysisJob.count(), 0);
  assert.equal(await prisma.analysisResult.count(), 0);
});

test("another instructor's request is reported as not found", async () => {
  await reset();
  const fixture = await setup();
  const other = await createInstructor();
  const similarity = makeProvider("SIMILARITY");

  await rejectsWith(
    initiate(fixture, "SIMILARITY", makeContext({ similarity }), instructorActor(other.user)),
    NotFoundError,
  );
  assert.equal(similarity.calls.submit.length, 0);
  assert.equal(await prisma.analysisJob.count(), 0);
});

test("unpaid and declined requests cannot be analysed", async () => {
  await reset();
  const similarity = makeProvider("SIMILARITY");

  for (const status of ["AWAITING_PAYMENT", "DECLINED", "DRAFT", "CANCELLED"]) {
    await reset();
    const fixture = await setup({ requestStatus: status });
    await rejectsWith(
      initiate(fixture, "SIMILARITY", makeContext({ similarity })),
      ConflictError,
    );
  }
  assert.equal(await prisma.analysisJob.count(), 0);
});

test("quarantined documents are rejected before storage or provider access", async () => {
  await reset();
  const fixture = await setup({ documentStatus: "QUARANTINED" });
  const similarity = makeProvider("SIMILARITY");
  const storage = makeStorage();

  await rejectsWith(
    initiate(fixture, "SIMILARITY", makeContext({ similarity, storage })),
    ConflictError,
  );
  assert.equal(storage.calls.length, 0);
  assert.equal(similarity.calls.submit.length, 0);
  assert.equal(await prisma.analysisJob.count(), 0);
});

test("AVAILABLE documents without a persisted CLEAN scan are rejected", async () => {
  await reset();
  const fixture = await setup({ documentScanStatus: "UNSCANNED" });
  const similarity = makeProvider("SIMILARITY");
  const storage = makeStorage();

  await rejectsWith(
    initiate(fixture, "SIMILARITY", makeContext({ similarity, storage })),
    ConflictError,
  );
  assert.equal(storage.calls.length, 0);
  assert.equal(similarity.calls.submit.length, 0);
  assert.equal(await prisma.analysisJob.count(), 0);
});

test("documents must belong to the request's student and be attached to it", async () => {
  await reset();
  const fixture = await setup();
  const otherStudent = await createStudent();
  const otherInstructor = await createInstructor();
  const otherRequest = await createRequest(otherStudent, otherInstructor, "PAID");
  const similarity = makeProvider("SIMILARITY");
  const context = makeContext({ similarity });

  const foreignDocument = await createDocument({
    ownerId: otherStudent.id,
    requestId: otherRequest.id,
  });
  await rejectsWith(
    initiateAnalysis({
      actor: instructorActor(fixture.instructor.user),
      requestId: fixture.request.id,
      documentId: foreignDocument.id,
      type: "SIMILARITY",
      context,
    }),
    NotFoundError,
  );

  const detached = await createDocument({
    ownerId: fixture.student.id,
    requestId: null,
  });
  await rejectsWith(
    initiateAnalysis({
      actor: instructorActor(fixture.instructor.user),
      requestId: fixture.request.id,
      documentId: detached.id,
      type: "SIMILARITY",
      context,
    }),
    NotFoundError,
  );

  assert.equal(similarity.calls.submit.length, 0);
  assert.equal(await prisma.analysisJob.count(), 0);
});

test("initiation is refused when no real provider is configured", async () => {
  await reset();
  const fixture = await setup();
  const context = makeContext(); // both unconfigured

  await rejectsWith(initiate(fixture, "SIMILARITY", context), ConfigurationError);
  assert.equal(await prisma.analysisJob.count(), 0);
  assert.equal(await prisma.analysisResult.count(), 0);
});

test("initiation creates a durable PENDING job without submitting synchronously", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY");
  const storage = makeStorage(fixture.bytes);

  const result = await initiate(
    fixture,
    "SIMILARITY",
    makeContext({ similarity, storage }),
  );

  assert.equal(result.created, true);
  assert.equal(result.job.status, "PENDING");
  assert.equal(result.job.attempts, 0);
  assert.equal(result.job.requestId, fixture.request.id);
  assert.equal(result.job.documentId, fixture.document.id);
  assert.equal(result.job.provider, "fake-similarity");
  assert.equal(result.job.disclaimer, null);

  const stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: result.job.id } });
  assert.equal(stored.activeKey, `${fixture.document.id}:SIMILARITY`);
  assert.equal(stored.attempts, 0);
  assert.equal(stored.nextAttemptAt, null);

  assert.equal(similarity.calls.submit.length, 0);
  assert.equal(storage.calls.length, 0);

  const events = await prisma.auditEvent.findMany({ where: { targetId: result.job.id } });
  assert.ok(events.some((event) => event.action === "analysis.job.created"));
  assert.equal(JSON.stringify(result.job).includes(fixture.document.storageKey), false);
});

test("duplicate initiation returns the existing active job", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY");
  const context = makeContext({ similarity });

  const first = await initiate(fixture, "SIMILARITY", context);
  const second = await initiate(fixture, "SIMILARITY", context);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
  assert.equal(await prisma.analysisJob.count(), 1);
  assert.equal(similarity.calls.submit.length, 0);
});

test("concurrent initiation yields exactly one active job", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY");
  const context = makeContext({ similarity });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => initiate(fixture, "SIMILARITY", context)),
  );

  assert.equal(await prisma.analysisJob.count(), 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.job.id)).size, 1);
});

test("a completed job is returned instead of creating duplicate work", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY");
  const context = makeContext({ similarity });

  const first = await initiate(fixture, "SIMILARITY", context);
  await prisma.analysisJob.update({
    where: { id: first.job.id },
    data: {
      status: "COMPLETED",
      activeKey: null,
      completedAt: new Date(),
      providerJobId: "provider-job-1",
    },
  });
  await prisma.analysisResult.create({
    data: {
      jobId: first.job.id,
      status: "COMPLETED",
      similarityPercent: 12.5,
      matches: "[]",
    },
  });

  const second = await initiate(fixture, "SIMILARITY", context);
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
  assert.equal(second.job.status, "COMPLETED");
  assert.equal(second.job.result.similarityPercent, 12.5);
  assert.equal(await prisma.analysisJob.count(), 1);
});

/* ------------------------------------------------------------------ */
/* Processing, quarantine re-check and retries                         */
/* ------------------------------------------------------------------ */

test("processing re-checks quarantine and never sends a quarantined document", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY");
  const storage = makeStorage(fixture.bytes);
  const context = makeContext({ similarity, storage });

  const { job } = await initiate(fixture, "SIMILARITY", context);
  await prisma.document.update({
    where: { id: fixture.document.id },
    data: { status: "QUARANTINED" },
  });

  const outcome = await processAnalysisJob({ jobId: job.id, context });
  assert.equal(outcome.outcome, "FAILED");
  assert.equal(storage.calls.length, 0);
  assert.equal(similarity.calls.submit.length, 0);

  const stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "FAILED");
  assert.equal(stored.errorCategory, "PERMANENT");
  assert.equal(stored.errorCode, "document_not_available");
  assert.equal(stored.activeKey, null);
  assert.equal(stored.failedAt !== null, true);
  assert.equal(await prisma.analysisResult.count(), 0);
});

test("processing refuses an AVAILABLE document whose clean scan was revoked", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY");
  const storage = makeStorage(fixture.bytes);
  const context = makeContext({ similarity, storage });

  const { job } = await initiate(fixture, "SIMILARITY", context);
  await prisma.document.update({
    where: { id: fixture.document.id },
    data: { scanStatus: "ERROR", scanReason: "integrity_mismatch" },
  });

  const outcome = await processAnalysisJob({ jobId: job.id, context });
  assert.equal(outcome.outcome, "FAILED");
  assert.equal(storage.calls.length, 0);
  assert.equal(similarity.calls.submit.length, 0);

  const stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "FAILED");
  assert.equal(stored.errorCode, "document_not_available");
  assert.equal(await prisma.analysisResult.count(), 0);
});

test("processing re-checks instructor eligibility before any provider access", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY");
  const storage = makeStorage(fixture.bytes);
  const context = makeContext({ similarity, storage });

  const { job } = await initiate(fixture, "SIMILARITY", context);
  await prisma.instructorProfile.update({
    where: { id: fixture.instructor.profile.id },
    data: { isActive: false },
  });

  const outcome = await processAnalysisJob({ jobId: job.id, context });
  assert.equal(outcome.outcome, "FAILED");
  assert.equal(storage.calls.length, 0);
  assert.equal(similarity.calls.submit.length, 0);

  const stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "FAILED");
  assert.equal(stored.errorCategory, "PERMANENT");
  assert.equal(stored.errorCode, "instructor_not_eligible");
  assert.equal(await prisma.analysisResult.count(), 0);
});

test("processing fails closed when the provider is unconfigured", async () => {
  await reset();
  const fixture = await setup();
  const job = await prisma.analysisJob.create({
    data: {
      documentId: fixture.document.id,
      requestId: fixture.request.id,
      requestedById: fixture.instructor.user.id,
      type: "SIMILARITY",
      status: "PENDING",
      provider: "unconfigured",
      activeKey: `${fixture.document.id}:SIMILARITY`,
    },
  });

  const outcome = await processAnalysisJob({
    jobId: job.id,
    context: makeContext(),
  });
  assert.equal(outcome.outcome, "FAILED");

  const stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "FAILED");
  assert.equal(stored.errorCategory, "CONFIGURATION");
  assert.equal(await prisma.analysisResult.count(), 0);
});

test("submission reads exact bytes via storage and records a queued provider job", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY");
  const storage = makeStorage(fixture.bytes);
  const context = makeContext({ similarity, storage });

  const { job } = await initiate(fixture, "SIMILARITY", context);
  const now = new Date();
  const outcome = await processAnalysisJob({ jobId: job.id, context, now });

  assert.equal(outcome.outcome, "SUBMITTED");
  assert.equal(outcome.status, "QUEUED");
  assert.deepEqual(storage.calls, [fixture.document.storageKey]);
  assert.equal(similarity.calls.submit.length, 1);

  const input = similarity.calls.submit[0];
  assert.deepEqual(Buffer.from(input.bytes), fixture.bytes);
  assert.equal(input.idempotencyKey, `analysis-job:${job.id}`);
  assert.equal(input.sizeBytes, fixture.bytes.length);
  assert.equal("storageKey" in input, false);
  assert.equal(JSON.stringify(input).includes(fixture.document.storageKey), false);

  const stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "QUEUED");
  assert.equal(stored.providerJobId, "provider-job-1");
  assert.equal(stored.providerStatus, "QUEUED");
  assert.equal(stored.attempts, 1);
  assert.equal(stored.failureCount, 0);
  assert.ok(stored.submittedAt);
  assert.ok(stored.nextAttemptAt);

  const events = await prisma.auditEvent.findMany({ where: { targetId: job.id } });
  assert.ok(events.some((event) => event.action === "analysis.job.submitted"));
  assert.equal(JSON.stringify(events).includes(fixture.document.storageKey), false);
});

test("storage failures retry without contacting the provider", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY");
  const storage = makeStorage(fixture.bytes, { fail: true });
  const context = makeContext({ similarity, storage });

  const { job } = await initiate(fixture, "SIMILARITY", context);
  const now = new Date();
  const outcome = await processAnalysisJob({ jobId: job.id, context, now });

  assert.equal(outcome.outcome, "RETRY_SCHEDULED");
  assert.equal(similarity.calls.submit.length, 0);
  const stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "RETRYABLE");
  assert.equal(stored.failureCount, 1);
  assert.equal(stored.errorCode, "storage_unavailable");
  assert.ok(stored.nextAttemptAt > now);
});

test("transient submission failures retry with backoff and then exhaust", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY", {
    submit() {
      throw new AnalysisProviderError({
        category: "TRANSIENT",
        code: "upstream_unavailable",
        message: "RAW PROVIDER BODY: secret text that must not be stored",
        retryable: true,
      });
    },
  });
  const context = makeContext({ similarity, storage: makeStorage(fixture.bytes) });

  const { job } = await initiate(fixture, "SIMILARITY", context);
  const t0 = new Date();

  const first = await processAnalysisJob({ jobId: job.id, context, now: t0 });
  assert.equal(first.outcome, "RETRY_SCHEDULED");
  let stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "RETRYABLE");
  assert.equal(stored.attempts, 1);
  assert.equal(stored.failureCount, 1);
  assert.equal(stored.errorMessage.includes("RAW PROVIDER BODY"), false);
  assert.ok(stored.nextAttemptAt > t0);

  const notDue = await processAnalysisJob({ jobId: job.id, context, now: t0 });
  assert.equal(notDue.outcome, "NOOP");
  assert.equal(notDue.reason, "not_due");
  assert.equal(similarity.calls.submit.length, 1);

  const second = await processAnalysisJob({
    jobId: job.id,
    context,
    now: new Date(t0.getTime() + 120_000),
  });
  assert.equal(second.outcome, "RETRY_SCHEDULED");
  stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.attempts, 2);
  assert.equal(stored.failureCount, 2);
  assert.equal(stored.status, "RETRYABLE");

  const third = await processAnalysisJob({
    jobId: job.id,
    context,
    now: new Date(t0.getTime() + 20 * 60_000),
  });
  assert.equal(third.outcome, "FAILED");
  stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "FAILED");
  assert.equal(stored.attempts, ANALYSIS_PROCESSING_LIMITS.maxAttempts);
  assert.equal(stored.failureCount, ANALYSIS_PROCESSING_LIMITS.maxTransientFailures);
  assert.equal(stored.activeKey, null);
  assert.equal(stored.errorCategory, "TRANSIENT");
  assert.equal(similarity.calls.submit.length, 3);
  assert.equal(await prisma.analysisResult.count(), 0);

  // A terminal failure releases the active slot, so a fresh job may be started.
  const restarted = await initiate(fixture, "SIMILARITY", context);
  assert.equal(restarted.created, true);
  assert.notEqual(restarted.job.id, job.id);
});

test("permanent provider errors are terminal immediately", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY", {
    submit() {
      throw new AnalysisProviderError({
        category: "PERMANENT",
        code: "unsupported_document",
        message: "provider wants this hidden",
        retryable: false,
      });
    },
  });
  const context = makeContext({ similarity, storage: makeStorage(fixture.bytes) });

  const { job } = await initiate(fixture, "SIMILARITY", context);
  const outcome = await processAnalysisJob({ jobId: job.id, context });
  assert.equal(outcome.outcome, "FAILED");

  const stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "FAILED");
  assert.equal(stored.attempts, 1);
  assert.equal(stored.failureCount, 1);
  assert.equal(stored.errorCategory, "PERMANENT");
  assert.equal(await prisma.analysisResult.count(), 0);
});

test("a checksum mismatch is permanent and no provider call is made", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY");
  // Storage returns different bytes than the document record describes.
  const storage = makeStorage(Buffer.from("tampered bytes"));
  const context = makeContext({ similarity, storage });

  const { job } = await initiate(fixture, "SIMILARITY", context);
  const outcome = await processAnalysisJob({ jobId: job.id, context });
  assert.equal(outcome.outcome, "FAILED");
  assert.equal(similarity.calls.submit.length, 0);

  const stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "FAILED");
  assert.equal(stored.errorCategory, "PERMANENT");
  assert.equal(stored.errorCode, "document_size_mismatch");
  assert.equal(await prisma.analysisResult.count(), 0);
});

/* ------------------------------------------------------------------ */
/* Completion and normalized results                                   */
/* ------------------------------------------------------------------ */

async function submitForPoll(fixture, type, context) {
  const { job } = await initiate(fixture, type, context);
  const t0 = new Date();
  const submitted = await processAnalysisJob({ jobId: job.id, context, now: t0 });
  assert.equal(submitted.outcome, "SUBMITTED");
  return { job, t0, pollAt: new Date(t0.getTime() + 120_000) };
}

test("similarity completion stores a normalized result transactionally", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY", {
    poll() {
      return {
        state: "COMPLETED",
        result: {
          providerJobId: "provider-job-1",
          overallSimilarityPercent: 38.25,
          matches: [
            {
              offset: 0,
              length: 24,
              similarityPercent: 38.25,
              sourceId: "source-1",
              sourceTitle: "Original source",
              sourceUrl: "https://example.org/source",
              matchedText: "sensitive copied text",
              raw: { hidden: true },
            },
          ],
          metadata: {
            providerId: "fake-similarity",
            providerVersion: "adapter-2",
            modelVersion: "model-7",
            thresholdPercent: 20,
            apiKey: "not-retained",
          },
        },
      };
    },
  });
  const storage = makeStorage(fixture.bytes);
  const context = makeContext({ similarity, storage });

  const { job, pollAt } = await submitForPoll(
    fixture,
    "SIMILARITY",
    context,
  );
  const outcome = await processAnalysisJob({ jobId: job.id, context, now: pollAt });
  assert.equal(outcome.outcome, "COMPLETED");

  const stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "COMPLETED");
  assert.equal(stored.providerStatus, "COMPLETED");
  assert.equal(stored.activeKey, null);
  assert.equal(stored.nextAttemptAt, null);
  assert.ok(stored.completedAt);

  const result = await prisma.analysisResult.findUniqueOrThrow({ where: { jobId: job.id } });
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.similarityPercent, 38.25);
  assert.equal(result.aiLikelihood, null);
  assert.equal(result.segments, null);
  assert.equal(result.providerVersion, "adapter-2");
  assert.equal(result.providerPayload, null);

  const matches = JSON.parse(result.matches);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].offset, 0);
  assert.equal(matches[0].sourceTitle, "Original source");
  assert.equal("matchedText" in matches[0], false);
  assert.equal(result.metadata.includes("apiKey"), false);
  assert.equal(result.metadata.includes("sensitive copied text"), false);

  const events = await prisma.auditEvent.findMany({ where: { targetId: job.id } });
  assert.ok(events.some((event) => event.action === "analysis.job.completed"));

  const summary = await getAnalysisJobSummary(studentActor(fixture.student), job.id);
  assert.ok(summary);
  assert.equal(summary.result.similarityPercent, 38.25);
  assert.equal(summary.result.aiLikelihood, null);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("providerPayload"), false);
  assert.equal(serialized.includes(fixture.document.storageKey), false);
  assert.equal(serialized.includes("sensitive copied text"), false);
});

test("AI completion keeps similarity unavailable and stores the probabilistic disclaimer", async () => {
  await reset();
  const fixture = await setup();
  const aiWriting = makeProvider("AI_WRITING", {
    poll() {
      return {
        state: "COMPLETED",
        result: {
          providerJobId: "provider-job-1",
          aiLikelihood: 0,
          segments: [
            { offset: 10, length: 40, aiLikelihood: 0 },
            { offset: 80, length: 20, aiLikelihood: null },
          ],
          metadata: {
            providerId: "fake-ai-writing",
            providerVersion: "ai-adapter-1",
            modelVersion: "ai-model-2",
            thresholdPercent: null,
          },
        },
      };
    },
  });
  const storage = makeStorage(fixture.bytes);
  const context = makeContext({ aiWriting, storage });

  const { job, pollAt } = await submitForPoll(fixture, "AI_WRITING", context);
  const outcome = await processAnalysisJob({ jobId: job.id, context, now: pollAt });
  assert.equal(outcome.outcome, "COMPLETED");

  const result = await prisma.analysisResult.findUniqueOrThrow({ where: { jobId: job.id } });
  assert.equal(result.similarityPercent, null);
  assert.equal(result.aiLikelihood, 0);
  assert.equal(result.matches, null);
  const segments = JSON.parse(result.segments);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].aiLikelihood, 0);
  assert.equal(segments[1].aiLikelihood, null);

  const metadata = JSON.parse(result.metadata);
  assert.equal(metadata.disclaimer, AI_DETECTION_DISCLAIMER);
  assert.match(metadata.disclaimer, /not proof of misconduct/i);

  const summary = await getAnalysisJobSummary(studentActor(fixture.student), job.id);
  assert.ok(summary);
  assert.equal(summary.disclaimer, AI_DETECTION_DISCLAIMER);
  assert.equal(summary.result.similarityPercent, null);
});

test("invalid provider results never create a result row", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY", {
    poll() {
      return {
        state: "COMPLETED",
        result: {
          providerJobId: "provider-job-1",
          overallSimilarityPercent: 150,
          matches: [],
          metadata: { providerId: "fake-similarity" },
        },
      };
    },
  });
  const context = makeContext({ similarity, storage: makeStorage(fixture.bytes) });

  const { job, pollAt } = await submitForPoll(
    fixture,
    "SIMILARITY",
    context,
  );
  const outcome = await processAnalysisJob({ jobId: job.id, context, now: pollAt });
  assert.equal(outcome.outcome, "FAILED");

  const stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "FAILED");
  assert.equal(stored.errorCategory, "INVALID_RESULT");
  assert.equal(stored.activeKey, null);
  assert.equal(await prisma.analysisResult.count(), 0);
});

test("polling progress keeps the job active and clears transient failure state", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY");
  const context = makeContext({ similarity, storage: makeStorage(fixture.bytes) });

  const { job, pollAt } = await submitForPoll(
    fixture,
    "SIMILARITY",
    context,
  );
  const outcome = await processAnalysisJob({ jobId: job.id, context, now: pollAt });
  assert.equal(outcome.outcome, "PROGRESSING");
  assert.equal(outcome.status, "PROCESSING");

  const stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "PROCESSING");
  assert.equal(stored.providerStatus, "PROCESSING");
  assert.equal(stored.activeKey !== null, true);
  assert.equal(stored.failureCount, 0);
  assert.equal(await prisma.analysisResult.count(), 0);
});

test("concurrent completion creates exactly one result", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY", {
    poll() {
      return {
        state: "COMPLETED",
        result: {
          providerJobId: "provider-job-1",
          overallSimilarityPercent: 25,
          matches: [],
          metadata: { providerId: "fake-similarity", providerVersion: "v1" },
        },
      };
    },
  });
  const context = makeContext({ similarity, storage: makeStorage(fixture.bytes) });

  const { job, pollAt } = await submitForPoll(
    fixture,
    "SIMILARITY",
    context,
  );
  const outcomes = await Promise.all([
    processAnalysisJob({ jobId: job.id, context, now: pollAt }),
    processAnalysisJob({ jobId: job.id, context, now: pollAt }),
  ]);

  assert.equal(await prisma.analysisResult.count(), 1);
  const stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "COMPLETED");
  assert.ok(outcomes.some((outcome) => outcome.outcome === "COMPLETED"));

  const again = await processAnalysisJob({ jobId: job.id, context, now: pollAt });
  assert.equal(again.outcome, "NOOP");
  assert.equal(again.reason, "already_completed");
  assert.equal(await prisma.analysisResult.count(), 1);
});

test("provider-declared retryable failure is retried within budget", async () => {
  await reset();
  const fixture = await setup();
  let polls = 0;
  const similarity = makeProvider("SIMILARITY", {
    poll() {
      polls += 1;
      if (polls === 1) {
        return {
          state: "FAILED",
          error: {
            category: "RATE_LIMITED",
            code: "provider_busy",
            message: "raw rate limit details",
            retryable: true,
          },
        };
      }
      return { state: "PROCESSING" };
    },
  });
  const context = makeContext({ similarity, storage: makeStorage(fixture.bytes) });

  const { job, pollAt } = await submitForPoll(
    fixture,
    "SIMILARITY",
    context,
  );
  const first = await processAnalysisJob({ jobId: job.id, context, now: pollAt });
  assert.equal(first.outcome, "RETRY_SCHEDULED");

  let stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "RETRYABLE");
  assert.equal(stored.errorCategory, "RATE_LIMITED");
  assert.equal(stored.errorMessage.includes("raw rate limit details"), false);
  assert.ok(stored.nextAttemptAt > pollAt);

  const retry = await processAnalysisJob({
    jobId: job.id,
    context,
    now: new Date(pollAt.getTime() + 10 * 60_000),
  });
  assert.equal(retry.outcome, "PROGRESSING");
  stored = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(stored.status, "PROCESSING");
  assert.equal(stored.failureCount, 0);
  assert.equal(await prisma.analysisResult.count(), 0);
});

/* ------------------------------------------------------------------ */
/* Safe reads, worker discovery and schema constraints                 */
/* ------------------------------------------------------------------ */

test("analysis summaries are visible only to the student, assigned instructor and admin", async () => {
  await reset();
  const fixture = await setup();
  const similarity = makeProvider("SIMILARITY");
  const storage = makeStorage(fixture.bytes);
  const context = makeContext({ similarity, storage });
  const { job, pollAt } = await submitForPoll(
    fixture,
    "SIMILARITY",
    context,
  );

  const otherStudent = await createStudent();
  const otherInstructor = await createInstructor();
  const admin = await createAdmin();

  assert.ok(await getAnalysisJobSummary(studentActor(fixture.student), job.id));
  assert.ok(
    await getAnalysisJobSummary(instructorActor(fixture.instructor.user), job.id),
  );
  assert.ok(await getAnalysisJobSummary(adminActor(admin), job.id));
  assert.equal(await getAnalysisJobSummary(studentActor(otherStudent), job.id), null);
  assert.equal(
    await getAnalysisJobSummary(instructorActor(otherInstructor.user), job.id),
    null,
  );
  assert.equal(await getAnalysisJobSummary(studentActor(fixture.student), "missing"), null);

  // Silence unused-variable noise while asserting the poll path was not invoked.
  assert.equal(similarity.calls.poll.length, 0);
  assert.ok(pollAt instanceof Date);
});

test("worker discovery returns only due, active jobs", async () => {
  await reset();
  const fixture = await setup();
  const now = new Date();
  const student = fixture.student;
  const instructor = fixture.instructor;

  const pending = await prisma.analysisJob.create({
    data: {
      documentId: fixture.document.id,
      requestId: fixture.request.id,
      requestedById: instructor.user.id,
      type: "SIMILARITY",
      status: "PENDING",
      provider: "fake",
      nextAttemptAt: null,
    },
  });

  const dueDocument = await createDocument({
    ownerId: student.id,
    requestId: fixture.request.id,
  });
  const due = await prisma.analysisJob.create({
    data: {
      documentId: dueDocument.id,
      requestId: fixture.request.id,
      requestedById: instructor.user.id,
      type: "SIMILARITY",
      status: "RETRYABLE",
      provider: "fake",
      nextAttemptAt: new Date(now.getTime() - 60_000),
    },
  });

  const futureDocument = await createDocument({
    ownerId: student.id,
    requestId: fixture.request.id,
  });
  const future = await prisma.analysisJob.create({
    data: {
      documentId: futureDocument.id,
      requestId: fixture.request.id,
      requestedById: instructor.user.id,
      type: "SIMILARITY",
      status: "RETRYABLE",
      provider: "fake",
      nextAttemptAt: new Date(now.getTime() + 60 * 60_000),
    },
  });

  const completedDocument = await createDocument({
    ownerId: student.id,
    requestId: fixture.request.id,
  });
  const completed = await prisma.analysisJob.create({
    data: {
      documentId: completedDocument.id,
      requestId: fixture.request.id,
      requestedById: instructor.user.id,
      type: "SIMILARITY",
      status: "COMPLETED",
      provider: "fake",
    },
  });

  const ids = await findDueAnalysisJobIds({ now, limit: 10 });
  assert.ok(ids.includes(pending.id));
  assert.ok(ids.includes(due.id));
  assert.equal(ids.includes(future.id), false);
  assert.equal(ids.includes(completed.id), false);
});

test("schema enforces one active job per document and type, and defaults are safe", async () => {
  await reset();
  const fixture = await setup();
  const base = {
    documentId: fixture.document.id,
    requestId: fixture.request.id,
    requestedById: fixture.instructor.user.id,
    type: "SIMILARITY",
    provider: "fake",
    activeKey: `${fixture.document.id}:SIMILARITY`,
  };

  const job = await prisma.analysisJob.create({ data: { ...base, status: "PENDING" } });
  assert.equal(job.failureCount, 0);
  assert.equal(job.providerStatus, null);
  assert.equal(job.errorCategory, null);
  assert.equal(job.nextAttemptAt, null);

  await assert.rejects(
    () => prisma.analysisJob.create({ data: { ...base, status: "PENDING" } }),
    (error) => error?.code === "P2002",
  );
});
