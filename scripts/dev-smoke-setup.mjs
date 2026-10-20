#!/usr/bin/env node
// LOCAL DEVELOPMENT ONLY — prepares a complete, fake scenario for exercising
// the document-analysis pipeline in the browser.
//
// WHAT IT SIMULATES (and why):
//   1. "Verified payment": the request is written as PAID. In production this
//      status is set ONLY from verified provider evidence (see
//      src/lib/payments.ts). There is no local Razorpay flow in this phase.
//   2. Nothing about malware scanning. The document is created QUARANTINED and
//      then submitted to the REAL scan lifecycle (src/lib/document-scan.ts).
//      With no scanner configured, it stays QUARANTINED and cannot be
//      downloaded or analysed — configure MALWARE_SCANNER=clamav with a
//      reachable clamd, then re-run this script to exercise the pipeline.
//
// Every other step uses the REAL application code paths: the upload validator,
// the private storage adapter (the file really is stored in ./private-storage
// with a real SHA-256 checksum), and — when you trigger them from the UI — the
// real authorization + consent + job pipeline.
//
// SAFETY GUARDS: refuses to run unless DATABASE_URL is a local SQLite file
// database, and refuses to run with NODE_ENV=production. It never touches an
// external service and never calls an LLM provider.
//
// USAGE (from the repo root):
//   node --env-file-if-exists=.env --env-file-if-exists=.env.local \
//     --import ./scripts/ts-resolve-hook.mjs scripts/dev-smoke-setup.mjs
//
// Each run creates a NEW request + document pair for the same two test users.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { prisma as lifecyclePrisma } from "../src/lib/db.ts";
import { getStorage, currentStorageDriver } from "../src/lib/storage/index.ts";
import { sanitizeFilename, validateUpload } from "../src/lib/storage/validation.ts";
import { hashPassword } from "../src/lib/password.ts";
import { generateReference } from "../src/lib/service-requests.ts";
import { extractDocumentText } from "../src/lib/analysis/extract-text.ts";
import { scanQuarantinedDocument } from "../src/lib/document-scan.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const STUDENT_EMAIL = "smoke.student@local.test";
const INSTRUCTOR_EMAIL = "smoke.instructor@local.test";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const FIXTURE = path.join(root, "local-test-fixtures", "synthetic-academic-essay.docx");

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const databaseUrl = process.env.DATABASE_URL ?? "";
if (process.env.NODE_ENV === "production") {
  console.error("[smoke-setup] Refusing to run with NODE_ENV=production.");
  process.exit(1);
}
if (!databaseUrl.startsWith("file:")) {
  console.error(
    "[smoke-setup] Refusing to run: DATABASE_URL is not a local SQLite file database.",
  );
  console.error(
    "[smoke-setup] This seeding utility must never run against a real database.",
  );
  process.exit(1);
}
if (!fs.existsSync(FIXTURE)) {
  console.error(`[smoke-setup] Fixture not found: ${FIXTURE}`);
  console.error("[smoke-setup] Run: node scripts/make-synthetic-fixture.mjs");
  process.exit(1);
}

const fixtureBytes = fs.readFileSync(FIXTURE);

// The real upload validator must accept the fixture before we store it.
const validation = validateUpload({
  originalName: path.basename(FIXTURE),
  declaredContentType: DOCX_MIME,
  buffer: fixtureBytes,
});
if (!validation.ok || !validation.contentType) {
  console.error(`[smoke-setup] Fixture failed upload validation: ${validation.error}`);
  process.exit(1);
}

// Fail early if the fixture cannot actually be extracted; the pipeline would
// otherwise fail later with a confusing job error.
const extracted = await extractDocumentText({
  contentType: validation.contentType,
  bytes: fixtureBytes,
});

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const password = randomBytes(9).toString("base64url");
const passwordHash = await hashPassword(password);

const student = await prisma.user.upsert({
  where: { email: STUDENT_EMAIL },
  update: {
    passwordHash,
    role: "STUDENT",
    suspended: false,
    name: "Smoke Test Student",
  },
  create: {
    email: STUDENT_EMAIL,
    passwordHash,
    role: "STUDENT",
    name: "Smoke Test Student",
  },
});

const instructorUser = await prisma.user.upsert({
  where: { email: INSTRUCTOR_EMAIL },
  update: {
    passwordHash,
    role: "INSTRUCTOR",
    suspended: false,
    name: "Smoke Test Instructor",
  },
  create: {
    email: INSTRUCTOR_EMAIL,
    passwordHash,
    role: "INSTRUCTOR",
    name: "Smoke Test Instructor",
  },
});

const profile = await prisma.instructorProfile.upsert({
  where: { userId: instructorUser.id },
  update: {
    isApproved: true,
    isActive: true,
    approvedAt: new Date(),
    headline: "Local smoke-test instructor (synthetic data only)",
  },
  create: {
    userId: instructorUser.id,
    isApproved: true,
    isActive: true,
    approvedAt: new Date(),
    headline: "Local smoke-test instructor (synthetic data only)",
  },
});

