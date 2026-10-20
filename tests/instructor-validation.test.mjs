import test from "node:test";
import assert from "node:assert/strict";
import {
  validateInstructorApplicationInput,
  toStringList,
} from "../src/lib/instructor-applications.ts";
import { validateServiceInput } from "../src/lib/instructor-services.ts";
import {
  evaluateInstructorEligibility,
  isEligibleInstructor,
  canPublishService,
  canAppearInCatalog,
  canAcceptRequests,
} from "../src/lib/instructor-eligibility.ts";

// Pure input-validation and eligibility tests. These import server modules only
// for their pure exports; no database connection is established at import time.

const validApplication = {
  fullName: "Dr. Ada Lovelace",
  email: "  Ada@Example.COM ",
  phone: "+91 90000 00000",
  bio: "I hold a doctorate in computational mathematics and have supervised dozens of theses.",
  expertise: "Statistics, Research Methods, Data Analysis",
  qualifications: ["PhD Computational Mathematics", "MSc Statistics"],
  termsAccepted: true,
};

test("a well-formed application normalizes email and de-duplicates lists", () => {
  const result = validateInstructorApplicationInput(validApplication);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.email, "ada@example.com");
  assert.deepEqual(result.value.expertise, ["Statistics", "Research Methods", "Data Analysis"]);
  assert.deepEqual(result.value.qualifications, [
    "PhD Computational Mathematics",
    "MSc Statistics",
  ]);
  assert.equal(result.value.proposedServices.length, 0);
});

test("application validation rejects a missing terms acceptance and short bio", () => {
  const result = validateInstructorApplicationInput({
    ...validApplication,
    termsAccepted: false,
    bio: "too short",
    fullName: "",
    email: "not-an-email",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.fields.termsAccepted);
  assert.ok(result.fields.bio);
  assert.ok(result.fields.fullName);
  assert.ok(result.fields.email);
  assert.ok(result.fields.expertise === undefined || typeof result.fields.expertise === "string");
});

test("application validation requires at least one expertise and qualification", () => {
  const result = validateInstructorApplicationInput({
    ...validApplication,
    expertise: "",
    qualifications: [],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.fields.expertise);
  assert.ok(result.fields.qualifications);
});

test("valid proposed services are normalized and invalid ones rejected", () => {
  const good = validateInstructorApplicationInput({
    ...validApplication,
    proposedServices: [
      { name: "Similarity Report", amountMinor: 49900, turnaroundHours: 24, description: "Full report" },
    ],
  });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.value.proposedServices.length, 1);
    assert.equal(good.value.proposedServices[0].amountMinor, 49900);
  }

  const bad = validateInstructorApplicationInput({
    ...validApplication,
    proposedServices: [{ name: "X", amountMinor: -5, turnaroundHours: 0 }],
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.fields.proposedServices);
});

test("toStringList trims, splits and de-duplicates case-insensitively", () => {
  assert.deepEqual(toStringList("a, B , a,  b "), ["a", "B"]);
  assert.deepEqual(toStringList(["one", "one", "two"]), ["one", "two"]);
  assert.deepEqual(toStringList(undefined), []);
  assert.deepEqual(toStringList(""), []);
});

test("service validation normalizes the code and currency", () => {
  const result = validateServiceInput({
    code: " similarity report ",
    name: "Similarity Report",
    amountMinor: 49900,
    currency: "inr",
    turnaroundHours: 24,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.code, "SIMILARITY_REPORT");
  assert.equal(result.value.currency, "INR");
});

test("service validation rejects bad code, price and turnaround", () => {
  const result = validateServiceInput({
    code: "!!",
    name: "",
    amountMinor: -1,
    currency: "rupees",
    turnaroundHours: 0,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.fields.code);
  assert.ok(result.fields.name);
  assert.ok(result.fields.amountMinor);
  assert.ok(result.fields.currency);
  assert.ok(result.fields.turnaroundHours);
});

// --- eligibility -------------------------------------------------------------

const approved = { isApproved: true, isActive: true };

test("an approved, active, unsuspended instructor is eligible", () => {
  const input = { role: "INSTRUCTOR", suspended: false, profile: approved };
  assert.equal(isEligibleInstructor(input), true);
  assert.equal(canPublishService(input), true);
  assert.equal(canAppearInCatalog(input), true);
  assert.equal(canAcceptRequests(input), true);
});

test("eligibility requires the instructor role, an approved profile and an active account", () => {
  assert.equal(isEligibleInstructor({ role: "STUDENT", suspended: false, profile: approved }), false);
  assert.equal(
    isEligibleInstructor({ role: "INSTRUCTOR", suspended: false, profile: { isApproved: false, isActive: true } }),
    false,
  );
  assert.equal(
    isEligibleInstructor({ role: "INSTRUCTOR", suspended: false, profile: { isApproved: true, isActive: false } }),
    false,
  );
  assert.equal(isEligibleInstructor({ role: "INSTRUCTOR", suspended: true, profile: approved }), false);
  assert.equal(isEligibleInstructor({ role: "INSTRUCTOR", suspended: false, profile: null }), false);
});

test("eligibility reports the specific reasons for denial", () => {
  const result = evaluateInstructorEligibility({
    role: "STUDENT",
    suspended: true,
    profile: null,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reasons.length, 3);
});
