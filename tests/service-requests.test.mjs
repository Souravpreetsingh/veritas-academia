import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db.ts";
import {
  parseRequestInput,
  generateReference,
  createServiceRequest,
  submitServiceRequest,
  listStudentRequests,
  getStudentRequest,
  getStudentRequestById,
  LIMITS,
} from "../src/lib/service-requests.ts";
import { getRequestableService } from "../src/lib/instructor-directory.ts";
import {
  ValidationError,
  ForbiddenError,
  IneligibleError,
  NotFoundError,
  ConflictError,
} from "../src/lib/app-errors.ts";

// Database-backed tests for the student service-request workflow. Runs against
// prisma/test.db, prepared by scripts/run-tests.mjs. Sequential execution
// (--test-concurrency=1) keeps this suite from racing other DB-backed suites.

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

async function createStudent() {
  counter += 1;
  return prisma.user.create({
    data: {
      name: `Student ${counter}`,
      email: `student${counter}@test.local`,
      passwordHash: "hash",
      role: "STUDENT",
    },
  });
}

async function createInstructor({
  approved = true,
  active = true,
  suspended = false,
  role = "INSTRUCTOR",
  service = { code: null, name: "Manuscript Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  services = null,
} = {}) {
  counter += 1;
  const list = services ?? [service];
  const user = await prisma.user.create({
    data: {
      name: `Instructor ${counter}`,
      email: `instructor${counter}@test.local`,
      passwordHash: "hash",
      role,
      suspended,
      instructorProfile: {
        create: {
          headline: "Chair of Epistemic Logic",
          isApproved: approved,
          isActive: active,
          services: {
            create: list.map((s, index) => ({
              code: s.code ?? `SVC-${counter}-${index}`,
              name: s.name,
              description: "Published academic support service.",
              amountMinor: s.amountMinor,
              currency: s.currency ?? "INR",
              turnaroundHours: s.turnaroundHours,
              isActive: s.isActive ?? true,
            })),
          },
        },
      },
    },
    include: { instructorProfile: { include: { services: true } } },
  });
  return { user, profile: user.instructorProfile, services: user.instructorProfile.services };
}

async function createDocument({ ownerId, status = "AVAILABLE", scanStatus, requestId = null }) {
  counter += 1;
  return prisma.document.create({
    data: {
      ownerId,
      requestId,
      storageKey: `test/${counter}-${unique("key")}`,
      originalName: `manuscript-${counter}.pdf`,
      contentType: "application/pdf",
      sizeBytes: 1024,
      status,
      scanStatus: scanStatus ?? (status === "AVAILABLE" ? "CLEAN" : "UNSCANNED"),
    },
  });
}

const studentActor = (user) => ({ id: user.id, role: "STUDENT" });

function validInput(serviceId, overrides = {}) {
  return {
    serviceId,
    title: "Literature Review — Climate Policy Corpus",
    instructions: "Verify all citations and flag unsupported claims across the corpus.",
    turnaroundHours: 24,
    ...overrides,
  };
}

async function rejectsWith(promise, errorClass) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof errorClass, `expected ${errorClass.name}, got ${error?.name}: ${error?.message}`);
    return true;
  });
}

