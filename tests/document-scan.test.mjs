import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/db.ts";
import {
  DOCUMENT_SCAN_LEASE_MS,
  scanQuarantinedDocument,
} from "../src/lib/document-scan.ts";
import {
  canAccessDocument,
  isDocumentDownloadable,
} from "../src/lib/authorization.ts";

// Database-backed malware lifecycle tests. These use the real scanner service,
// the real test database and a mock transport; no ClamAV daemon is contacted.

const DEFAULT_BYTES = Buffer.from("%PDF-1.7\nscanner lifecycle fixture\n");

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
async function createUser(role = "STUDENT") {
  counter += 1;
  return prisma.user.create({
    data: {
      name: `Scan User ${counter}`,
      email: `scan-user-${counter}@test.local`,
      passwordHash: "hash",
      role,
    },
  });
}

async function createDocument({
  ownerId,
  bytes = DEFAULT_BYTES,
  status = "QUARANTINED",
  scanStatus = "UNSCANNED",
  checksum,
  sizeBytes,
  storageKey,
  scanStartedAt = null,
  scanAttempts = 0,
}) {
  counter += 1;
  return prisma.document.create({
    data: {
      ownerId,
      storageKey: storageKey ?? `scan-test/${counter}.pdf`,
      originalName: `scan-fixture-${counter}.pdf`,
      contentType: "application/pdf",
      sizeBytes: sizeBytes ?? bytes.length,
      checksumSha256:
        checksum === undefined
          ? createHash("sha256").update(bytes).digest("hex")
          : checksum,
      status,
      scanStatus,
      scanStartedAt,
      scanAttempts,
    },
  });
}

function makeStorage(bytes = DEFAULT_BYTES, options = {}) {
  let current = Buffer.from(bytes);
  const calls = [];
  return {
    calls,
    set(next) {
      current = Buffer.from(next);
    },
    async get(key) {
      calls.push(key);
      if (options.failGet) throw new Error("simulated storage failure");
      return Buffer.from(current);
    },
    async put() {
      throw new Error("not implemented in tests");
    },
    async getStream() {
      throw new Error("not implemented in tests");
    },
    async exists() {
      return !options.failGet;
    },
    async remove() {
      throw new Error("not implemented in tests");
    },
  };
}

