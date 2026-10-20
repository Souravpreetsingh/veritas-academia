import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db.ts";
import {
  parseInstructorRequestQuery,
  listInstructorRequests,
  getInstructorRequest,
  loadInstructorActorState,
  acceptServiceRequest,
  declineServiceRequest,
  DECISION_LIMITS,
  INSTRUCTOR_INBOX_PAGE_SIZE_MAX,
} from "../src/lib/instructor-requests.ts";
import { createServiceRequest, submitServiceRequest } from "../src/lib/service-requests.ts";
import { getStudentRequest } from "../src/lib/service-requests.ts";
import { canAccessDocument, isDocumentDownloadable } from "../src/lib/authorization.ts";
import {
  ConflictError,
  ForbiddenError,
  IneligibleError,
  NotFoundError,
  ValidationError,
} from "../src/lib/app-errors.ts";

// Database-backed tests for the instructor request inbox and the accept/decline
// workflow. Runs against prisma/test.db, prepared by scripts/run-tests.mjs.
//
// The suites exercise the real domain services directly (the same functions the
// route handlers call), with explicit actors standing in for the session; route
// handlers themselves cannot be imported outside a Next.js runtime.

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

async function createAdmin() {
  counter += 1;
  return prisma.user.create({
    data: { name: `Admin ${counter}`, email: `admin${counter}@test.local`, passwordHash: "hash", role: "ADMIN" },
  });
}

async function createInstructor({
  approved = true,
  active = true,
  suspended = false,
  role = "INSTRUCTOR",
  service = { name: "Manuscript Audit", amountMinor: 8500, currency: "INR", turnaroundHours: 24 },
} = {}) {
  counter += 1;
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
            create: [
              {
                code: `SVC-${counter}`,
                name: service.name,
                description: "Published academic support service.",
                amountMinor: service.amountMinor,
                currency: service.currency,
                turnaroundHours: service.turnaroundHours,
                isActive: true,
              },
            ],
          },
        },
      },
    },
    include: { instructorProfile: { include: { services: true } } },
  });
  return { user, profile: user.instructorProfile, services: user.instructorProfile.services };
}

async function createApplicant(applicationStatus) {
  counter += 1;
  const user = await prisma.user.create({
    data: {
      name: `Applicant ${counter}`,
      email: `applicant${counter}@test.local`,
      passwordHash: "hash",
      role: "STUDENT",
    },
  });
  await prisma.instructorApplication.create({
    data: {
      userId: user.id,
      fullName: user.name,
      email: user.email,
      bio: "An applicant with a background in academic peer review and methodology support.",
      termsAcceptedAt: new Date(),
      status: applicationStatus,
      activeKey: applicationStatus === "PENDING" ? user.id : null,
    },
  });
  return user;
}

const actorFor = (user, role) => ({ id: user.id, role });
const studentActor = (user) => actorFor(user, "STUDENT");
const instructorActor = (user) => actorFor(user, "INSTRUCTOR");
const adminActor = (user) => actorFor(user, "ADMIN");

/**
 * Create a request through the real student flow, then optionally submit it.
 * `paid` is a fixture shortcut for decision tests: it flips the request to
 * PAID directly because production payment state is only ever written by
 * src/lib/payments.ts (covered by tests/payments.test.mjs).
 */
async function createRequest(student, instructor, { submit = true, paid = false, title } = {}) {
  const service = instructor.services[0];
  const created = await createServiceRequest({
    actor: studentActor(student),
    input: {
      serviceId: service.id,
      title: title ?? "Literature Review — Climate Policy Corpus",
      instructions: "Verify all citations and flag unsupported claims across the corpus.",
      turnaroundHours: service.turnaroundHours,
    },
  });
  if (submit) {
    await submitServiceRequest({ actor: studentActor(student), requestId: created.request.id });
  }
  if (paid) {
    await prisma.serviceRequest.update({
      where: { id: created.request.id },
      data: { status: "PAID" },
    });
  }
  return prisma.serviceRequest.findUniqueOrThrow({ where: { id: created.request.id } });
}