test.after(async () => {
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/*  Pure validation                                                    */
/* ------------------------------------------------------------------ */

test("parseRequestInput accepts and normalizes a valid body", () => {
  const parsed = parseRequestInput({
    serviceId: "  svc-1  ",
    title: "  My Title  ",
    instructions: "  Please audit the references carefully.  ",
    turnaroundHours: "24",
    documentIds: ["doc-1", "doc-1", "doc-2"],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.serviceId, "svc-1");
  assert.equal(parsed.value.title, "My Title");
  assert.equal(parsed.value.instructions, "Please audit the references carefully.");
  assert.equal(parsed.value.turnaroundHours, 24);
  assert.deepEqual(parsed.value.documentIds, ["doc-1", "doc-2"]);
});

test("parseRequestInput rejects missing service, short text, bad turnaround and bad docs", () => {
  assert.equal(parseRequestInput({ title: "xx", instructions: "valid instructions here", turnaroundHours: 24 }).ok, false);
  assert.equal(parseRequestInput({ serviceId: "s", title: "ab", instructions: "valid instructions here", turnaroundHours: 24 }).ok, false);
  assert.equal(parseRequestInput({ serviceId: "s", title: "valid title", instructions: "short", turnaroundHours: 24 }).ok, false);
  assert.equal(parseRequestInput({ serviceId: "s", title: "valid title", instructions: "valid instructions here", turnaroundHours: "abc" }).ok, false);
  assert.equal(parseRequestInput({ serviceId: "s", title: "valid title", instructions: "valid instructions here", turnaroundHours: 24, documentIds: "nope" }).ok, false);
  assert.equal(parseRequestInput({ serviceId: "s", title: "valid title", instructions: "valid instructions here", turnaroundHours: 24, documentIds: [1, 2] }).ok, false);
  assert.equal(
    parseRequestInput({
      serviceId: "s",
      title: "valid title",
      instructions: "valid instructions here",
      turnaroundHours: 24,
      documentIds: Array.from({ length: LIMITS.maxDocuments + 1 }, (_, i) => `d${i}`),
    }).ok,
    false,
  );
});

test("generateReference yields well-formed, distinct codes", () => {
  const now = new Date("2026-10-17T00:00:00Z");
  const seen = new Set();
  for (let i = 0; i < 100; i += 1) {
    const ref = generateReference(now);
    assert.match(ref, /^REQ-2026-[A-HJ-NP-Z2-9]{6}$/);
    seen.add(ref);
  }
  assert.equal(seen.size, 100);
});

/* ------------------------------------------------------------------ */
/*  Creation                                                           */
/* ------------------------------------------------------------------ */

test("a student creates a draft and the price/currency snapshot comes from the service row", async () => {
  await reset();
  const student = await createStudent();
  const { profile, services } = await createInstructor({
    service: { name: "Audit", amountMinor: 12345, currency: "USD", turnaroundHours: 24 },
  });
  const service = services[0];

  const result = await createServiceRequest({
    actor: studentActor(student),
    input: validInput(service.id),
  });

  assert.equal(result.duplicate, false);
  const row = await prisma.serviceRequest.findUnique({ where: { id: result.request.id } });
  assert.equal(row.studentId, student.id);
  assert.equal(row.instructorId, profile.id);
  assert.equal(row.serviceId, service.id);
  assert.equal(row.status, "DRAFT");
  assert.equal(row.amountMinor, 12345);
  assert.equal(row.currency, "USD");
  assert.match(row.reference, /^REQ-\d{4}-/);
});

test("a non-student actor is refused even when calling the service directly", async () => {
  await reset();
  const { user: instructorUser, services } = await createInstructor();
  const admin = await prisma.user.create({
    data: { name: "Admin", email: "admin@test.local", passwordHash: "hash", role: "ADMIN" },
  });
  const service = services[0];

  await rejectsWith(
    createServiceRequest({ actor: { id: instructorUser.id, role: "INSTRUCTOR" }, input: validInput(service.id) }),
    ForbiddenError,
  );
  await rejectsWith(
    createServiceRequest({ actor: { id: admin.id, role: "ADMIN" }, input: validInput(service.id) }),
    ForbiddenError,
  );
  assert.equal(await prisma.serviceRequest.count(), 0);
});

test("client-supplied identity and price are ignored in favour of the session and the DB", async () => {
  await reset();
  const student = await createStudent();
  const other = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const service = services[0];

  const result = await createServiceRequest({
    actor: studentActor(student),
    input: validInput(service.id, { studentId: other.id, amountMinor: 1, currency: "XYZ" }),
  });

  const row = await prisma.serviceRequest.findUnique({ where: { id: result.request.id } });
  assert.equal(row.studentId, student.id, "studentId must come from the session");
  assert.equal(row.amountMinor, 8500, "price must come from the service row");
  assert.equal(row.currency, "INR", "currency must come from the service row");
});

test("the price snapshot is immune to a later service price change", async () => {
  await reset();
  const student = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const service = services[0];

  const result = await createServiceRequest({ actor: studentActor(student), input: validInput(service.id) });
  await prisma.instructorService.update({ where: { id: service.id }, data: { amountMinor: 9999 } });

  const row = await prisma.serviceRequest.findUnique({ where: { id: result.request.id } });
  assert.equal(row.amountMinor, 8500);
});

test("an unapproved, inactive or suspended instructor cannot receive a request", async () => {
  await reset();
  const student = await createStudent();
  const unapproved = await createInstructor({ approved: false });
  const inactive = await createInstructor({ active: false });
  const suspended = await createInstructor({ suspended: true });

  await rejectsWith(
    createServiceRequest({ actor: studentActor(student), input: validInput(unapproved.services[0].id) }),
    IneligibleError,
  );
  await rejectsWith(
    createServiceRequest({ actor: studentActor(student), input: validInput(inactive.services[0].id) }),
    IneligibleError,
  );
  await rejectsWith(
    createServiceRequest({ actor: studentActor(student), input: validInput(suspended.services[0].id) }),
    IneligibleError,
  );
  assert.equal(await prisma.serviceRequest.count(), 0);
});

test("an unpublished service or unknown service id is rejected", async () => {
  await reset();
  const student = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Hidden", amountMinor: 100, currency: "INR", turnaroundHours: 24, isActive: false },
  });

  await rejectsWith(
    createServiceRequest({ actor: studentActor(student), input: validInput(services[0].id) }),
    NotFoundError,
  );
  await rejectsWith(
    createServiceRequest({ actor: studentActor(student), input: validInput("does-not-exist") }),
    NotFoundError,
  );
});

test("a turnaround the service does not offer is rejected", async () => {
  await reset();
  const student = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });

  await rejectsWith(
    createServiceRequest({
      actor: studentActor(student),
      input: validInput(services[0].id, { turnaroundHours: 2 }),
    }),
    ValidationError,
  );
  assert.equal(await prisma.serviceRequest.count(), 0);
});

