import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db.ts";
import {
  parseDirectoryQuery,
  listInstructors,
  getPublicInstructorProfile,
  parseStringArray,
  summarizeServices,
  formatMoney,
  formatTurnaround,
} from "../src/lib/instructor-directory.ts";

// Database-backed tests for the public instructor directory + public profile
// read model. Runs against prisma/test.db, prepared by scripts/run-tests.mjs.
// Sequential execution (--test-concurrency=1) means this suite never races the
// other database-backed suites.

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

async function createInstructor({
  approved = true,
  active = true,
  suspended = false,
  name = null,
  headline = "Chair of Epistemic Logic",
  expertise = ["Formal Logic", "Citation Forensics"],
  qualifications = ["PhD Computational Mathematics"],
  bio = "A doctorate-holding supervisor with many theses reviewed.",
  services = [{ name: "Manuscript Audit", amountMinor: 8500, turnaroundHours: 24 }],
} = {}) {
  counter += 1;
  const fullName = name ?? `Instructor ${counter}`;
  const user = await prisma.user.create({
    data: {
      name: fullName,
      email: `instructor${counter}@test.local`,
      passwordHash: "hash",
      role: "INSTRUCTOR",
      suspended,
      instructorProfile: {
        create: {
          headline,
          bio,
          expertise: JSON.stringify(expertise),
          qualifications: JSON.stringify(qualifications),
          isApproved: approved,
          isActive: active,
          services: {
            create: services.map((service, index) => ({
              code: `SVC-${counter}-${index}`,
              name: service.name,
              description: service.description ?? "Published academic support service.",
              amountMinor: service.amountMinor,
              currency: service.currency ?? "INR",
              turnaroundHours: service.turnaroundHours,
              isActive: service.isActive ?? true,
            })),
          },
        },
      },
    },
    include: { instructorProfile: { include: { services: true } } },
  });
  return { user, profile: user.instructorProfile };
}

const baseQuery = (overrides = {}) => ({
  q: "",
  minPriceMinor: null,
  maxPriceMinor: null,
  page: 1,
  pageSize: 12,
  sort: "name_asc",
  ...overrides,
});

test.after(async () => {
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/*  Parameter validation                                               */
/* ------------------------------------------------------------------ */

test("parseDirectoryQuery accepts empty input and applies safe defaults", () => {
  const parsed = parseDirectoryQuery({});
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, {
    q: "",
    minPriceMinor: null,
    maxPriceMinor: null,
    page: 1,
    pageSize: 12,
    sort: "name_asc",
  });
});

test("parseDirectoryQuery rejects a non-numeric or zero page", () => {
  for (const page of ["abc", "0", "-3", "1.5"]) {
    const parsed = parseDirectoryQuery({ page });
    assert.equal(parsed.ok, false, `page=${page} should be rejected`);
    assert.ok(parsed.errors.some((e) => e.includes("Page")));
  }
});

test("parseDirectoryQuery rejects an out-of-range page size", () => {
  assert.equal(parseDirectoryQuery({ pageSize: "0" }).ok, false);
  assert.equal(parseDirectoryQuery({ pageSize: "999" }).ok, false);
  assert.equal(parseDirectoryQuery({ pageSize: "24" }).ok, true);
  assert.equal(parseDirectoryQuery({ pageSize: "1" }).ok, true);
});

test("parseDirectoryQuery rejects inverted or malformed price ranges", () => {
  assert.equal(parseDirectoryQuery({ minPrice: "500", maxPrice: "100" }).ok, false);
  assert.equal(parseDirectoryQuery({ minPrice: "-1" }).ok, false);
  assert.equal(parseDirectoryQuery({ minPrice: "abc" }).ok, false);
  assert.equal(parseDirectoryQuery({ minPrice: "10.5" }).ok, false);
  assert.equal(parseDirectoryQuery({ minPrice: "100", maxPrice: "500" }).ok, true);
});

test("parseDirectoryQuery rejects an unknown sort option and an oversized search", () => {
  assert.equal(parseDirectoryQuery({ sort: "price" }).ok, false);
  assert.equal(parseDirectoryQuery({ sort: "name_asc" }).ok, true);
  assert.equal(parseDirectoryQuery({ q: "x".repeat(81) }).ok, false);
});

test("parseDirectoryQuery strips control characters from the search term", () => {
  const dirty = ["ab", "cd", "ef"].join(String.fromCharCode(7));
  const parsed = parseDirectoryQuery({ q: dirty });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.q, "abcdef");
});

