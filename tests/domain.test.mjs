import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLES,
  isRole,
  isRoleAllowed,
  isDocumentStatus,
  isAnalysisJobStatus,
  canTransitionAnalysisStatus,
  isTerminalAnalysisStatus,
  isActiveAnalysisStatus,
  analysisActiveKey,
  isAnalysisErrorCategory,
  isRequestStatus,
  canTransitionRequestStatus,
  isPaymentStatus,
  canTransitionPaymentStatus,
  isTerminalPaymentStatus,
  PAYMENT_STATUSES,
  homePathForRole,
  APPLICATION_STATUSES,
  isApplicationStatus,
  canTransitionApplicationStatus,
  isTerminalApplicationStatus,
  canReapply,
} from "../src/lib/domain.ts";

// These are pure functions, so no database or Next.js runtime is required.

test("isRole accepts only known roles", () => {
  assert.equal(isRole("STUDENT"), true);
  assert.equal(isRole("INSTRUCTOR"), true);
  assert.equal(isRole("ADMIN"), true);
  assert.equal(isRole("SUPERUSER"), false);
  assert.equal(isRole(undefined), false);
  assert.equal(isRole(123), false);
});

test("isRoleAllowed enforces the allow-list (authorization decision)", () => {
  assert.equal(isRoleAllowed("STUDENT", ["STUDENT", "ADMIN"]), true);
  assert.equal(isRoleAllowed("ADMIN", ["STUDENT", "ADMIN"]), true);
  assert.equal(isRoleAllowed("STUDENT", ["INSTRUCTOR"]), false);
  assert.equal(isRoleAllowed("INSTRUCTOR", []), false);
});

test("role-aware default portal", () => {
  assert.equal(homePathForRole("STUDENT"), "/student");
  assert.equal(homePathForRole("INSTRUCTOR"), "/instructor");
  assert.equal(homePathForRole("ADMIN"), "/admin");
});

test("roles list is the single source of truth", () => {
  assert.deepEqual([...ROLES], ["STUDENT", "INSTRUCTOR", "ADMIN"]);
});

test("document status validation", () => {
  assert.equal(isDocumentStatus("AVAILABLE"), true);
  assert.equal(isDocumentStatus("DELETED"), true);
  assert.equal(isDocumentStatus("WIPED"), false);
});

test("analysis job status validation", () => {
  assert.equal(isAnalysisJobStatus("UNCONFIGURED"), true);
  assert.equal(isAnalysisJobStatus("QUEUED"), true);
  assert.equal(isAnalysisJobStatus("RETRYABLE"), true);
  assert.equal(isAnalysisJobStatus("COMPLETED"), true);
  assert.equal(isAnalysisJobStatus("RUNNING"), false);
});

test("request status validation", () => {
  assert.equal(isRequestStatus("DRAFT"), true);
  assert.equal(isRequestStatus("REFUNDED"), true);
  assert.equal(isRequestStatus("draft"), false);
});

test("request status transitions allow only the implemented student, payment and instructor moves", () => {
  // Student: submit a draft, or abandon it.
  assert.equal(canTransitionRequestStatus("DRAFT", "AWAITING_PAYMENT"), true);
  assert.equal(canTransitionRequestStatus("DRAFT", "CANCELLED"), true);
  assert.equal(canTransitionRequestStatus("DRAFT", "ACCEPTED"), false);
  // Payment: only verified payment evidence may move a request to PAID.
  assert.equal(canTransitionRequestStatus("AWAITING_PAYMENT", "PAID"), true);
  assert.equal(canTransitionRequestStatus("DRAFT", "PAID"), false);
  // Instructor: decisions apply to PAID requests only — payment comes first.
  assert.equal(canTransitionRequestStatus("AWAITING_PAYMENT", "ACCEPTED"), false);
  assert.equal(canTransitionRequestStatus("AWAITING_PAYMENT", "DECLINED"), false);
  assert.equal(canTransitionRequestStatus("PAID", "ACCEPTED"), true);
  assert.equal(canTransitionRequestStatus("PAID", "DECLINED"), true);
  // A paid request cannot change price or skip straight into fulfilment.
  assert.equal(canTransitionRequestStatus("PAID", "IN_PROGRESS"), false);
  // Decisions are terminal in this phase and cannot be rewritten.
  assert.equal(canTransitionRequestStatus("ACCEPTED", "DECLINED"), false);
  assert.equal(canTransitionRequestStatus("DECLINED", "ACCEPTED"), false);
  assert.equal(canTransitionRequestStatus("ACCEPTED", "IN_PROGRESS"), false);
  // Later phases still own delivery/completion transitions.
  assert.equal(canTransitionRequestStatus("IN_PROGRESS", "DELIVERED"), false);
  assert.equal(canTransitionRequestStatus("CANCELLED", "ACCEPTED"), false);
});