const service = await prisma.instructorService.upsert({
  where: { instructorId_code: { instructorId: profile.id, code: "SMOKE-REVIEW" } },
  update: {
    isActive: true,
    amountMinor: 49900,
    currency: "INR",
    turnaroundHours: 48,
  },
  create: {
    instructorId: profile.id,
    code: "SMOKE-REVIEW",
    name: "Local smoke-test review (synthetic)",
    description: "Fictional service used only to seed the local analysis smoke test.",
    amountMinor: 49900,
    currency: "INR",
    turnaroundHours: 48,
    isActive: true,
  },
});

// Create the request with a unique reference (retry on the unlikely collision).
let request = null;
for (let attempt = 0; attempt < 3 && !request; attempt += 1) {
  try {
    request = await prisma.serviceRequest.create({
      data: {
        reference: generateReference(new Date()),
        studentId: student.id,
        instructorId: profile.id,
        serviceId: service.id,
        title: "Synthetic smoke test — local analysis pipeline",
        instructions:
          "Fictional request created by scripts/dev-smoke-setup.mjs. No real work is involved.",
        status: "PAID", // SIMULATED verified payment — local-only (see header).
        amountMinor: service.amountMinor,
        currency: service.currency,
      },
    });
  } catch (error) {
    if (attempt === 2 || error?.code !== "P2002") throw error;
  }
}
if (!request) {
  console.error("[smoke-setup] Could not allocate a unique request reference.");
  process.exit(1);
}

// Store the fixture through the REAL storage adapter. The document starts
// QUARANTINED and is then submitted to the real scan lifecycle: nothing here
// can mark it AVAILABLE without a configured scanner returning CLEAN.
const stored = await getStorage().put({
  data: fixtureBytes,
  contentType: validation.contentType,
  originalName: path.basename(FIXTURE),
});

const document = await prisma.document.create({
  data: {
    ownerId: student.id,
    requestId: request.id,
    storageDriver: currentStorageDriver(),
    storageKey: stored.key,
    originalName: sanitizeFilename(path.basename(FIXTURE)),
    contentType: validation.contentType,
    sizeBytes: stored.sizeBytes,
    checksumSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
    status: "QUARANTINED",
    scanStatus: "UNSCANNED",
  },
});

const scanResult = await scanQuarantinedDocument({
  documentId: document.id,
  actorId: student.id,
});

const scannedDocument = await prisma.document.findUniqueOrThrow({
  where: { id: document.id },
  select: {
    id: true,
    originalName: true,
    sizeBytes: true,
    status: true,
    scanStatus: true,
    scanReason: true,
  },
});

await prisma.$disconnect();
await lifecyclePrisma.$disconnect();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

console.log("");
console.log("[smoke-setup] Local smoke-test scenario created. All data is synthetic.");
console.log(`[smoke-setup] Request reference: ${request.reference}`);
console.log(`[smoke-setup] Document: ${scannedDocument.originalName} (${extracted.text.length} extracted chars, ${scannedDocument.sizeBytes} bytes on disk)`);
console.log(`[smoke-setup] Scan: ${scannedDocument.status} / ${scannedDocument.scanStatus} (${scanResult.outcome}${scannedDocument.scanReason ? `: ${scannedDocument.scanReason}` : ""})`);
console.log("[smoke-setup]");
console.log("[smoke-setup] Throwaway login for BOTH accounts (local only — never reuse):");
console.log(`[smoke-setup]   password: ${password}`);
console.log(`[smoke-setup]   student:    ${STUDENT_EMAIL}`);
console.log(`[smoke-setup]   instructor: ${INSTRUCTOR_EMAIL}`);
console.log("[smoke-setup]");
if (scannedDocument.status === "AVAILABLE") {
  console.log("[smoke-setup] Next steps:");
  console.log(`[smoke-setup]   1. Student:    ${base}/student/requests/${request.reference} -> allow LLM-assisted review (consent panel).`);
  console.log(`[smoke-setup]   2. Instructor: ${base}/instructor/requests/${request.reference} -> "Local similarity" (no key needed) and "LLM review".`);
  console.log("[smoke-setup]   3. Process jobs:  npm run analysis:worker");
} else {
  console.log("[smoke-setup] The document was NOT released: it stays quarantined and cannot be downloaded or analysed.");
  console.log("[smoke-setup] Configure a real scanner (MALWARE_SCANNER=clamav, CLAMAV_HOST, CLAMAV_PORT) and re-run this");
  console.log("[smoke-setup] script to create a new request + document that the scan lifecycle can clear.");
}
console.log("[smoke-setup]");
console.log("[smoke-setup] Notes:");
console.log("[smoke-setup]   * Start/restart `npm run dev` so the app and worker see the current .env / .env.local.");
console.log("[smoke-setup]   * LLM review additionally needs LLM_PROVIDER + GEMINI_API_KEY + LLM_EXTERNAL_PROCESSING_ENABLED in .env.local.");
console.log("[smoke-setup]   * Local similarity is deterministic, offline, and needs no key.");