/* ------------------------------------------------------------------ */
/*  Directory visibility                                               */
/* ------------------------------------------------------------------ */

test("only approved, active, unsuspended instructors with a live service appear", async () => {
  await reset();
  await createInstructor({ name: "Visible Instructor" });
  await createInstructor({ approved: false, name: "Pending Instructor" });
  await createInstructor({ approved: false, services: [], name: "Never Approved" });
  await createInstructor({ active: false, name: "Inactive Instructor" });
  await createInstructor({ suspended: true, name: "Suspended Instructor" });

  const result = await listInstructors(baseQuery());
  assert.equal(result.total, 1);
  assert.equal(result.instructors.length, 1);
  assert.equal(result.instructors[0].name, "Visible Instructor");
});

test("an approved instructor with no published service is excluded", async () => {
  await reset();
  await createInstructor({ services: [], name: "No Services" });
  await createInstructor({
    services: [{ name: "S", amountMinor: 1, turnaroundHours: 1, isActive: false }],
    name: "OnlyUnpublished",
  });
  const result = await listInstructors(baseQuery());
  assert.equal(result.total, 0);
  assert.equal(result.instructors.length, 0);
});

test("an ineligible user whose profile is somehow approved still cannot appear", async () => {
  await reset();
  const { user } = await createInstructor({ name: "Edge Case" });
  await prisma.user.update({ where: { id: user.id }, data: { role: "STUDENT" } });
  const result = await listInstructors(baseQuery());
  assert.equal(result.total, 0);
});

test("published-only services are listed and unpublished ones are not", async () => {
  await reset();
  await createInstructor({
    name: "Mixed Services",
    services: [
      { name: "Live Service", amountMinor: 100, turnaroundHours: 2 },
      { name: "Hidden Service", amountMinor: 200, turnaroundHours: 4, isActive: false },
    ],
  });
  const result = await listInstructors(baseQuery());
  const instructor = result.instructors[0];
  assert.equal(instructor.serviceCount, 1);
  assert.deepEqual(
    instructor.services.map((s) => s.name),
    ["Live Service"],
  );
});

/* ------------------------------------------------------------------ */
/*  Search + filters                                                   */
/* ------------------------------------------------------------------ */

test("search matches name, expertise, headline and service name", async () => {
  await reset();
  await createInstructor({
    name: "Marcus Vance",
    expertise: ["Epistemology"],
    headline: "Logic Chair",
    services: [{ name: "Proof Audit", amountMinor: 100, turnaroundHours: 1 }],
  });
  await createInstructor({
    name: "Sarah Chen",
    expertise: ["Cognition"],
    headline: "Systems Lead",
    services: [{ name: "Data Review", amountMinor: 200, turnaroundHours: 2 }],
  });

  assert.equal((await listInstructors(baseQuery({ q: "Marcus" }))).total, 1);
  assert.equal((await listInstructors(baseQuery({ q: "Epistemology" }))).total, 1);
  assert.equal((await listInstructors(baseQuery({ q: "Logic Chair" }))).total, 1);
  assert.equal((await listInstructors(baseQuery({ q: "Proof Audit" }))).total, 1);
  assert.equal((await listInstructors(baseQuery({ q: "Sarah" }))).total, 1);
  assert.equal((await listInstructors(baseQuery({ q: "nonexistent" }))).total, 0);
});