async function createDocument({ ownerId, status = "AVAILABLE", scanStatus, requestId = null }) {
  counter += 1;
  return prisma.document.create({
    data: {
      ownerId,
      requestId,
      storageKey: unique("doc-key"),
      originalName: `manuscript-${counter}.pdf`,
      contentType: "application/pdf",
      sizeBytes: 1024,
      status,
      scanStatus: scanStatus ?? (status === "AVAILABLE" ? "CLEAN" : "UNSCANNED"),
    },
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

async function auditActionsFor(targetId) {
  const events = await prisma.auditEvent.findMany({ where: { targetId } });
  return events.map((event) => event.action);
}

test.after(async () => {
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/*  Pure query parsing                                                 */
/* ------------------------------------------------------------------ */

test("parseInstructorRequestQuery validates status, page and pageSize", () => {
  const ok = parseInstructorRequestQuery({ status: "ACCEPTED", page: "2", pageSize: "10" });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.status, "ACCEPTED");
  assert.equal(ok.value.page, 2);
  assert.equal(ok.value.pageSize, 10);

  const defaults = parseInstructorRequestQuery({});
  assert.equal(defaults.ok, true);
  assert.equal(defaults.value.status, null);
  assert.equal(defaults.value.page, 1);
  assert.equal(defaults.value.pageSize, 20);

  assert.equal(parseInstructorRequestQuery({ status: "SOMETHING_ELSE" }).ok, false);
  assert.equal(parseInstructorRequestQuery({ page: "0" }).ok, false);
  assert.equal(parseInstructorRequestQuery({ page: "abc" }).ok, false);
  assert.equal(
    parseInstructorRequestQuery({ pageSize: String(INSTRUCTOR_INBOX_PAGE_SIZE_MAX + 1) }).ok,
    false,
  );
});

/* ------------------------------------------------------------------ */
/*  Accept                                                             */
/* ------------------------------------------------------------------ */

test("the assigned, approved instructor accepts a paid request without touching the price snapshot", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor({
    service: { name: "Audit", amountMinor: 12345, currency: "USD", turnaroundHours: 24 },
  });
  const before = await createRequest(student, instructor, { paid: true });
  assert.equal(before.status, "PAID");
  assert.equal(before.amountMinor, 12345);
  assert.equal(before.currency, "USD");

  const result = await acceptServiceRequest({
    actor: instructorActor(instructor.user),
    requestId: before.id,
  });

  assert.equal(result.status, "ACCEPTED");
  assert.ok(result.decisionAt instanceof Date);

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: before.id } });
  assert.equal(after.status, "ACCEPTED");
  assert.ok(after.decisionAt instanceof Date);
  assert.equal(after.amountMinor, 12345, "price snapshot must be preserved");
  assert.equal(after.currency, "USD", "currency snapshot must be preserved");
  assert.equal(after.declineReason, null);

  const actions = await auditActionsFor(after.id);
  assert.ok(actions.includes("request.accepted"), "acceptance must be audited");
});

test("an acceptance never changes the assignment, student or price even when the caller tampers with the payload", async () => {
  await reset();
  const student = await createStudent();
  const otherStudent = await createStudent();
  const instructor = await createInstructor();
  const other = await createInstructor();
  const before = await createRequest(student, instructor, { paid: true });

  // The accept service takes no client input at all; simulate a hostile caller
  // invoking it through a route-like wrapper that tries to override fields.
  await acceptServiceRequest({
    actor: { ...instructorActor(instructor.user), role: "ADMIN" },
    requestId: before.id,
    instructorId: other.profile.id,
    studentId: otherStudent.id,
    amountMinor: 1,
    currency: "XYZ",
    status: "COMPLETED",
  });

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: before.id } });
  // The tampered role is ignored: the decision is attributed to the real user
  // and the stored values are untouched.
  assert.equal(after.status, "ACCEPTED");
  assert.equal(after.instructorId, instructor.profile.id);
  assert.equal(after.studentId, student.id);
  assert.equal(after.amountMinor, 8500);
  assert.equal(after.currency, "INR");
});