test("payment statuses follow the verified-payment lifecycle", () => {
  assert.deepEqual([...PAYMENT_STATUSES], ["CREATED", "FAILED", "PAID"]);
  assert.equal(isPaymentStatus("CREATED"), true);
  assert.equal(isPaymentStatus("PAID"), true);
  assert.equal(isPaymentStatus("AUTHORIZED"), false);
  assert.equal(isPaymentStatus(undefined), false);

  // An order starts CREATED and can only be settled by verified evidence.
  assert.equal(canTransitionPaymentStatus("CREATED", "PAID"), true);
  assert.equal(canTransitionPaymentStatus("CREATED", "FAILED"), true);
  assert.equal(canTransitionPaymentStatus("CREATED", "CREATED"), false);
  // A failed attempt may still succeed later on the same order.
  assert.equal(canTransitionPaymentStatus("FAILED", "PAID"), true);
  assert.equal(canTransitionPaymentStatus("FAILED", "CREATED"), false);
  // PAID is terminal: success can never be undone by a later event.
  assert.equal(canTransitionPaymentStatus("PAID", "FAILED"), false);
  assert.equal(canTransitionPaymentStatus("PAID", "CREATED"), false);
  assert.equal(isTerminalPaymentStatus("PAID"), true);
  assert.equal(isTerminalPaymentStatus("FAILED"), false);
  assert.equal(isTerminalPaymentStatus("CREATED"), false);
});

test("analysis status transitions reject invalid states", () => {
  // A job can only complete after it has actually started processing.
  assert.equal(canTransitionAnalysisStatus("UNCONFIGURED", "COMPLETED"), false);
  assert.equal(canTransitionAnalysisStatus("PENDING", "COMPLETED"), false);
  assert.equal(canTransitionAnalysisStatus("QUEUED", "COMPLETED"), true);
  assert.equal(canTransitionAnalysisStatus("PROCESSING", "COMPLETED"), true);
  // Unconfigured jobs may be queued or failed, but never silently completed.
  assert.equal(canTransitionAnalysisStatus("UNCONFIGURED", "PENDING"), true);
  assert.equal(canTransitionAnalysisStatus("UNCONFIGURED", "FAILED"), true);
  // Transient failures become retryable rather than terminal.
  assert.equal(canTransitionAnalysisStatus("PENDING", "RETRYABLE"), true);
  assert.equal(canTransitionAnalysisStatus("PROCESSING", "RETRYABLE"), true);
  assert.equal(canTransitionAnalysisStatus("RETRYABLE", "PENDING"), true);
  // COMPLETED and FAILED are terminal.
  assert.equal(canTransitionAnalysisStatus("COMPLETED", "PROCESSING"), false);
  assert.equal(canTransitionAnalysisStatus("COMPLETED", "FAILED"), false);
  assert.equal(canTransitionAnalysisStatus("FAILED", "PENDING"), false);
});

test("analysis status helpers distinguish active, retryable and terminal work", () => {
  assert.equal(isTerminalAnalysisStatus("COMPLETED"), true);
  assert.equal(isTerminalAnalysisStatus("FAILED"), true);
  assert.equal(isTerminalAnalysisStatus("RETRYABLE"), false);
  assert.equal(isActiveAnalysisStatus("PENDING"), true);
  assert.equal(isActiveAnalysisStatus("QUEUED"), true);
  assert.equal(isActiveAnalysisStatus("RETRYABLE"), true);
  assert.equal(isActiveAnalysisStatus("COMPLETED"), false);
  assert.equal(isActiveAnalysisStatus("UNCONFIGURED"), false);
  assert.equal(analysisActiveKey("doc-1", "SIMILARITY"), "doc-1:SIMILARITY");

  assert.equal(isAnalysisErrorCategory("TRANSIENT"), true);
  assert.equal(isAnalysisErrorCategory("RATE_LIMITED"), true);
  assert.equal(isAnalysisErrorCategory("INVALID_RESULT"), true);
  assert.equal(isAnalysisErrorCategory("SOMETHING_ELSE"), false);
});

test("application status validation uses the new lifecycle", () => {
  assert.deepEqual([...APPLICATION_STATUSES], ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"]);
  assert.equal(isApplicationStatus("PENDING"), true);
  assert.equal(isApplicationStatus("WITHDRAWN"), true);
  assert.equal(isApplicationStatus("PENDING_REVIEW"), false);
  assert.equal(isApplicationStatus("SUSPENDED"), false);
});

test("only a PENDING application can transition", () => {
  assert.equal(canTransitionApplicationStatus("PENDING", "APPROVED"), true);
  assert.equal(canTransitionApplicationStatus("PENDING", "REJECTED"), true);
  assert.equal(canTransitionApplicationStatus("PENDING", "WITHDRAWN"), true);
  // Terminal states cannot move anywhere.
  assert.equal(canTransitionApplicationStatus("APPROVED", "REJECTED"), false);
  assert.equal(canTransitionApplicationStatus("REJECTED", "APPROVED"), false);
  assert.equal(canTransitionApplicationStatus("WITHDRAWN", "PENDING"), false);
});

test("terminal application status detection", () => {
  assert.equal(isTerminalApplicationStatus("PENDING"), false);
  assert.equal(isTerminalApplicationStatus("APPROVED"), true);
  assert.equal(isTerminalApplicationStatus("REJECTED"), true);
  assert.equal(isTerminalApplicationStatus("WITHDRAWN"), true);
});

test("reapplication policy blocks open or approved applications", () => {
  assert.equal(canReapply(false, false), true);
  assert.equal(canReapply(false, true), false);
  assert.equal(canReapply(true, false), false);
  assert.equal(canReapply(true, true), false);
});