test("price range filters include only instructors with a service in range", async () => {
  await reset();
  await createInstructor({
    name: "Cheap",
    services: [{ name: "Basic", amountMinor: 5000, turnaroundHours: 48 }],
  });
  await createInstructor({
    name: "Mid",
    services: [{ name: "Standard", amountMinor: 50000, turnaroundHours: 24 }],
  });
  await createInstructor({
    name: "Premium",
    services: [{ name: "Advanced", amountMinor: 200000, turnaroundHours: 12 }],
  });

  const midOnly = await listInstructors(baseQuery({ minPriceMinor: 40000, maxPriceMinor: 60000 }));
  assert.equal(midOnly.total, 1);
  assert.equal(midOnly.instructors[0].name, "Mid");

  const affordable = await listInstructors(baseQuery({ maxPriceMinor: 50000 }));
  assert.deepEqual(
    affordable.instructors.map((i) => i.name).sort(),
    ["Cheap", "Mid"],
  );
});

test("every listed row is available, has a service, and leaks no email", async () => {
  await reset();
  await createInstructor({ name: "Legit" });
  const result = await listInstructors(baseQuery());
  for (const row of result.instructors) {
    assert.ok(row.available, "every listed instructor must be available");
    assert.ok(row.serviceCount >= 1, "every listed instructor must have a service");
    assert.ok(!("email" in row), "no email in the public DTO");
  }
});

/* ------------------------------------------------------------------ */
/*  Pagination                                                         */
/* ------------------------------------------------------------------ */

test("pagination windows the result set and reports totals", async () => {
  await reset();
  for (let i = 1; i <= 5; i += 1) {
    await createInstructor({
      name: `Paged Instructor ${String(i).padStart(2, "0")}`,
      services: [{ name: "Service", amountMinor: 100, turnaroundHours: 1 }],
    });
  }

  const page1 = await listInstructors(baseQuery({ pageSize: 2, page: 1 }));
  assert.equal(page1.total, 5);
  assert.equal(page1.totalPages, 3);
  assert.equal(page1.instructors.length, 2);
  assert.deepEqual(
    page1.instructors.map((i) => i.name),
    ["Paged Instructor 01", "Paged Instructor 02"],
  );

  const page3 = await listInstructors(baseQuery({ pageSize: 2, page: 3 }));
  assert.equal(page3.instructors.length, 1);
  assert.equal(page3.instructors[0].name, "Paged Instructor 05");

  const page4 = await listInstructors(baseQuery({ pageSize: 2, page: 4 }));
  assert.equal(page4.instructors.length, 0);
  assert.equal(page4.total, 5);
});

test("sort options order the directory predictably", async () => {
  await reset();
  await createInstructor({ name: "Charlie", services: [{ name: "S", amountMinor: 100, turnaroundHours: 1 }] });
  await createInstructor({ name: "Alpha", services: [{ name: "S", amountMinor: 100, turnaroundHours: 1 }] });
  await createInstructor({ name: "Bravo", services: [{ name: "S", amountMinor: 100, turnaroundHours: 1 }] });

  const asc = await listInstructors(baseQuery({ sort: "name_asc" }));
  assert.deepEqual(asc.instructors.map((i) => i.name), ["Alpha", "Bravo", "Charlie"]);

  const desc = await listInstructors(baseQuery({ sort: "name_desc" }));
  assert.deepEqual(desc.instructors.map((i) => i.name), ["Charlie", "Bravo", "Alpha"]);
});

/* ------------------------------------------------------------------ */
/*  Public profile                                                     */
/* ------------------------------------------------------------------ */

test("getPublicInstructorProfile returns only whitelisted public fields", async () => {
  await reset();
  const { profile } = await createInstructor({ name: "Public Author" });

  const result = await getPublicInstructorProfile(profile.id);
  assert.ok(result);
  assert.equal(result.name, "Public Author");
  assert.ok(Array.isArray(result.expertise));
  assert.ok(Array.isArray(result.qualifications));
  assert.ok(result.services.length >= 1);

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("email"), "profile must not expose email");
  assert.ok(!serialized.includes("passwordHash"), "profile must not expose password hash");
  assert.ok(!serialized.includes("suspended"), "profile must not expose suspension state");
  assert.ok(!serialized.includes("@test.local"), "no email domain in the DTO");
});

