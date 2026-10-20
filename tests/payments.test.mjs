import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db.ts";
import {
  createPaymentOrder,
  verifyCheckoutPayment,
  processRazorpayWebhook,
  getRequestPaymentSummary,
} from "../src/lib/payments.ts";
import {
  readRazorpayConfig,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "../src/lib/razorpay.ts";
import { createServiceRequest, submitServiceRequest } from "../src/lib/service-requests.ts";
import { acceptServiceRequest } from "../src/lib/instructor-requests.ts";
import {
  ConfigurationError,
  ConflictError,
  NotFoundError,
  ProviderError,
  ValidationError,
} from "../src/lib/app-errors.ts";

// Database-backed tests for the Razorpay payment workflow. Runs against
// prisma/test.db, prepared by scripts/run-tests.mjs.
//
// No test performs a real transaction or network call: the official SDK sits
// behind the RazorpayGateway interface and every gateway here is a deterministic
// fake. Signatures are computed locally with throwaway test secrets.

const KEY_ID = "rzp_test_00000000000000";
const KEY_SECRET = "test_key_secret_never_a_real_credential";
const WEBHOOK_SECRET = "test_webhook_secret_never_a_real_credential";

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
    data: {
      name: `Admin ${counter}`,
      email: `admin${counter}@test.local`,
      passwordHash: "hash",
      role: "ADMIN",
    },
  });
}