function makeScanner(outcome, hooks = {}) {
  const calls = [];
  return {
    id: "test-clamav",
    configured: true,
    calls,
    async scan({ bytes }) {
      calls.push(Buffer.from(bytes));
      if (hooks.onScan) await hooks.onScan(bytes);
      if (typeof hooks.outcome === "function") return hooks.outcome(bytes);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

const CLEAN = { status: "CLEAN", engine: "test-clamav" };

async function scanTarget(document, scanner, storage, extra = {}) {
  return scanQuarantinedDocument({
    documentId: document.id,
    scanner,
    storage,
    actorId: document.ownerId,
    ...extra,
  });
}

test.after(async () => {
  await prisma.$disconnect();
});

test("CLEAN is persisted before the conditional release transition", async () => {
  await reset();
  const owner = await createUser();
  const document = await createDocument({ ownerId: owner.id });
  const storage = makeStorage();

  let releaseScan;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseScan = resolve;
  });
  const scanner = makeScanner(CLEAN, {
    async onScan() {
      markStarted();
      await gate;
    },
  });

  const pending = scanTarget(document, scanner, storage);
  await started;

  const during = await prisma.document.findUniqueOrThrow({
    where: { id: document.id },
  });
  assert.equal(during.status, "QUARANTINED", "not downloadable while scanning");
  assert.equal(during.scanStatus, "SCANNING");
  assert.equal(isDocumentDownloadable(during), false);

  releaseScan();
  const result = await pending;
  assert.deepEqual(result, {
    outcome: "CLEAN",
    documentId: document.id,
    released: true,
  });

  const after = await prisma.document.findUniqueOrThrow({
    where: { id: document.id },
  });
  assert.equal(after.status, "AVAILABLE");
  assert.equal(after.scanStatus, "CLEAN");
  assert.equal(after.scanEngine, "test-clamav");
  assert.equal(after.scanAttempts, 1);
  assert.ok(after.scannedAt instanceof Date);
  assert.equal(isDocumentDownloadable(after), true);

  const actions = await prisma.auditEvent.findMany({
    where: { targetId: document.id },
    select: { action: true },
  });
  const actionNames = actions.map((event) => event.action);
  assert.ok(actionNames.includes("document.scan.completed"));
  assert.ok(actionNames.includes("document.scan.released"));
});

test("infected content remains quarantined and is never retried automatically", async () => {
  await reset();
  const owner = await createUser();
  const document = await createDocument({ ownerId: owner.id });
  const scanner = makeScanner({
    status: "INFECTED",
    engine: "test-clamav",
    signature: "Eicar-Test-Signature",
  });

  const result = await scanTarget(document, scanner, makeStorage());
  assert.equal(result.outcome, "INFECTED");
  assert.equal(result.signature, "Eicar-Test-Signature");

  const after = await prisma.document.findUniqueOrThrow({
    where: { id: document.id },
  });
  assert.equal(after.status, "QUARANTINED");
  assert.equal(after.scanStatus, "INFECTED");
  assert.equal(after.scanSignature, "Eicar-Test-Signature");
  assert.equal(isDocumentDownloadable(after), false);

  const retry = await scanTarget(document, scanner, makeStorage());
  assert.equal(retry.outcome, "NOOP");
  assert.equal(retry.reason, "infected_terminal");

  const releases = await prisma.auditEvent.count({
    where: { targetId: document.id, action: "document.scan.released" },
  });
  assert.equal(releases, 0);
});

test("an unconfigured scanner never reads or releases the file", async () => {
  await reset();
  const owner = await createUser();
  const document = await createDocument({ ownerId: owner.id });
  const storage = makeStorage();
  const unconfigured = {
    id: "unconfigured",
    configured: false,
    unavailableReason: "not_configured",
    async scan() {
      throw new Error("unconfigured scanners must not be invoked");
    },
  };

  const result = await scanTarget(document, unconfigured, storage);
  assert.equal(result.outcome, "ERROR");
  assert.equal(result.reason, "not_configured");
  assert.equal(storage.calls.length, 0);

  const after = await prisma.document.findUniqueOrThrow({
    where: { id: document.id },
  });
  assert.equal(after.status, "QUARANTINED");
  assert.equal(after.scanStatus, "ERROR");
  assert.equal(after.scanReason, "not_configured");
  assert.equal(isDocumentDownloadable(after), false);
});

test("scanner timeouts, failures and malformed outcomes fail closed", async () => {
  for (const reason of [
    "timeout",
    "malformed_response",
    "scanner_error",
    "transport_error",
  ]) {
    await reset();
    const owner = await createUser();
    const document = await createDocument({ ownerId: owner.id });
    const scanner =
      reason === "transport_error"
        ? makeScanner(new Error("socket failed"))
        : makeScanner({ status: "ERROR", engine: "test-clamav", reason });

    const result = await scanTarget(document, scanner, makeStorage());
    assert.equal(result.outcome, "ERROR");
    assert.equal(result.reason, reason);

    const after = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
    });
    assert.equal(after.status, "QUARANTINED");
    assert.equal(after.scanStatus, "ERROR");
    assert.equal(isDocumentDownloadable(after), false);
  }
});

test("a checksum mismatch is detected before the scanner is called", async () => {
  await reset();
  const owner = await createUser();
  const document = await createDocument({
    ownerId: owner.id,
    checksum: "0".repeat(64),
  });
  const scanner = makeScanner(CLEAN);

  const result = await scanTarget(document, scanner, makeStorage());
  assert.equal(result.outcome, "ERROR");
  assert.equal(result.reason, "checksum_mismatch");
  assert.equal(scanner.calls.length, 0);

  const after = await prisma.document.findUniqueOrThrow({
    where: { id: document.id },
  });
  assert.equal(after.status, "QUARANTINED");
  assert.equal(after.scanStatus, "ERROR");
});

test("a file changed between scanning and release cannot inherit CLEAN", async () => {
  await reset();
  const owner = await createUser();
  const document = await createDocument({ ownerId: owner.id });
  const storage = makeStorage();
  const changed = Buffer.from(DEFAULT_BYTES);
  changed[0] = changed[0] === 0x41 ? 0x42 : 0x41;

  const scanner = makeScanner(CLEAN, {
    async onScan() {
      // Simulate the stored object changing after the scanner read it.
      storage.set(changed);
    },
  });

  const result = await scanTarget(document, scanner, storage);
  assert.equal(result.outcome, "ERROR");
  assert.equal(result.reason, "integrity_mismatch");

  const after = await prisma.document.findUniqueOrThrow({
    where: { id: document.id },
  });
  assert.equal(after.status, "QUARANTINED");
  assert.equal(after.scanStatus, "ERROR");
  assert.equal(after.scanReason, "integrity_mismatch");
  assert.equal(isDocumentDownloadable(after), false);

  const releases = await prisma.auditEvent.count({
    where: { targetId: document.id, action: "document.scan.released" },
  });
  assert.equal(releases, 0);
});