test("getPublicInstructorProfile returns null for missing, suspended or unapproved ids", async () => {
  await reset();
  const { profile: approved } = await createInstructor({ name: "Approved" });
  const { profile: pending } = await createInstructor({ approved: false, name: "Pending" });
  const { profile: inactive } = await createInstructor({ active: false, name: "Inactive" });
  const { user: suspendedUser } = await createInstructor({ name: "Suspended" });
  await prisma.user.update({ where: { id: suspendedUser.id }, data: { suspended: true } });
  const { profile: noServices } = await createInstructor({ services: [], name: "NoSvc" });

  assert.ok(await getPublicInstructorProfile(approved.id));
  assert.equal(await getPublicInstructorProfile(pending.id), null);
  assert.equal(await getPublicInstructorProfile(inactive.id), null);
  assert.equal(await getPublicInstructorProfile(suspendedUser.instructorProfile.id), null);
  assert.equal(await getPublicInstructorProfile(noServices.id), null);
  assert.equal(await getPublicInstructorProfile("does-not-exist"), null);
  assert.equal(await getPublicInstructorProfile(""), null);
  assert.equal(await getPublicInstructorProfile(null), null);
  assert.equal(await getPublicInstructorProfile(42), null);
  assert.equal(await getPublicInstructorProfile("x".repeat(200)), null);
});

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                       */
/* ------------------------------------------------------------------ */

test("parseStringArray decodes, filters and never throws on bad input", () => {
  assert.deepEqual(parseStringArray(JSON.stringify(["A", "B"])), ["A", "B"]);
  assert.deepEqual(parseStringArray(JSON.stringify(["A", "", "  ", 1, null])), ["A"]);
  assert.deepEqual(parseStringArray("not json"), []);
  assert.deepEqual(parseStringArray(""), []);
  assert.deepEqual(parseStringArray(null), []);
  assert.deepEqual(parseStringArray('{"a":1}'), []);
});

test("summarizeServices derives starting price, currency and fastest turnaround", () => {
  const summary = summarizeServices([
    { id: "1", code: "A", name: "A", description: null, amountMinor: 9000, currency: "INR", turnaroundHours: 48 },
    { id: "2", code: "B", name: "B", description: null, amountMinor: 4990, currency: "USD", turnaroundHours: 12 },
    { id: "3", code: "C", name: "C", description: null, amountMinor: 6500, currency: "INR", turnaroundHours: 1 },
  ]);
  assert.equal(summary.startingPriceMinor, 4990);
  assert.equal(summary.currency, "USD");
  assert.equal(summary.fastestTurnaroundHours, 1);
  assert.equal(summary.serviceCount, 3);

  const empty = summarizeServices([]);
  assert.equal(empty.startingPriceMinor, null);
  assert.equal(empty.fastestTurnaroundHours, null);
  assert.equal(empty.serviceCount, 0);
});

test("formatMoney renders minor units with the right symbol and decimals", () => {
  assert.equal(formatMoney(8500, "INR"), "₹85");
  assert.equal(formatMoney(49900, "INR"), "₹499");
  assert.equal(formatMoney(6500, "USD"), "$65");
  assert.equal(formatMoney(4995, "INR"), "₹49.95");
  assert.equal(formatMoney(1234, "XYZ"), "XYZ 12.34");
});

test("formatTurnaround produces a human label from real hours", () => {
  assert.equal(formatTurnaround(1), "Within 1 hour");
  assert.equal(formatTurnaround(0.5), "Within 1 hour");
  assert.equal(formatTurnaround(24), "Within 24 hours");
  assert.equal(formatTurnaround(2), "Within 2 hours");
});