/* ------------------------------------------------------------------ */
/*  Decline                                                            */
/* ------------------------------------------------------------------ */

test("the assigned instructor declines with an optional student-visible reason", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const before = await createRequest(student, instructor, { paid: true });

  const reason = "The requested deadline is not feasible with the depth this review requires.";
  const result = await declineServiceRequest({
    actor: instructorActor(instructor.user),
    requestId: before.id,
    input: { reason },
  });

  assert.equal(result.status, "DECLINED");
  assert.equal(result.declineReason, reason);

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: before.id } });
  assert.equal(after.status, "DECLINED");
  assert.equal(after.declineReason, reason);
  assert.ok(after.decisionAt instanceof Date);

  const actions = await auditActionsFor(after.id);
  assert.ok(actions.includes("request.declined"), "decline must be audited");
});

test("a decline without a reason stores none", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const before = await createRequest(student, instructor, { paid: true });

  await declineServiceRequest({
    actor: instructorActor(instructor.user),
    requestId: before.id,
    input: {},
  });

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: before.id } });
  assert.equal(after.status, "DECLINED");
  assert.equal(after.declineReason, null);
});

test("client-supplied fields other than the reason are ignored during a decline", async () => {
  await reset();
  const student = await createStudent();
  const otherStudent = await createStudent();
  const instructor = await createInstructor();
  const other = await createInstructor();
  const before = await createRequest(student, instructor, { paid: true });

  await declineServiceRequest({
    actor: instructorActor(instructor.user),
    requestId: before.id,
    input: {
      reason: "Already at capacity for this review window.",
      role: "ADMIN",
      instructorId: other.profile.id,
      studentId: otherStudent.id,
      amountMinor: 1,
      currency: "XYZ",
      status: "COMPLETED",
      decisionAt: new Date("2000-01-01T00:00:00Z"),
      declineReason: "tampered",
    },
  });

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: before.id } });
  assert.equal(after.status, "DECLINED");
  assert.equal(after.declineReason, "Already at capacity for this review window.");
  assert.equal(after.instructorId, instructor.profile.id);
  assert.equal(after.studentId, student.id);
  assert.equal(after.amountMinor, 8500);
  assert.equal(after.currency, "INR");
  assert.ok(after.decisionAt.getTime() > new Date("2020-01-01").getTime(), "decisionAt must be server-set");
});

test("an invalid decline reason is rejected and nothing changes", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const before = await createRequest(student, instructor, { paid: true });

  await rejectsWith(
    declineServiceRequest({
      actor: instructorActor(instructor.user),
      requestId: before.id,
      input: { reason: "nope" },
    }),
    ValidationError,
  );
  await rejectsWith(
    declineServiceRequest({
      actor: instructorActor(instructor.user),
      requestId: before.id,
      input: { reason: 42 },
    }),
    ValidationError,
  );
  await rejectsWith(
    declineServiceRequest({
      actor: instructorActor(instructor.user),
      requestId: before.id,
      input: { reason: "x".repeat(DECISION_LIMITS.declineReasonMax + 1) },
    }),
    ValidationError,
  );

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: before.id } });
  assert.equal(after.status, "PAID");
  assert.equal(after.declineReason, null);
  assert.equal(after.decisionAt, null);
});

/* ------------------------------------------------------------------ */
/*  Invalid & repeated transitions                                     */
/* ------------------------------------------------------------------ */

test("a draft cannot be accepted or declined", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const draft = await createRequest(student, instructor, { submit: false });
  assert.equal(draft.status, "DRAFT");

  await rejectsWith(
    acceptServiceRequest({ actor: instructorActor(instructor.user), requestId: draft.id }),
    ConflictError,
  );
  await rejectsWith(
    declineServiceRequest({ actor: instructorActor(instructor.user), requestId: draft.id }),
    ConflictError,
  );

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(after.status, "DRAFT");
});