async function createInstructor() {
  counter += 1;
  const user = await prisma.user.create({
    data: {
      name: `Instructor ${counter}`,
      email: `instructor${counter}@test.local`,
      passwordHash: "hash",
      role: "INSTRUCTOR",
      instructorProfile: {
        create: {
          headline: "Payment Test Instructor",
          isApproved: true,
          isActive: true,
          services: {
            create: [
              {
                code: `SVC-${counter}`,
                name: "Manuscript Audit",
                description: "Published academic support service.",
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
  return { user, profile: user.instructorProfile, services: user.instructorProfile.services };
}

const actorFor = (user, role) => ({ id: user.id, role });
const studentActor = (user) => actorFor(user, "STUDENT");
const instructorActor = (user) => actorFor(user, "INSTRUCTOR");
const adminActor = (user) => actorFor(user, "ADMIN");

async function createRequest(student, instructor, { submit = true } = {}) {
  const service = instructor.services[0];
  const created = await createServiceRequest({
    actor: studentActor(student),
    input: {
      serviceId: service.id,
      title: "Payments Test Request",
      instructions: "Verify the references in the submitted manuscript.",
      turnaroundHours: service.turnaroundHours,
    },
  });
  if (submit) {
    await submitServiceRequest({ actor: studentActor(student), requestId: created.request.id });
  }
  return prisma.serviceRequest.findUniqueOrThrow({ where: { id: created.request.id } });
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

/* ------------------------------------------------------------------ */
/*  Deterministic provider fakes                                       */
/* ------------------------------------------------------------------ */

function makeContext({ createOrder, fetchPayment } = {}) {
  const calls = { createOrder: [], fetchPayment: [] };
  const gateway = {
    async createOrder(input) {
      calls.createOrder.push(input);
      if (createOrder) return createOrder(input, calls);
      return {
        id: `order_test_${calls.createOrder.length}`,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: "created",
      };
    },
    async fetchPayment(paymentId) {
      calls.fetchPayment.push(paymentId);
      if (fetchPayment) return fetchPayment(paymentId, calls);
      throw new Error("fetchPayment was not stubbed for this test");
    },
  };
  return {
    context: {
      config: { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET },
      gateway,
    },
    calls,
  };
}

function providerPayment({ id, orderId, amountMinor, currency, status = "captured", errorCode = null }) {
  return { id, orderId, amountMinor, currency, status, errorCode };
}

const checkoutSignature = (orderId, paymentId) =>
  createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");

const webhookSignature = (rawBody) =>
  createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");

let eventCounter = 0;
function nextEventId() {
  eventCounter += 1;
  return `evt_test_${eventCounter}`;
}

function paymentWebhookBody({
  event = "payment.captured",
  orderId,
  paymentId,
  amountMinor,
  currency,
  status = "captured",
  errorCode = null,
}) {
  return JSON.stringify({
    entity: "event",
    account_id: "acc_test",
    event,
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          status,
          amount: amountMinor,
          currency,
          error_code: errorCode,
        },
      },
    },
    created_at: 1_700_000_000,
  });
}

function orderWebhookBody({ event = "order.paid", orderId, amountMinor, currency }) {
  return JSON.stringify({
    entity: "event",
    account_id: "acc_test",
    event,
    contains: ["order"],
    payload: {
      order: {
        entity: { id: orderId, amount: amountMinor, currency, status: "paid" },
      },
    },
    created_at: 1_700_000_000,
  });
}

async function deliver(context, rawBody, { eventId = nextEventId(), signature } = {}) {
  return processRazorpayWebhook({
    rawBody,
    signature: signature ?? webhookSignature(rawBody),
    eventId,
    context,
  });
}

/** Create the local + provider order; the captured-payment stub binds its order id. */
async function openOrder({ student, request, fetchPayment } = {}) {
  let providerOrderId = null;
  const made = makeContext({
    createOrder: (input, calls) => {
      providerOrderId = `order_local_${calls.createOrder.length}`;
      return {
        id: providerOrderId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: "created",
      };
    },
    fetchPayment: (paymentId) =>
      fetchPayment
        ? fetchPayment(paymentId, providerOrderId)
        : providerPayment({
            id: paymentId,
            orderId: providerOrderId,
            amountMinor: request.amountMinor,
            currency: request.currency,
          }),
  });
  const order = await createPaymentOrder({
    actor: studentActor(student),
    requestId: request.id,
    context: made.context,
  });
  return { ...made, order, providerOrderId };
}

/** Run the full local checkout flow with a successful captured payment. */
async function payRequest({ student, request, paymentId = "pay_test_1" }) {
  let orderId = null;
  const { context } = makeContext({
    createOrder: (input, calls) => {
      orderId = `order_test_${calls.createOrder.length}`;
      return { id: orderId, amountMinor: input.amountMinor, currency: input.currency, status: "created" };
    },
    fetchPayment: (fetchedId) =>
      providerPayment({
        id: fetchedId,
        orderId,
        amountMinor: request.amountMinor,
        currency: request.currency,
      }),
  });
  const order = await createPaymentOrder({
    actor: studentActor(student),
    requestId: request.id,
    context,
  });
  return verifyCheckoutPayment({
    actor: studentActor(student),
    requestId: request.id,
    orderId: order.orderId,
    paymentId,
    signature: checkoutSignature(order.orderId, paymentId),
    context,
  });
}

test.after(async () => {
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/*  Configuration & signatures (pure)                                  */
/* ------------------------------------------------------------------ */

test("Razorpay configuration requires the checkout key pair and accepts the legacy secret alias", () => {
  assert.equal(readRazorpayConfig({}), null);
  assert.equal(readRazorpayConfig({ RAZORPAY_KEY_ID: KEY_ID }), null, "secret missing");
  assert.equal(readRazorpayConfig({ RAZORPAY_KEY_SECRET: KEY_SECRET }), null, "key id missing");
  assert.equal(
    readRazorpayConfig({
      RAZORPAY_KEY_ID: KEY_ID,
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: " ",
    })?.webhookSecret,
    null,
    "whitespace is treated as unset",
  );

  const primary = readRazorpayConfig({
    RAZORPAY_KEY_ID: KEY_ID,
    RAZORPAY_KEY_SECRET: KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
  assert.deepEqual(primary, {
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    webhookSecret: WEBHOOK_SECRET,
  });

  const legacy = readRazorpayConfig({
    RAZORPAY_KEY_ID: KEY_ID,
    RAZORPAY_SECRET: KEY_SECRET,
  });
  assert.equal(legacy?.keySecret, KEY_SECRET);
  assert.equal(legacy?.webhookSecret, null);
});

test("checkout signatures follow the Razorpay protocol and reject tampering", () => {
  const orderId = "order_test_sig";
  const paymentId = "pay_test_sig";
  const signature = checkoutSignature(orderId, paymentId);

  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature }, KEY_SECRET), true);
  assert.equal(
    verifyCheckoutSignature({ orderId, paymentId, signature }, "another-secret"),
    false,
    "a different key secret must not verify",
  );
  assert.equal(
    verifyCheckoutSignature({ orderId: paymentId, paymentId: orderId, signature }, KEY_SECRET),
    false,
    "swapped identifiers must not verify",
  );
  assert.equal(
    verifyCheckoutSignature({ orderId, paymentId, signature: "deadbeef" }, KEY_SECRET),
    false,
    "a malformed signature must not verify",
  );
  assert.equal(
    verifyCheckoutSignature({ orderId, paymentId, signature: "" }, KEY_SECRET),
    false,
  );
});

test("webhook signatures cover the exact raw body, not a re-serialized payload", () => {
  const rawBody = paymentWebhookBody({
    orderId: "order_test_raw",
    paymentId: "pay_test_raw",
    amountMinor: 8500,
    currency: "INR",
  });
  const signature = webhookSignature(rawBody);

  assert.equal(verifyWebhookSignature(rawBody, signature, WEBHOOK_SECRET), true);
  assert.equal(verifyWebhookSignature(`${rawBody} `, signature, WEBHOOK_SECRET), false);
  assert.equal(
    verifyWebhookSignature(JSON.stringify(JSON.parse(rawBody)), signature, WEBHOOK_SECRET),
    true,
    "identical bytes verify",
  );
  assert.equal(verifyWebhookSignature(rawBody, signature, "wrong-webhook-secret"), false);
  assert.equal(verifyWebhookSignature("", signature, WEBHOOK_SECRET), false);
});

/* ------------------------------------------------------------------ */
/*  Order creation                                                     */
/* ------------------------------------------------------------------ */

test("order creation uses only the stored price snapshot and returns no secrets", async () => {
  await reset();
  const student = await createStudent();
  const other = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  assert.equal(request.status, "AWAITING_PAYMENT");

  const { context, calls } = makeContext();
  const result = await createPaymentOrder({
    actor: studentActor(student),
    requestId: request.id,
    context,
    // Hostile extra fields a route wrapper might forward: all ignored.
    amountMinor: 1,
    currency: "XYZ",
    studentId: other.id,
    status: "PAID",
    role: "ADMIN",
  });

  assert.equal(calls.createOrder.length, 1);
  assert.equal(calls.createOrder[0].amountMinor, request.amountMinor);
  assert.equal(calls.createOrder[0].currency, request.currency);
  assert.equal(calls.createOrder[0].notes.requestId, request.id);
  assert.equal(calls.createOrder[0].receipt, request.reference.slice(0, 40));

  const local = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(local.status, "CREATED");
  assert.equal(local.amountMinor, request.amountMinor);
  assert.equal(local.currency, request.currency);
  assert.equal(local.providerPaymentId, null);
  assert.equal(local.activeKey, request.id);

  assert.equal(result.provider, "RAZORPAY");
  assert.equal(result.orderId, local.providerOrderId);
  assert.equal(result.amountMinor, request.amountMinor);
  assert.equal(result.currency, request.currency);
  assert.equal(result.keyId, KEY_ID, "only the public key id is returned");
  assert.equal(result.resumed, false);
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "amountMinor",
      "currency",
      "keyId",
      "orderId",
      "paymentId",
      "provider",
      "requestReference",
      "resumed",
    ].sort(),
  );
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(KEY_SECRET), "the key secret must never be serialized");
  assert.ok(!serialized.includes(WEBHOOK_SECRET), "the webhook secret must never be serialized");

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT", "creating an order is not a payment");
});

test("order creation is scoped to the owning, existing student", async () => {
  await reset();
  const student = await createStudent();
  const other = await createStudent();
  const instructor = await createInstructor();
  const admin = await createAdmin();
  const request = await createRequest(student, instructor);

  for (const actor of [studentActor(other), instructorActor(instructor.user), adminActor(admin)]) {
    const { context, calls } = makeContext();
    await rejectsWith(
      createPaymentOrder({ actor, requestId: request.id, context }),
      NotFoundError,
    );
    assert.equal(calls.createOrder.length, 0, "no provider order may be created");
  }

  assert.equal(await prisma.payment.count(), 0);
});

test("order creation is refused for requests that are not awaiting payment", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const draft = await createRequest(student, instructor, { submit: false });
  const request = await createRequest(student, instructor);
  await prisma.serviceRequest.update({ where: { id: request.id }, data: { status: "PAID" } });

  const { context, calls } = makeContext();
  await rejectsWith(
    createPaymentOrder({ actor: studentActor(student), requestId: draft.id, context }),
    ConflictError,
  );
  await rejectsWith(
    createPaymentOrder({ actor: studentActor(student), requestId: request.id, context }),
    ConflictError,
  );
  assert.equal(calls.createOrder.length, 0);

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "PAID", "an already-paid request never creates another order");
});

test("repeated order initiation resumes the single active order", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { context, calls } = makeContext();

  const first = await createPaymentOrder({
    actor: studentActor(student),
    requestId: request.id,
    context,
  });
  const second = await createPaymentOrder({
    actor: studentActor(student),
    requestId: request.id,
    context,
  });

  assert.equal(calls.createOrder.length, 1, "no duplicate provider order");
  assert.equal(second.orderId, first.orderId);
  assert.equal(second.paymentId, first.paymentId);
  assert.equal(second.resumed, true);
  assert.equal(await prisma.payment.count({ where: { requestId: request.id } }), 1);
});

test("concurrent order initiation creates at most one active order", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);

  const { context, calls } = makeContext({
    createOrder: async (input, callLog) => {
      // Yield so both concurrent calls can pass the "no active order" check.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        id: `order_concurrent_${callLog.createOrder.length}`,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: "created",
      };
    },
  });

  const results = await Promise.all([
    createPaymentOrder({ actor: studentActor(student), requestId: request.id, context }),
    createPaymentOrder({ actor: studentActor(student), requestId: request.id, context }),
  ]);

  const rows = await prisma.payment.findMany({ where: { requestId: request.id } });
  assert.equal(rows.length, 1, "exactly one local payment row may exist");
  assert.equal(rows[0].activeKey, request.id);
  assert.ok(calls.createOrder.length <= 2);
  assert.equal(new Set(results.map((result) => result.orderId)).size, 1);
  assert.equal(results[0].orderId, rows[0].providerOrderId);
  assert.equal(results[1].orderId, rows[0].providerOrderId);
});

