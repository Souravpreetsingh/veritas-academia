import test from "node:test";
import assert from "node:assert/strict";
import {
  canUsePortal,
  isSafeRelativePath,
  resolveLoginScreenRedirect,
  resolvePostLoginPath,
} from "../src/lib/login-routing.ts";

// Pure post-login routing tests. This is a security boundary: a client-supplied
// return URL must never widen a role's access.

test("isSafeRelativePath accepts only same-origin relative paths", () => {
  assert.equal(isSafeRelativePath("/student"), true);
  assert.equal(isSafeRelativePath("/student/documents"), true);
  assert.equal(isSafeRelativePath("/instructor?tab=1"), true);

  assert.equal(isSafeRelativePath("https://evil.com"), false);
  assert.equal(isSafeRelativePath("http://evil.com/student"), false);
  assert.equal(isSafeRelativePath("//evil.com"), false);
  assert.equal(isSafeRelativePath("/\\evil.com"), false);
  assert.equal(isSafeRelativePath("/student\\..\\.."), false);
  assert.equal(isSafeRelativePath("student"), false);
  assert.equal(isSafeRelativePath(""), false);
  assert.equal(isSafeRelativePath(null), false);
  assert.equal(isSafeRelativePath(undefined), false);
  assert.equal(isSafeRelativePath(42), false);
});

test("students are confined to the student portal", () => {
  assert.equal(resolvePostLoginPath("STUDENT", "/student/documents"), "/student/documents");
  assert.equal(resolvePostLoginPath("STUDENT", "/instructor"), "/student");
  assert.equal(resolvePostLoginPath("STUDENT", "/instructor/earnings"), "/student");
  assert.equal(resolvePostLoginPath("STUDENT", "/admin"), "/student");
  assert.equal(resolvePostLoginPath("STUDENT", undefined), "/student");
});

test("instructors are confined to the instructor portal", () => {
  assert.equal(
    resolvePostLoginPath("INSTRUCTOR", "/instructor/incoming-requests"),
    "/instructor/incoming-requests",
  );
  assert.equal(resolvePostLoginPath("INSTRUCTOR", "/student"), "/instructor");
  assert.equal(resolvePostLoginPath("INSTRUCTOR", "/student/documents"), "/instructor");
  assert.equal(resolvePostLoginPath("INSTRUCTOR", undefined), "/instructor");
});

test("admins may reach both portals plus the admin area", () => {
  assert.equal(resolvePostLoginPath("ADMIN", "/admin/applications"), "/admin/applications");
  assert.equal(resolvePostLoginPath("ADMIN", "/instructor"), "/instructor");
  assert.equal(resolvePostLoginPath("ADMIN", "/student/documents"), "/student/documents");
  assert.equal(resolvePostLoginPath("ADMIN", undefined), "/admin");
});

test("open-redirect and role-escalation attempts fall back to the role dashboard", () => {
  assert.equal(resolvePostLoginPath("STUDENT", "//evil.com"), "/student");
  assert.equal(resolvePostLoginPath("STUDENT", "https://evil.com/student"), "/student");
  assert.equal(resolvePostLoginPath("STUDENT", "/instructor"), "/student");
  // A prefix that merely starts with an allowed segment must not match.
  assert.equal(resolvePostLoginPath("ADMIN", "/instructorx"), "/admin");
  assert.equal(resolvePostLoginPath("STUDENT", "/studentx"), "/student");
});

test("login and onboarding screens are never used as a post-login destination", () => {
  assert.equal(resolvePostLoginPath("STUDENT", "/student/login"), "/student");
  assert.equal(resolvePostLoginPath("INSTRUCTOR", "/login"), "/instructor");
  assert.equal(resolvePostLoginPath("INSTRUCTOR", "/instructor/register"), "/instructor");
  assert.equal(resolvePostLoginPath("STUDENT", "/register"), "/student");
  assert.equal(resolvePostLoginPath("ADMIN", "/instructor/application"), "/admin");
});

test("portal sign-in is role-matched; administrators may use either portal", () => {
  assert.equal(canUsePortal("student", "STUDENT"), true);
  assert.equal(canUsePortal("instructor", "INSTRUCTOR"), true);
  assert.equal(canUsePortal("student", "INSTRUCTOR"), false);
  assert.equal(canUsePortal("instructor", "STUDENT"), false);
  assert.equal(canUsePortal("student", "ADMIN"), true);
  assert.equal(canUsePortal("instructor", "ADMIN"), true);
});

test("a cross-role session never blocks the other portal's login form", () => {
  // A same-role session is sent straight to its dashboard.
  assert.equal(resolveLoginScreenRedirect("student", "STUDENT"), "/student");
  assert.equal(resolveLoginScreenRedirect("instructor", "INSTRUCTOR"), "/instructor");
  // A student session keeps the instructor sign-in form reachable, and vice versa.
  assert.equal(resolveLoginScreenRedirect("instructor", "STUDENT"), null);
  assert.equal(resolveLoginScreenRedirect("student", "INSTRUCTOR"), null);
  // Administrators may switch between portals for support.
  assert.equal(resolveLoginScreenRedirect("student", "ADMIN"), null);
  assert.equal(resolveLoginScreenRedirect("instructor", "ADMIN"), null);
});