test("an unpaid request cannot be accepted or declined until payment is verified", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  assert.equal(request.status, "AWAITING_PAYMENT");

  await rejectsWith(
    acceptServiceRequest({ actor: instructorActor(instructor.user), requestId: request.id }),
    ConflictError,
  );
  await rejectsWith(
    declineServiceRequest({
      actor: instructorActor(instructor.user),
      requestId: request.id,
      input: {},
    }),
    ConflictError,
  );

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT", "an unpaid request never moves to a decision");
  assert.equal(after.decisionAt, null);

  const actions = await auditActionsFor(request.id);
  assert.ok(actions.includes("request.accept.denied"));
  assert.ok(actions.includes("request.decline.denied"));
});

test("repeated transitions are refused: accept once, decline once, never both", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor, { paid: true });
  const actor = instructorActor(instructor.user);

  await acceptServiceRequest({ actor, requestId: request.id });
  const acceptedAt = (await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } }))
    .decisionAt;

  await rejectsWith(
    acceptServiceRequest({ actor, requestId: request.id }),
    ConflictError,
  );
  await rejectsWith(
    declineServiceRequest({ actor, requestId: request.id, input: {} }),
    ConflictError,
  );

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "ACCEPTED");
  assert.equal(after.decisionAt.getTime(), acceptedAt.getTime(), "the original decision stands");

  const actions = await auditActionsFor(request.id);
  assert.equal(actions.filter((a) => a === "request.accepted").length, 1);
  assert.ok(actions.includes("request.accept.denied"), "denied re-attempts must be audited");
});

test("simultaneous accept/decline attempts cannot both win", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor, { paid: true });
  const actor = instructorActor(instructor.user);

  const [acceptOutcome, declineOutcome] = await Promise.allSettled([
    acceptServiceRequest({ actor, requestId: request.id }),
    declineServiceRequest({
      actor,
      requestId: request.id,
      input: { reason: "Schedule conflict for the requested window." },
    }),
  ]);

  const results = [acceptOutcome, declineOutcome];
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one decision may win");
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof ConflictError);

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  const winnerIsAccept = fulfilled[0].value.status === "ACCEPTED";
  assert.equal(after.status, winnerIsAccept ? "ACCEPTED" : "DECLINED");
  assert.equal(
    after.declineReason,
    winnerIsAccept ? null : "Schedule conflict for the requested window.",
    "the stored reason must match the winning action",
  );
  assert.equal(after.amountMinor, 8500);
});

/* ------------------------------------------------------------------ */
/*  Cross-instructor isolation                                         */
/* ------------------------------------------------------------------ */

test("another instructor cannot view or decide a request that is not assigned to them", async () => {
  await reset();
  const student = await createStudent();
  const assigned = await createInstructor();
  const stranger = await createInstructor();
  const request = await createRequest(student, assigned, { paid: true });
  const reference = request.reference;

  assert.ok(await getInstructorRequest(instructorActor(assigned.user), reference));
  assert.equal(await getInstructorRequest(instructorActor(stranger.user), reference), null);

  await rejectsWith(
    acceptServiceRequest({ actor: instructorActor(stranger.user), requestId: request.id }),
    NotFoundError,
  );
  await rejectsWith(
    declineServiceRequest({
      actor: instructorActor(stranger.user),
      requestId: request.id,
      input: { reason: "Not my assigned review at all." },
    }),
    NotFoundError,
  );

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "PAID", "a stranger must not change the request");
  assert.equal(after.decisionAt, null);

  const actions = await auditActionsFor(request.id);
  assert.ok(actions.includes("request.accept.denied"));
  assert.ok(actions.includes("request.decline.denied"));
});