test("provider failures leave no local payment state and surface a safe error", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);

  const { context } = makeContext({
    createOrder: () => {
      throw new ProviderError();
    },
  });

  await rejectsWith(
    createPaymentOrder({ actor: studentActor(student), requestId: request.id, context }),
    ProviderError,
  );

  assert.equal(await prisma.payment.count(), 0);
  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");

  const denied = await prisma.auditEvent.findMany({
    where: { action: "payment.order.create.denied", targetId: request.id },
  });
  assert.ok(denied.length > 0, "the denial must be audited");
});

test("missing configuration fails safely instead of simulating a payment", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);

  const saved = {
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
    RAZORPAY_SECRET: process.env.RAZORPAY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,
  };

  try {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;

    await rejectsWith(
      createPaymentOrder({ actor: studentActor(student), requestId: request.id }),
      ConfigurationError,
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(await prisma.payment.count(), 0, "no payment may exist without configuration");
});

/* ------------------------------------------------------------------ */
/*  Checkout verification                                              */
/* ------------------------------------------------------------------ */

test("a verified checkout marks the payment and request paid exactly once", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({ student, request });
  const paymentId = "pay_captured_1";

  const result = await verifyCheckoutPayment({
    actor: studentActor(student),
    requestId: request.id,
    orderId: order.orderId,
    paymentId,
    signature: checkoutSignature(order.orderId, paymentId),
    context,
  });

  assert.equal(result.status, "PAID");
  assert.equal(result.requestStatus, "PAID");
  assert.ok(result.paidAt instanceof Date);

  const payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "PAID");
  assert.equal(payment.providerPaymentId, paymentId);
  assert.ok(payment.paidAt instanceof Date);
  assert.equal(payment.activeKey, null, "a paid order is no longer active");
  assert.equal(payment.providerOrderId, order.orderId);
  assert.equal(payment.amountMinor, request.amountMinor);
  assert.equal(payment.currency, request.currency);

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "PAID");
  assert.equal(after.decisionAt, null, "payment is not a decision");

  const verified = await prisma.auditEvent.count({
    where: { action: "payment.verified", targetId: payment.id },
  });
  assert.equal(verified, 1);
});