test("a repeated identical submission is deduplicated within the window", async () => {
  await reset();
  const student = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const actor = studentActor(student);

  const first = await createServiceRequest({
    actor,
    input: validInput(services[0].id),
    now: new Date(),
  });
  const second = await createServiceRequest({
    actor,
    input: validInput(services[0].id),
    now: new Date(Date.now() + 1000),
  });

  assert.equal(second.duplicate, true);
  assert.equal(second.request.id, first.request.id);
  assert.equal(await prisma.serviceRequest.count(), 1);
});

test("an identical submission after the window creates a new request", async () => {
  await reset();
  const student = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const actor = studentActor(student);

  const t0 = new Date();
  const first = await createServiceRequest({ actor, input: validInput(services[0].id), now: t0 });
  const later = new Date(t0.getTime() + LIMITS.duplicateWindowMs + 1000);
  const second = await createServiceRequest({ actor, input: validInput(services[0].id), now: later });

  assert.equal(second.duplicate, false);
  assert.notEqual(second.request.id, first.request.id);
  assert.equal(await prisma.serviceRequest.count(), 2);
});

/* ------------------------------------------------------------------ */
/*  Document association                                               */
/* ------------------------------------------------------------------ */

test("an owned, available document is attached atomically", async () => {
  await reset();
  const student = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const doc = await createDocument({ ownerId: student.id, status: "AVAILABLE" });

  const result = await createServiceRequest({
    actor: studentActor(student),
    input: validInput(services[0].id, { documentIds: [doc.id] }),
  });

  const attached = await prisma.document.findUnique({ where: { id: doc.id } });
  assert.equal(attached.requestId, result.request.id);

  const detail = await getStudentRequestById(studentActor(student), result.request.id);
  assert.equal(detail.documentCount, 1);
  assert.equal(detail.documents[0].id, doc.id);
});

test("a quarantined document is rejected and left unattached", async () => {
  await reset();
  const student = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const doc = await createDocument({ ownerId: student.id, status: "QUARANTINED" });

  await rejectsWith(
    createServiceRequest({
      actor: studentActor(student),
      input: validInput(services[0].id, { documentIds: [doc.id] }),
    }),
    ValidationError,
  );

  const after = await prisma.document.findUnique({ where: { id: doc.id } });
  assert.equal(after.requestId, null);
  assert.equal(await prisma.serviceRequest.count(), 0);
});

test("an AVAILABLE document with no clean scan cannot be attached", async () => {
  await reset();
  const student = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const doc = await createDocument({
    ownerId: student.id,
    status: "AVAILABLE",
    scanStatus: "UNSCANNED",
  });

  await rejectsWith(
    createServiceRequest({
      actor: studentActor(student),
      input: validInput(services[0].id, { documentIds: [doc.id] }),
    }),
    ValidationError,
  );

  const after = await prisma.document.findUnique({ where: { id: doc.id } });
  assert.equal(after.requestId, null);
  assert.equal(await prisma.serviceRequest.count(), 0);
});

test("another user's document id is rejected without creating a request", async () => {
  await reset();
  const student = await createStudent();
  const other = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const foreign = await createDocument({ ownerId: other.id, status: "AVAILABLE" });

  await assert.rejects(
    createServiceRequest({
      actor: studentActor(student),
      input: validInput(services[0].id, { documentIds: [foreign.id] }),
    }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      // The message must not disclose the other user's document.
      assert.ok(!/permission|owner|exist/i.test(error.message));
      return true;
    },
  );

  assert.equal(await prisma.serviceRequest.count(), 0);
  assert.equal((await prisma.document.findUnique({ where: { id: foreign.id } })).requestId, null);
});

