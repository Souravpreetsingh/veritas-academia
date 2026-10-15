import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLES,
  isRole,
  isRoleAllowed,
  isDocumentStatus,
  isAnalysisJobStatus,
  canTransitionAnalysisStatus,
  isRequestStatus,
  homePathForRole,
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
  assert.equal(isAnalysisJobStatus("COMPLETED"), true);
  assert.equal(isAnalysisJobStatus("RUNNING"), false);
});

test("request status validation", () => {
  assert.equal(isRequestStatus("DRAFT"), true);
  assert.equal(isRequestStatus("REFUNDED"), true);
  assert.equal(isRequestStatus("draft"), false);
});

test("analysis status transitions reject invalid states", () => {
  // A job can only complete after it has actually started processing.
  assert.equal(canTransitionAnalysisStatus("UNCONFIGURED", "COMPLETED"), false);
  assert.equal(canTransitionAnalysisStatus("PENDING", "COMPLETED"), false);
  assert.equal(canTransitionAnalysisStatus("PROCESSING", "COMPLETED"), true);
  // Unconfigured jobs may be queued or failed, but never silently completed.
  assert.equal(canTransitionAnalysisStatus("UNCONFIGURED", "PENDING"), true);
  assert.equal(canTransitionAnalysisStatus("UNCONFIGURED", "FAILED"), true);
  // COMPLETED is terminal.
  assert.equal(canTransitionAnalysisStatus("COMPLETED", "PROCESSING"), false);
  assert.equal(canTransitionAnalysisStatus("COMPLETED", "FAILED"), false);
  // Failed jobs may be retried.
  assert.equal(canTransitionAnalysisStatus("FAILED", "PENDING"), true);
});