test("an invalid checkout signature is rejected before any provider lookup", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context, calls } = await openOrder({ student, request });

  await rejectsWith(
    verifyCheckoutPayment({
      actor: studentActor(student),
      requestId: request.id,
      orderId: order.orderId,
      paymentId: "pay_forged_1",
      signature: "0".repeat(64),
      context,
    }),
    ValidationError,
  );

  assert.equal(calls.fetchPayment.length, 0, "no provider call for an unverified callback");
  const payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "CREATED");
  assert.equal(payment.providerPaymentId, null);
  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");

  assert.ok((await prisma.auditEvent.count({ where: { action: "payment.verification.denied" } })) > 0);
});

test("another student cannot verify a payment for someone else's request", async () => {
  await reset();
  const student = await createStudent();
  const other = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({ student, request });

  const paymentId = "pay_other_1";
  await rejectsWith(
    verifyCheckoutPayment({
      actor: studentActor(other),
      requestId: request.id,
      orderId: order.orderId,
      paymentId,
      signature: checkoutSignature(order.orderId, paymentId),
      context,
    }),
    NotFoundError,
  );

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");
  const payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "CREATED");
});

test("provider amount, currency and order mismatches never mark a payment successful", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);

  const state = {
    amountMinor: request.amountMinor,
    currency: request.currency,
    orderId: null,
  };
  const { order, context } = await openOrder({
    student,
    request,
    fetchPayment: (paymentId, localOrderId) =>
      providerPayment({
        id: paymentId,
        orderId: state.orderId ?? localOrderId,
        amountMinor: state.amountMinor,
        currency: state.currency,
      }),
  });

  const paymentId = "pay_mismatch_1";
  const attempt = () =>
    verifyCheckoutPayment({
      actor: studentActor(student),
      requestId: request.id,
      orderId: order.orderId,
      paymentId,
      signature: checkoutSignature(order.orderId, paymentId),
      context,
    });

  state.amountMinor = request.amountMinor + 1;
  await rejectsWith(attempt(), ValidationError);
  state.amountMinor = request.amountMinor;
  state.currency = "USD";
  await rejectsWith(attempt(), ValidationError);
  state.currency = request.currency;
  state.orderId = "order_somewhere_else";
  await rejectsWith(attempt(), ValidationError);

  const payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "CREATED");
  assert.equal(payment.providerPaymentId, null);
  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");
  assert.equal(await prisma.auditEvent.count({ where: { action: "payment.mismatch" } }), 3);
});