test("a document already attached to another request is rejected", async () => {
  await reset();
  const student = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const doc = await createDocument({ ownerId: student.id, status: "AVAILABLE" });
  const first = await createServiceRequest({
    actor: studentActor(student),
    input: validInput(services[0].id, { documentIds: [doc.id] }),
  });
  assert.ok(first.request.id);

  await rejectsWith(
    createServiceRequest({
      actor: studentActor(student),
      input: validInput(services[0].id, { title: "Second distinct request", documentIds: [doc.id] }),
    }),
    ValidationError,
  );
});

/* ------------------------------------------------------------------ */
/*  Submission                                                         */
/* ------------------------------------------------------------------ */

test("the owning student submits a draft and it becomes AWAITING_PAYMENT", async () => {
  await reset();
  const student = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const created = await createServiceRequest({
    actor: studentActor(student),
    input: validInput(services[0].id),
  });

  const submitted = await submitServiceRequest({
    actor: studentActor(student),
    requestId: created.request.id,
  });
  assert.equal(submitted.status, "AWAITING_PAYMENT");

  const row = await prisma.serviceRequest.findUnique({ where: { id: created.request.id } });
  assert.equal(row.status, "AWAITING_PAYMENT");
  // Crucially, submitting must NOT mark the request paid.
  assert.notEqual(row.status, "PAID");
});

test("a non-owner cannot submit another student's request", async () => {
  await reset();
  const ownerStudent = await createStudent();
  const otherStudent = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const created = await createServiceRequest({
    actor: studentActor(ownerStudent),
    input: validInput(services[0].id),
  });

  await rejectsWith(
    submitServiceRequest({ actor: studentActor(otherStudent), requestId: created.request.id }),
    NotFoundError,
  );
  const row = await prisma.serviceRequest.findUnique({ where: { id: created.request.id } });
  assert.equal(row.status, "DRAFT");
});

test("an already-submitted request cannot be submitted again", async () => {
  await reset();
  const student = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const created = await createServiceRequest({
    actor: studentActor(student),
    input: validInput(services[0].id),
  });
  await submitServiceRequest({ actor: studentActor(student), requestId: created.request.id });

  await rejectsWith(
    submitServiceRequest({ actor: studentActor(student), requestId: created.request.id }),
    ConflictError,
  );
});

/* ------------------------------------------------------------------ */
/*  Queries — own data only                                            */
/* ------------------------------------------------------------------ */

test("listStudentRequests returns only the caller's requests, newest first", async () => {
  await reset();
  const student = await createStudent();
  const other = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });

  await createServiceRequest({
    actor: studentActor(other),
    input: validInput(services[0].id, { title: "Other student request" }),
  });
  await new Promise((r) => setTimeout(r, 5));
  await createServiceRequest({
    actor: studentActor(student),
    input: validInput(services[0].id, { title: "My request" }),
  });

  const list = await listStudentRequests(studentActor(student));
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "My request");
  assert.ok(list[0].instructorName.length > 0);
});

test("getStudentRequest hides another student's request behind a null", async () => {
  await reset();
  const owner = await createStudent();
  const other = await createStudent();
  const { services } = await createInstructor({
    service: { name: "Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const created = await createServiceRequest({
    actor: studentActor(owner),
    input: validInput(services[0].id),
  });
  const reference = (await prisma.serviceRequest.findUnique({ where: { id: created.request.id } })).reference;

  assert.ok(await getStudentRequest(studentActor(owner), reference));
  assert.equal(await getStudentRequest(studentActor(other), reference), null);
  assert.equal(await getStudentRequest(studentActor(owner), "REQ-0000-XXXXXX"), null);
  assert.equal(await getStudentRequestById(studentActor(other), created.request.id), null);
});

/* ------------------------------------------------------------------ */
/*  Requestable service resolver (wizard entry)                        */
/* ------------------------------------------------------------------ */

test("getRequestableService resolves a live service but refuses ineligible ones", async () => {
  await reset();
  const live = await createInstructor({
    service: { name: "Live Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
  });
  const unapproved = await createInstructor({ approved: false });
  const inactiveService = await createInstructor({
    service: { name: "Hidden", amountMinor: 100, currency: "INR", turnaroundHours: 24, isActive: false },
  });

  const resolved = await getRequestableService(live.services[0].id);
  assert.ok(resolved);
  assert.equal(resolved.serviceId, live.services[0].id);
  assert.equal(resolved.instructorId, live.profile.id);
  assert.ok(Array.isArray(resolved.services));

  assert.equal(await getRequestableService(unapproved.services[0].id), null);
  assert.equal(await getRequestableService(inactiveService.services[0].id), null);
  assert.equal(await getRequestableService("nope"), null);
  assert.equal(await getRequestableService(null), null);
});
