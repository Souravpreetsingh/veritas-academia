import test from "node:test";
import assert from "node:assert/strict";
import {
  canAccessDocument,
  canUploadToRequest,
  isDocumentDownloadable,
  isRequestOwner,
} from "../src/lib/authorization.ts";

// Pure authorization-decision tests.

const student = { id: "student-1", role: "STUDENT" };
const otherStudent = { id: "student-2", role: "STUDENT" };
const instructor = { id: "inst-1", role: "INSTRUCTOR" };
const admin = { id: "admin-1", role: "ADMIN" };

test("isRequestOwner compares the student id", () => {
  assert.equal(isRequestOwner("student-1", { studentId: "student-1" }), true);
  assert.equal(isRequestOwner("student-2", { studentId: "student-1" }), false);
});

test("canUploadToRequest allows the owner and admins only", () => {
  const request = { studentId: "student-1" };
  assert.equal(canUploadToRequest(student, request), true);
  assert.equal(canUploadToRequest(admin, request), true);
  assert.equal(canUploadToRequest(otherStudent, request), false);
  assert.equal(canUploadToRequest(instructor, request), false);
});

test("canAccessDocument allows the owner", () => {
  const doc = { ownerId: "student-1", request: null };
  assert.equal(canAccessDocument(student, doc), true);
});

test("canAccessDocument denies unrelated users (cross-user download)", () => {
  const doc = { ownerId: "student-1", request: null };
  assert.equal(canAccessDocument(otherStudent, doc), false);
  assert.equal(canAccessDocument(instructor, doc), false);
});

test("canAccessDocument allows the assigned instructor only", () => {
  const assigned = { ownerId: "student-1", request: { instructor: { userId: "inst-1" } } };
  const unassignedDoc = { ownerId: "student-1", request: { instructor: { userId: "inst-9" } } };
  assert.equal(canAccessDocument(instructor, assigned), true);
  assert.equal(canAccessDocument(instructor, unassignedDoc), false);
});

test("canAccessDocument allows admins for any document", () => {
  const doc = { ownerId: "student-1", request: null };
  assert.equal(canAccessDocument(admin, doc), true);
});

test("only AVAILABLE documents are downloadable (quarantine blocked)", () => {
  assert.equal(isDocumentDownloadable("AVAILABLE"), true);
  assert.equal(isDocumentDownloadable("QUARANTINED"), false);
  assert.equal(isDocumentDownloadable("DELETED"), false);
});