test("an authorized (not captured) payment stays pending until the webhook confirms capture", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({
    student,
    request,
    fetchPayment: (paymentId, localOrderId) =>
      providerPayment({
        id: paymentId,
        orderId: localOrderId,
        amountMinor: request.amountMinor,
        currency: request.currency,
        status: "authorized",
      }),
  });

  const paymentId = "pay_authorized_1";
  const result = await verifyCheckoutPayment({
    actor: studentActor(student),
    requestId: request.id,
    orderId: order.orderId,
    paymentId,
    signature: checkoutSignature(order.orderId, paymentId),
    context,
  });

  assert.equal(result.status, "PENDING");
  assert.equal(result.paidAt, null);

  const payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "CREATED");
  assert.equal(payment.activeKey, request.id, "the order stays available for capture");
  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");
  assert.equal(await prisma.auditEvent.count({ where: { action: "payment.verified" } }), 0);
});

test("repeated checkout verification callbacks are idempotent", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({ student, request });
  const paymentId = "pay_repeat_1";

  const args = {
    actor: studentActor(student),
    requestId: request.id,
    orderId: order.orderId,
    paymentId,
    signature: checkoutSignature(order.orderId, paymentId),
    context,
  };

  const first = await verifyCheckoutPayment(args);
  const firstPayment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  const firstPaidAt = firstPayment.paidAt;

  const second = await verifyCheckoutPayment(args);
  assert.equal(first.status, "PAID");
  assert.equal(second.status, "PAID");

  const rows = await prisma.payment.findMany({ where: { requestId: request.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paidAt.getTime(), firstPaidAt.getTime(), "the original payment time stands");
  assert.equal(
    await prisma.auditEvent.count({ where: { action: "payment.verified", targetId: rows[0].id } }),
    1,
    "a replayed callback must not record a second success",
  );
});

test("a provider payment id already applied elsewhere cannot be applied to a second request", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const requestA = await createRequest(student, instructor);
  const requestB = await createRequest(student, instructor);

  await payRequest({ student, request: requestA, paymentId: "pay_shared_1" });

  const { order, context } = await openOrder({
    student,
    request: requestB,
    fetchPayment: (paymentId, localOrderId) =>
      providerPayment({
        id: "pay_shared_1",
        orderId: localOrderId,
        amountMinor: requestB.amountMinor,
        currency: requestB.currency,
      }),
  });

  await rejectsWith(
    verifyCheckoutPayment({
      actor: studentActor(student),
      requestId: requestB.id,
      orderId: order.orderId,
      paymentId: "pay_shared_1",
      signature: checkoutSignature(order.orderId, "pay_shared_1"),
      context,
    }),
    ValidationError,
  );

  const paymentB = await prisma.payment.findFirstOrThrow({ where: { requestId: requestB.id } });
  assert.equal(paymentB.status, "CREATED");
  assert.equal(paymentB.providerPaymentId, null, "the reused id must not be recorded again");
  const afterB = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestB.id } });
  assert.equal(afterB.status, "AWAITING_PAYMENT");
  assert.ok((await prisma.auditEvent.count({ where: { action: "payment.mismatch" } })) > 0);
});

test("a provider lookup failure leaves the request unpaid", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({
    student,
    request,
    fetchPayment: () => {
      throw new ProviderError();
    },
  });

  await rejectsWith(
    verifyCheckoutPayment({
      actor: studentActor(student),
      requestId: request.id,
      orderId: order.orderId,
      paymentId: "pay_provider_down_1",
      signature: checkoutSignature(order.orderId, "pay_provider_down_1"),
      context,
    }),
    ProviderError,
  );

  const payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "CREATED");
  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");
});

/* ------------------------------------------------------------------ */
/*  Webhooks                                                           */
/* ------------------------------------------------------------------ */

test("a webhook with an invalid signature is rejected without applying anything", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({ student, request });

  const rawBody = paymentWebhookBody({
    orderId: order.orderId,
    paymentId: "pay_webhook_forged_1",
    amountMinor: request.amountMinor,
    currency: request.currency,
  });

  const result = await deliver(context, rawBody, { signature: "f".repeat(64) });
  assert.equal(result.httpStatus, 400);
  assert.equal(result.outcome, "REJECTED");

  assert.equal(
    await prisma.paymentWebhookEvent.count(),
    0,
    "a forged delivery is never recorded as a processed event",
  );
  const payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "CREATED");
  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");
  assert.ok(
    (await prisma.auditEvent.count({ where: { action: "payment.webhook.rejected" } })) > 0,
  );
});

test("the webhook signature covers the exact raw body that is parsed", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({ student, request });

  const payload = JSON.parse(
    paymentWebhookBody({
      orderId: order.orderId,
      paymentId: "pay_raw_body_1",
      amountMinor: request.amountMinor,
      currency: request.currency,
    }),
  );
  const rawBody = JSON.stringify(payload, null, 2);
  const compactBody = JSON.stringify(payload);
  const signature = webhookSignature(rawBody);

  // A re-serialized body has different bytes, so its signature cannot verify.
  const rejected = await deliver(context, compactBody, {
    signature,
    eventId: nextEventId(),
  });
  assert.equal(rejected.httpStatus, 400);
  assert.equal(rejected.outcome, "REJECTED");

  const accepted = await deliver(context, rawBody, { signature, eventId: nextEventId() });
  assert.equal(accepted.httpStatus, 200);
  assert.equal(accepted.outcome, "APPLIED");

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "PAID");
});