test("concurrent scan attempts cannot both claim or release a document", async () => {
  await reset();
  const owner = await createUser();
  const document = await createDocument({ ownerId: owner.id });

  let releaseScan;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseScan = resolve;
  });
  const scanner = makeScanner(CLEAN, {
    async onScan() {
      markStarted();
      await gate;
    },
  });
  const storage = makeStorage();

  const first = scanTarget(document, scanner, storage);
  await started;

  const second = await scanTarget(document, scanner, storage);
  assert.equal(second.outcome, "NOOP");
  assert.equal(second.reason, "in_progress");

  releaseScan();
  const firstResult = await first;
  assert.equal(firstResult.outcome, "CLEAN");
  assert.equal(firstResult.released, true);

  const after = await prisma.document.findUniqueOrThrow({
    where: { id: document.id },
  });
  assert.equal(after.status, "AVAILABLE");
  assert.equal(after.scanStatus, "CLEAN");
  assert.equal(after.scanAttempts, 1);
  assert.equal(scanner.calls.length, 1);

  const releases = await prisma.auditEvent.count({
    where: { targetId: document.id, action: "document.scan.released" },
  });
  assert.equal(releases, 1);
});

test("a stale SCANNING claim can be reclaimed but a fresh one cannot", async () => {
  await reset();
  const owner = await createUser();
  const stale = await createDocument({
    ownerId: owner.id,
    scanStatus: "SCANNING",
    scanStartedAt: new Date(Date.now() - DOCUMENT_SCAN_LEASE_MS - 60_000),
    scanAttempts: 1,
  });

  const result = await scanTarget(stale, makeScanner(CLEAN), makeStorage());
  assert.equal(result.outcome, "CLEAN");
  assert.equal(result.released, true);

  const after = await prisma.document.findUniqueOrThrow({
    where: { id: stale.id },
  });
  assert.equal(after.scanAttempts, 2);
  assert.equal(after.status, "AVAILABLE");
});

test("a persisted CLEAN result can complete release without rescanning", async () => {
  await reset();
  const owner = await createUser();
  const document = await createDocument({
    ownerId: owner.id,
    scanStatus: "CLEAN",
    scanAttempts: 1,
  });
  const scanner = makeScanner(new Error("scanner must not be called again"));

  const result = await scanTarget(document, scanner, makeStorage());
  assert.equal(result.outcome, "CLEAN");
  assert.equal(result.released, true);
  assert.equal(scanner.calls.length, 0);

  const after = await prisma.document.findUniqueOrThrow({
    where: { id: document.id },
  });
  assert.equal(after.status, "AVAILABLE");
  assert.equal(after.scanStatus, "CLEAN");
});

test("identity checks remain independent of scan status", async () => {
  await reset();
  const owner = await createUser();
  const stranger = await createUser();
  const document = await createDocument({
    ownerId: owner.id,
    status: "AVAILABLE",
    scanStatus: "CLEAN",
  });

  assert.equal(isDocumentDownloadable(document), true);
  assert.equal(
    canAccessDocument({ id: stranger.id, role: "STUDENT" }, document),
    false,
  );
});

test("wiring regression: upload quarantines first; download and analysis require CLEAN", async () => {
  const testsDir = path.dirname(fileURLToPath(import.meta.url));
  const read = (relative) => readFile(path.join(testsDir, relative), "utf8");

  const upload = await read("../src/app/api/documents/route.ts");
  assert.match(upload, /status: "QUARANTINED"/, "uploads start quarantined");
  assert.match(upload, /scanStatus: "UNSCANNED"/, "uploads start unscanned");
  const createAt = upload.indexOf("prisma.document.create");
  const scanAt = upload.indexOf("scanQuarantinedDocument(");
  assert.ok(createAt !== -1, "the upload route persists document metadata");
  assert.ok(
    scanAt > createAt,
    "the scan lifecycle must run only after the quarantined record exists",
  );
  assert.doesNotMatch(
    upload,
    /statusForScanResult/,
    "the upload route must not map a scan result into status directly",
  );

  const download = await read("../src/app/api/documents/[id]/download/route.ts");
  assert.match(
    download,
    /isDocumentDownloadable\(document\)/,
    "download must check the whole released-document shape",
  );
  assert.doesNotMatch(download, /isDocumentDownloadable\(document\.status\)/);

  const jobs = await read("../src/lib/analysis/jobs.ts");
  assert.match(
    jobs,
    /document\.scanStatus !== "CLEAN"/,
    "analysis initiation must require a clean scan",
  );
  assert.match(
    jobs,
    /job\.document\.scanStatus !== "CLEAN"/,
    "analysis processing must re-check the clean scan",
  );
});