test("a student cannot use the instructor workflow at all", async () => {
  await reset();
  const student = await createStudent();
  const other = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);

  assert.equal(await getInstructorRequest(studentActor(student), request.reference), null);
  assert.equal(await getInstructorRequest(studentActor(other), request.reference), null);

  await rejectsWith(
    acceptServiceRequest({ actor: studentActor(student), requestId: request.id }),
    IneligibleError,
  );
  await rejectsWith(
    declineServiceRequest({ actor: studentActor(student), requestId: request.id, input: {} }),
    IneligibleError,
  );

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");
});

test("an administrator has support visibility but no decision rights", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const admin = await createAdmin();
  const request = await createRequest(student, instructor);

  assert.ok(
    await getInstructorRequest(adminActor(admin), request.reference),
    "admin support view is allowed",
  );
  await rejectsWith(
    acceptServiceRequest({ actor: adminActor(admin), requestId: request.id }),
    IneligibleError,
  );

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");
});

test("an actor that no longer exists in the database is refused", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);

  await rejectsWith(
    acceptServiceRequest({
      actor: { id: "deleted-user", role: "INSTRUCTOR" },
      requestId: request.id,
    }),
    ForbiddenError,
  );
  await rejectsWith(
    declineServiceRequest({
      actor: { id: "deleted-user", role: "INSTRUCTOR" },
      requestId: request.id,
      input: {},
    }),
    ForbiddenError,
  );

  assert.equal(await loadInstructorActorState({ id: "deleted-user", role: "INSTRUCTOR" }), null);
});

/* ------------------------------------------------------------------ */
/*  Ineligible instructors (pending / rejected / withdrawn / suspended) */
/* ------------------------------------------------------------------ */

test("pending, rejected and withdrawn applicants cannot decide requests", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);

  for (const status of ["PENDING", "REJECTED", "WITHDRAWN"]) {
    const applicant = await createApplicant(status);
    await rejectsWith(
      acceptServiceRequest({ actor: studentActor(applicant), requestId: request.id }),
      IneligibleError,
    );
    await rejectsWith(
      declineServiceRequest({
        actor: studentActor(applicant),
        requestId: request.id,
        input: {},
      }),
      IneligibleError,
    );
  }

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");
});

test("an unapproved or inactive instructor profile cannot decide requests", async () => {
  await reset();
  const student = await createStudent();
  const unapproved = await createInstructor({ approved: false });
  const inactive = await createInstructor({ active: false });

  // Seed requests pointed directly at the ineligible instructors so the
  // assignment is correct and only the eligibility check can refuse.
  const unapprovedRequest = await prisma.serviceRequest.create({
    data: {
      reference: `REQ-TEST-${unique("UN")}`,
      studentId: student.id,
      instructorId: unapproved.profile.id,
      serviceId: unapproved.services[0].id,
      title: "Unapproved instructor request",
      status: "AWAITING_PAYMENT",
      amountMinor: 8500,
    },
  });
  const inactiveRequest = await prisma.serviceRequest.create({
    data: {
      reference: `REQ-TEST-${unique("IN")}`,
      studentId: student.id,
      instructorId: inactive.profile.id,
      serviceId: inactive.services[0].id,
      title: "Inactive instructor request",
      status: "AWAITING_PAYMENT",
      amountMinor: 8500,
    },
  });

  await rejectsWith(
    acceptServiceRequest({ actor: instructorActor(unapproved.user), requestId: unapprovedRequest.id }),
    IneligibleError,
  );
  await rejectsWith(
    declineServiceRequest({
      actor: instructorActor(inactive.user),
      requestId: inactiveRequest.id,
      input: {},
    }),
    IneligibleError,
  );

  const afterUnapproved = await prisma.serviceRequest.findUniqueOrThrow({
    where: { id: unapprovedRequest.id },
  });
  const afterInactive = await prisma.serviceRequest.findUniqueOrThrow({
    where: { id: inactiveRequest.id },
  });
  assert.equal(afterUnapproved.status, "AWAITING_PAYMENT");
  assert.equal(afterInactive.status, "AWAITING_PAYMENT");
});