test("a verified payment.captured webhook marks the request paid and records the event once", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({ student, request });
  const paymentId = "pay_webhook_captured_1";
  const eventId = "evt_captured_1";

  const rawBody = paymentWebhookBody({
    orderId: order.orderId,
    paymentId,
    amountMinor: request.amountMinor,
    currency: request.currency,
  });

  const result = await deliver(context, rawBody, { eventId });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.outcome, "APPLIED");

  const payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "PAID");
  assert.equal(payment.providerPaymentId, paymentId);
  assert.equal(payment.activeKey, null);
  assert.ok(payment.paidAt instanceof Date);

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "PAID");

  const events = await prisma.paymentWebhookEvent.findMany();
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, eventId);
  assert.equal(events[0].eventType, "payment.captured");
  assert.equal(events[0].outcome, "APPLIED");
  assert.equal(events[0].paymentId, payment.id);
  assert.equal(events[0].providerOrderId, order.orderId);
  assert.equal(events[0].providerPaymentId, paymentId);

  assert.equal(
    await prisma.auditEvent.count({ where: { action: "payment.verified", targetId: payment.id } }),
    1,
  );
});

test("duplicate webhook deliveries are acknowledged without reprocessing", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({ student, request });
  const paymentId = "pay_duplicate_1";

  const rawBody = paymentWebhookBody({
    orderId: order.orderId,
    paymentId,
    amountMinor: request.amountMinor,
    currency: request.currency,
  });

  const first = await deliver(context, rawBody, { eventId: "evt_duplicate_1" });
  assert.equal(first.outcome, "APPLIED");

  const payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  const paidAt = payment.paidAt;

  const replay = await deliver(context, rawBody, { eventId: "evt_duplicate_1" });
  assert.equal(replay.httpStatus, 200);
  assert.equal(replay.outcome, "DUPLICATE");

  // The same effect re-delivered under a fresh event id is applied as a no-op.
  const renumbered = await deliver(context, rawBody, { eventId: "evt_duplicate_2" });
  assert.equal(renumbered.httpStatus, 200);
  assert.equal(renumbered.outcome, "NOOP");

  const rows = await prisma.payment.findMany({ where: { requestId: request.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paidAt.getTime(), paidAt.getTime(), "the original payment time stands");
  assert.equal(
    await prisma.auditEvent.count({ where: { action: "payment.verified", targetId: rows[0].id } }),
    1,
    "replayed effects never record a second success",
  );
});

test("webhook deliveries without an event id dedupe on the raw body hash", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({ student, request });

  const rawBody = paymentWebhookBody({
    orderId: order.orderId,
    paymentId: "pay_hash_1",
    amountMinor: request.amountMinor,
    currency: request.currency,
  });

  const first = await deliver(context, rawBody, { eventId: null });
  assert.equal(first.outcome, "APPLIED");

  const replay = await deliver(context, rawBody, { eventId: null });
  assert.equal(replay.httpStatus, 200);
  assert.equal(replay.outcome, "DUPLICATE");

  const events = await prisma.paymentWebhookEvent.findMany();
  assert.equal(events.length, 1);
  assert.ok(events[0].eventId.startsWith("body:"), "the fallback key is a body hash");
});

test("out-of-order failure and capture events resolve safely", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({ student, request });
  const paymentId = "pay_out_of_order_1";

  const failureBody = paymentWebhookBody({
    event: "payment.failed",
    orderId: order.orderId,
    paymentId,
    amountMinor: request.amountMinor,
    currency: request.currency,
    status: "failed",
    errorCode: "BAD_REQUEST_ERROR",
  });

  // A failure can arrive before a capture (e.g. a retried attempt).
  const failure = await deliver(context, failureBody, { eventId: "evt_failure_1" });
  assert.equal(failure.httpStatus, 200);
  assert.equal(failure.outcome, "FAILURE_RECORDED");

  let payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "FAILED");
  assert.equal(payment.failureCode, "BAD_REQUEST_ERROR");
  assert.ok(payment.failureAt instanceof Date);
  assert.equal(payment.activeKey, request.id, "the order stays active after a failure");

  let after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");

  const captureBody = paymentWebhookBody({
    orderId: order.orderId,
    paymentId,
    amountMinor: request.amountMinor,
    currency: request.currency,
  });

  const capture = await deliver(context, captureBody, { eventId: "evt_capture_1" });
  assert.equal(capture.outcome, "APPLIED");

  payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "PAID");
  assert.equal(payment.failureCode, null, "success clears the stale failure marker");
  assert.equal(payment.failureAt, null);
  assert.equal(payment.providerPaymentId, paymentId);

  after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "PAID");

  // A late failure event must never undo a verified success.
  const lateFailure = await deliver(context, failureBody, { eventId: "evt_failure_2" });
  assert.equal(lateFailure.httpStatus, 200);
  assert.equal(lateFailure.outcome, "NOOP");

  payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "PAID");
  after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "PAID");
});

