import test from "node:test";
import assert from "node:assert/strict";
import {
  canAccessDocument,
  canUploadToRequest,
  isDocumentDownloadable,
  isRequestOwner,
  canReviewApplications,
  canSubmitInstructorApplication,
  canViewApplication,
  canWithdrawApplication,
  canCreateServiceRequest,
  canViewServiceRequest,
  canSubmitServiceRequest,
  canPayServiceRequest,
  canViewInstructorRequest,
  canDecideInstructorRequest,
  instructorPortalAccess,
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

test("only released, clean-scanned documents are downloadable", () => {
  assert.equal(
    isDocumentDownloadable({ status: "AVAILABLE", scanStatus: "CLEAN" }),
    true,
  );
  assert.equal(
    isDocumentDownloadable({ status: "QUARANTINED", scanStatus: "CLEAN" }),
    false,
  );
  assert.equal(
    isDocumentDownloadable({ status: "AVAILABLE", scanStatus: "UNSCANNED" }),
    false,
  );
  assert.equal(
    isDocumentDownloadable({ status: "AVAILABLE", scanStatus: "INFECTED" }),
    false,
  );
  assert.equal(
    isDocumentDownloadable({ status: "AVAILABLE", scanStatus: "ERROR" }),
    false,
  );
  assert.equal(
    isDocumentDownloadable({ status: "DELETED", scanStatus: "CLEAN" }),
    false,
  );
});

test("only admins may review applications", () => {
  assert.equal(canReviewApplications(admin), true);
  assert.equal(canReviewApplications(student), false);
  assert.equal(canReviewApplications(instructor), false);
});

test("only students may submit an instructor application", () => {
  assert.equal(canSubmitInstructorApplication(student), true);
  assert.equal(canSubmitInstructorApplication(instructor), false);
  assert.equal(canSubmitInstructorApplication(admin), false);
});

test("application visibility: owner or admin only", () => {
  const application = { userId: "student-1" };
  assert.equal(canViewApplication(student, application), true);
  assert.equal(canViewApplication(admin, application), true);
  assert.equal(canViewApplication(otherStudent, application), false);
  assert.equal(canViewApplication(instructor, application), false);
});

test("only the owner may withdraw their application", () => {
  const application = { userId: "student-1" };
  assert.equal(canWithdrawApplication(student, application), true);
  assert.equal(canWithdrawApplication(otherStudent, application), false);
  assert.equal(canWithdrawApplication(admin, application), false);
});

test("service-request creation and student visibility rules", () => {
  assert.equal(canCreateServiceRequest(student), true);
  assert.equal(canCreateServiceRequest(instructor), false);
  assert.equal(canCreateServiceRequest(admin), false);

  const request = { studentId: "student-1" };
  assert.equal(canViewServiceRequest(student, request), true);
  assert.equal(canViewServiceRequest(otherStudent, request), false);
  assert.equal(canViewServiceRequest(instructor, request), false);
  assert.equal(canViewServiceRequest(admin, request), true, "admin support access");

  assert.equal(canSubmitServiceRequest(student, request), true);
  assert.equal(canSubmitServiceRequest(otherStudent, request), false);
  assert.equal(canSubmitServiceRequest(admin, request), false);
});

test("only the owning student may pay for a request", () => {
  const request = { studentId: "student-1" };

  assert.equal(canPayServiceRequest(student, request), true);
  assert.equal(canPayServiceRequest(otherStudent, request), false);
  assert.equal(canPayServiceRequest(instructor, request), false);
  assert.equal(canPayServiceRequest(admin, request), false, "admins never initiate payments");
});

test("instructor request visibility: the assigned instructor or an admin only", () => {
  const assigned = { instructor: { userId: "inst-1" } };
  const unassigned = { instructor: { userId: "inst-9" } };

  assert.equal(canViewInstructorRequest(instructor, assigned), true);
  assert.equal(canViewInstructorRequest(instructor, unassigned), false);
  assert.equal(canViewInstructorRequest(admin, unassigned), true, "admin support access");
  assert.equal(canViewInstructorRequest(student, assigned), false);
  assert.equal(canViewInstructorRequest(otherStudent, assigned), false);
});

test("only the assigned instructor may decide; admin support is read-only", () => {
  const assigned = { instructor: { userId: "inst-1" } };
  const unassigned = { instructor: { userId: "inst-9" } };

  assert.equal(canDecideInstructorRequest(instructor, assigned), true);
  assert.equal(canDecideInstructorRequest(instructor, unassigned), false);
  assert.equal(canDecideInstructorRequest(admin, assigned), false, "admins never decide");
  assert.equal(canDecideInstructorRequest(student, assigned), false);
  assert.equal(canDecideInstructorRequest(otherStudent, assigned), false);
});

test("instructor portal access is role-gated; applicants go to their status screen", () => {
  // Only verified instructors and administrators may enter the protected portal.
  assert.equal(instructorPortalAccess("INSTRUCTOR", false), "allow");
  assert.equal(instructorPortalAccess("ADMIN", false), "allow");
  // A pending applicant (still STUDENT) is sent to the application-status screen.
  assert.equal(instructorPortalAccess("STUDENT", true), "application-status");
  // A student without an application has no business in the instructor portal.
  assert.equal(instructorPortalAccess("STUDENT", false), "deny");
});