test("a suspended instructor cannot decide requests even with a valid profile", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor({ suspended: true });
  // `createServiceRequest` refuses suspended instructors, so seed the request
  // directly with the correct assignment to isolate the decision check.
  const request = await prisma.serviceRequest.create({
    data: {
      reference: `REQ-TEST-${unique("SUS")}`,
      studentId: student.id,
      instructorId: instructor.profile.id,
      serviceId: instructor.services[0].id,
      title: "Suspended instructor request",
      status: "AWAITING_PAYMENT",
      amountMinor: 8500,
    },
  });

  await rejectsWith(
    acceptServiceRequest({ actor: instructorActor(instructor.user), requestId: request.id }),
    IneligibleError,
  );

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");
  assert.equal(after.decisionAt, null);

  const state = await loadInstructorActorState(instructorActor(instructor.user));
  assert.equal(state.eligibility.eligible, false);
});

/* ------------------------------------------------------------------ */
/*  Inbox listing, filtering, pagination and scoping                   */
/* ------------------------------------------------------------------ */

test("the inbox lists only the caller's assigned requests, with real counts", async () => {
  await reset();
  const student = await createStudent();
  const first = await createInstructor();
  const second = await createInstructor();

  const mineA = await createRequest(student, first, { title: "First request", paid: true });
  await new Promise((r) => setTimeout(r, 5));
  const mineB = await createRequest(student, first, { title: "Second request", paid: true });
  await createRequest(student, second, { title: "Other instructor request" });

  // Decline the first request so the queue has two distinct statuses.
  await declineServiceRequest({
    actor: instructorActor(first.user),
    requestId: mineA.id,
    input: {},
  });

  const query = { status: null, page: 1, pageSize: 20 };
  const list = await listInstructorRequests({ actor: instructorActor(first.user), query });
  assert.equal(list.total, 2);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].id, mineB.id, "newest first");
  assert.deepEqual(list.counts.PAID, 1);
  assert.deepEqual(list.counts.DECLINED, 1);

  const declinedOnly = await listInstructorRequests({
    actor: instructorActor(first.user),
    query: { status: "DECLINED", page: 1, pageSize: 20 },
  });
  assert.equal(declinedOnly.total, 1);
  assert.equal(declinedOnly.items[0].id, mineA.id);

  const otherList = await listInstructorRequests({
    actor: instructorActor(second.user),
    query,
  });
  assert.equal(otherList.total, 1);
  assert.equal(otherList.items[0].studentName.length > 0, true);
});

test("inbox pagination never leaks past the instructor's own rows", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  await createRequest(student, instructor, { title: "One" });
  await new Promise((r) => setTimeout(r, 5));
  await createRequest(student, instructor, { title: "Two" });
  await new Promise((r) => setTimeout(r, 5));
  await createRequest(student, instructor, { title: "Three" });

  const page1 = await listInstructorRequests({
    actor: instructorActor(instructor.user),
    query: { status: null, page: 1, pageSize: 2 },
  });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.total, 3);
  assert.equal(page1.totalPages, 2);

  const page2 = await listInstructorRequests({
    actor: instructorActor(instructor.user),
    query: { status: null, page: 2, pageSize: 2 },
  });
  assert.equal(page2.items.length, 1);

  const ids = new Set(
    [...page1.items, ...page2.items].map((item) => item.id),
  );
  assert.equal(ids.size, 3);
});