test("webhook events for unknown orders or unsupported types are ignored", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({ student, request });

  const unknownOrder = await deliver(
    context,
    paymentWebhookBody({
      orderId: "order_unknown_1",
      paymentId: "pay_unknown_1",
      amountMinor: request.amountMinor,
      currency: request.currency,
    }),
    { eventId: "evt_unknown_order_1" },
  );
  assert.equal(unknownOrder.httpStatus, 200);
  assert.equal(unknownOrder.outcome, "IGNORED");

  const unsupported = await deliver(
    context,
    paymentWebhookBody({
      event: "payment.authorized",
      orderId: order.orderId,
      paymentId: "pay_authorized_event_1",
      amountMinor: request.amountMinor,
      currency: request.currency,
      status: "authorized",
    }),
    { eventId: "evt_unsupported_1" },
  );
  assert.equal(unsupported.httpStatus, 200);
  assert.equal(unsupported.outcome, "IGNORED");

  const events = await prisma.paymentWebhookEvent.findMany({ orderBy: { createdAt: "asc" } });
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => event.outcome),
    ["IGNORED", "IGNORED"],
  );

  const payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "CREATED");
  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");
});

test("a webhook amount mismatch never marks the request paid", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({ student, request });

  const rawBody = paymentWebhookBody({
    orderId: order.orderId,
    paymentId: "pay_webhook_mismatch_1",
    amountMinor: request.amountMinor + 1000,
    currency: request.currency,
  });

  const result = await deliver(context, rawBody, { eventId: "evt_mismatch_1" });
  assert.equal(result.httpStatus, 200, "a verified but inconsistent event is not retried");
  assert.equal(result.outcome, "MISMATCH");

  const payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "CREATED");
  assert.equal(payment.providerPaymentId, null);
  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");

  const event = await prisma.paymentWebhookEvent.findUniqueOrThrow({
    where: { eventId: "evt_mismatch_1" },
  });
  assert.equal(event.outcome, "MISMATCH");
  assert.ok((await prisma.auditEvent.count({ where: { action: "payment.mismatch" } })) > 0);
});

test("a provider payment id cannot be applied to two requests through webhooks", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const requestA = await createRequest(student, instructor);
  const requestB = await createRequest(student, instructor);

  await payRequest({ student, request: requestA, paymentId: "pay_shared_webhook_1" });

  const { order, context } = await openOrder({ student, request: requestB });
  const rawBody = paymentWebhookBody({
    orderId: order.orderId,
    paymentId: "pay_shared_webhook_1",
    amountMinor: requestB.amountMinor,
    currency: requestB.currency,
  });

  const result = await deliver(context, rawBody, { eventId: "evt_shared_payment_1" });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.outcome, "MISMATCH");

  const paymentB = await prisma.payment.findFirstOrThrow({ where: { requestId: requestB.id } });
  assert.equal(paymentB.status, "CREATED");
  assert.equal(paymentB.providerPaymentId, null);
  const afterB = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestB.id } });
  assert.equal(afterB.status, "AWAITING_PAYMENT");
});

test("order.paid without a payment entity applies and merges the later payment id", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order, context } = await openOrder({ student, request });

  const orderBody = orderWebhookBody({
    orderId: order.orderId,
    amountMinor: request.amountMinor,
    currency: request.currency,
  });

  const applied = await deliver(context, orderBody, { eventId: "evt_order_paid_1" });
  assert.equal(applied.httpStatus, 200);
  assert.equal(applied.outcome, "APPLIED");

  let payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "PAID");
  assert.equal(payment.providerPaymentId, null, "order.paid carries no payment id");
  const paidAt = payment.paidAt;

  const captureBody = paymentWebhookBody({
    orderId: order.orderId,
    paymentId: "pay_late_1",
    amountMinor: request.amountMinor,
    currency: request.currency,
  });
  const merged = await deliver(context, captureBody, { eventId: "evt_late_capture_1" });
  assert.equal(merged.httpStatus, 200);
  assert.equal(merged.outcome, "NOOP");

  payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "PAID");
  assert.equal(payment.providerPaymentId, "pay_late_1");
  assert.equal(payment.paidAt.getTime(), paidAt.getTime());
});

test("malformed signed webhook bodies are rejected", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { context } = await openOrder({ student, request });

  const notJson = await deliver(context, "not-json", { eventId: "evt_not_json_1" });
  assert.equal(notJson.httpStatus, 400);
  assert.equal(notJson.outcome, "REJECTED");

  const noEvent = await deliver(context, JSON.stringify({ entity: "event" }), {
    eventId: "evt_no_event_1",
  });
  assert.equal(noEvent.httpStatus, 400);
  assert.equal(noEvent.outcome, "REJECTED");

  assert.equal(await prisma.paymentWebhookEvent.count(), 0);
  assert.ok(
    (await prisma.auditEvent.count({ where: { action: "payment.webhook.rejected" } })) >= 2,
  );
});

test("webhooks require a configured webhook secret", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);
  const { order } = await openOrder({ student, request });

  const rawBody = paymentWebhookBody({
    orderId: order.orderId,
    paymentId: "pay_unconfigured_1",
    amountMinor: request.amountMinor,
    currency: request.currency,
  });
  const unconfigured = {
    config: { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: null },
    gateway: makeContext().context.gateway,
  };

  await rejectsWith(deliver(unconfigured, rawBody), ConfigurationError);

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "AWAITING_PAYMENT");
  assert.equal(await prisma.paymentWebhookEvent.count(), 0);
});

/* ------------------------------------------------------------------ */
/*  Summary visibility & lifecycle integration                         */
/* ------------------------------------------------------------------ */

test("the payment summary is visible only to the owning student and admin support", async () => {
  await reset();
  const student = await createStudent();
  const other = await createStudent();
  const instructor = await createInstructor();
  const admin = await createAdmin();
  const request = await createRequest(student, instructor);

  assert.equal(
    await getRequestPaymentSummary(studentActor(student), request.id),
    null,
    "no payment exists before checkout starts",
  );

  await payRequest({ student, request });

  const owner = await getRequestPaymentSummary(studentActor(student), request.id);
  assert.ok(owner);
  assert.equal(owner.status, "PAID");
  assert.equal(owner.provider, "RAZORPAY");
  assert.equal(owner.amountMinor, request.amountMinor);
  assert.equal(owner.currency, request.currency);
  assert.ok(owner.paidAt instanceof Date);
  assert.equal(owner.failureCode, null);

  assert.equal(await getRequestPaymentSummary(studentActor(other), request.id), null);
  assert.equal(await getRequestPaymentSummary(instructorActor(instructor.user), request.id), null);

  const support = await getRequestPaymentSummary(adminActor(admin), request.id);
  assert.equal(support?.status, "PAID");

  assert.equal(await getRequestPaymentSummary(studentActor(student), "missing-request"), null);
});

test("a verified payment changes only the intended request", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const requestA = await createRequest(student, instructor);
  const requestB = await createRequest(student, instructor);

  await payRequest({ student, request: requestA });

  const afterA = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestA.id } });
  const afterB = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: requestB.id } });
  assert.equal(afterA.status, "PAID");
  assert.equal(afterB.status, "AWAITING_PAYMENT");
  assert.equal(afterB.amountMinor, requestB.amountMinor, "the other snapshot is untouched");
  assert.equal(await prisma.payment.count({ where: { requestId: requestB.id } }), 0);
  assert.equal(await prisma.user.count(), 2, "accounts are never touched by payment");
});

test("only a verified payment opens the existing instructor decision workflow", async () => {
  await reset();
  const student = await createStudent();
  const instructor = await createInstructor();
  const request = await createRequest(student, instructor);

  await rejectsWith(
    acceptServiceRequest({ actor: instructorActor(instructor.user), requestId: request.id }),
    ConflictError,
  );

  await payRequest({ student, request });

  const accepted = await acceptServiceRequest({
    actor: instructorActor(instructor.user),
    requestId: request.id,
  });
  assert.equal(accepted.status, "ACCEPTED");

  const after = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
  assert.equal(after.status, "ACCEPTED");
  assert.ok(after.decisionAt instanceof Date);

  const payment = await prisma.payment.findFirstOrThrow({ where: { requestId: request.id } });
  assert.equal(payment.status, "PAID", "the decision never rewrites payment state");
});

/* ------------------------------------------------------------------ */
/*  Secret hygiene                                                     */
/* ------------------------------------------------------------------ */

test("no payment secret is referenced from client code", () => {
  const root = path.resolve(process.cwd(), "src");
  const files = [];

  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) files.push(full);
    }
  })(root);

  assert.ok(files.length > 0);

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      !source.includes("NEXT_PUBLIC_RAZORPAY_KEY_SECRET"),
      `${file} must never expose a Razorpay secret via a public env var`,
    );
    if (!/^\s*["']use client["']/m.test(source)) continue;
    for (const secret of [
      "RAZORPAY_KEY_SECRET",
      "RAZORPAY_SECRET",
      "RAZORPAY_WEBHOOK_SECRET",
      "keySecret",
      "webhookSecret",
    ]) {
      assert.ok(!source.includes(secret), `${file} is client code and must not reference ${secret}`);
    }
  }

  const panel = readFileSync(path.resolve(root, "components/PayNowPanel.tsx"), "utf8");
  assert.ok(panel.includes("/payment/verify"), "the client verifies through the server");
  assert.ok(!panel.includes("key_secret"), "the client never handles the key secret");
});