test("non-instructors get an empty inbox, never someone else's queue", async () => {
  await reset();
  const student = await createStudent();
  const admin = await createAdmin();
  const instructor = await createInstructor({ suspended: true });
  await prisma.serviceRequest.create({
    data: {
      reference: `REQ-TEST-${unique("EMPTY")}`,
      studentId: student.id,
      instructorId: instructor.profile.id,
      serviceId: instructor.services[0].id,
      title: "Hidden request",
      status: "AWAITING_PAYMENT",
      amountMinor: 8500,
    },
  });

  const query = { status: null, page: 1, pageSize: 20 };
  const asStudent = await listInstructorRequests({ actor: studentActor(student), query });
  assert.equal(asStudent.total, 0);
  assert.deepEqual(asStudent.items, []);

  const asAdmin = await listInstructorRequests({ actor: adminActor(admin), query });
  assert.equal(asAdmin.total, 0);

  const asSuspended = await listInstructorRequests({
    actor: instructorActor(instructor.user),
    query,
  });
  assert.equal(asSuspended.total, 0, "a suspended instructor sees nothing");
});

/* ------------------------------------------------------------------ */
/*  Detail visibility & documents                                      */
/* ------------------------------------------------------------------ */

test("getInstructorRequest returns null for missing or malformed references", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const actor = instructorActor(instructor.user);

  assert.equal(await getInstructorRequest(actor, "REQ-0000-XXXXXX"), null);
  assert.equal(await getInstructorRequest(actor, ""), null);
  assert.equal(await getInstructorRequest(actor, "x".repeat(65)), null);
  assert.equal(await getInstructorRequest(actor, null), null);
  assert.equal(await getInstructorRequest(actor, 42), null);
  assert.ok(await getInstructorRequest(actor, request.reference));
});

test("the detail exposes only the request's own documents and the assigned instructor can access them", async () => {
  await reset();
  const student = await createStudent();
  const otherStudent = await createStudent();
  const assigned = await createInstructor();
  const stranger = await createInstructor();
  const request = await createRequest(student, assigned);
  const otherRequest = await createRequest(otherStudent, stranger, { title: "Other request" });

  const ownDoc = await createDocument({
    ownerId: student.id,
    requestId: request.id,
    status: "AVAILABLE",
  });
  const otherDoc = await createDocument({
    ownerId: otherStudent.id,
    requestId: otherRequest.id,
    status: "AVAILABLE",
  });
  const quarantined = await createDocument({
    ownerId: student.id,
    requestId: request.id,
    status: "QUARANTINED",
  });

  const detail = await getInstructorRequest(instructorActor(assigned.user), request.reference);
  assert.equal(detail.documents.length, 2);
  assert.deepEqual(
    detail.documents.map((doc) => doc.id).sort(),
    [ownDoc.id, quarantined.id].sort(),
  );
  assert.ok(!detail.documents.some((doc) => doc.id === otherDoc.id));

  // Mirror the download route's include shape for each document.
  const load = (id) =>
    prisma.document.findUniqueOrThrow({
      where: { id },
      include: { request: { include: { instructor: true } } },
    });

  assert.equal(
    canAccessDocument(instructorActor(assigned.user), await load(ownDoc.id)),
    true,
    "assigned instructor may download request documents",
  );
  assert.equal(
    canAccessDocument(instructorActor(stranger.user), await load(ownDoc.id)),
    false,
    "unassigned instructor may not download",
  );
  assert.equal(
    canAccessDocument(studentActor(otherStudent), await load(ownDoc.id)),
    false,
    "another student may not download",
  );
  assert.equal(
    isDocumentDownloadable({ status: "QUARANTINED", scanStatus: "UNSCANNED" }),
    false,
  );
});

test("status changes are immediately visible to the student's own request view", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor, { paid: true });

  const before = await getStudentRequest(studentActor(student), request.reference);
  assert.equal(before.status, "PAID");
  assert.equal(before.declineReason, null);
  assert.equal(before.decisionAt, null);

  const reason = "Outside my primary subject expertise for this cohort.";
  await declineServiceRequest({
    actor: instructorActor(instructor.user),
    requestId: request.id,
    input: { reason },
  });

  const after = await getStudentRequest(studentActor(student), request.reference);
  assert.equal(after.status, "DECLINED");
  assert.equal(after.declineReason, reason, "the student-visible reason is exposed");
  assert.ok(after.decisionAt instanceof Date);
});
