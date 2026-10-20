// Document scan lifecycle: claim -> read exact stored bytes -> verify integrity
// -> scan -> persist the outcome -> (only for CLEAN) verify again and release.
//
// Security invariants:
//   * uploads are persisted QUARANTINED before any scan is attempted;
//   * a scan claim is a conditional DB update, so concurrent scans cannot race;
//   * the scanner reads bytes through the private StorageAdapter, never the
//     request body or client metadata;
//   * the bytes must match the persisted size and SHA-256 checksum;
//   * CLEAN is persisted before release, and release is a second conditional
//     update bound to document id, scan state, checksum and storage key;
//   * storage is re-read immediately before release, so a file changed after
//     scanning cannot inherit the stale CLEAN result;
//   * every failure (missing scanner, timeout, malformed response, bad
//     integrity) leaves the document QUARANTINED.

import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import {
  currentStorageDriver,
  getStorage,
  MAX_UPLOAD_BYTES,
  type StorageAdapter,
} from "@/lib/storage/index";
import {
  getMalwareScanner,
  sanitizeScanSignature,
  scanDocument,
  type MalwareScanErrorReason,
  type MalwareScanner,
} from "@/lib/security/malware";
import { recordAuditEvent } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/domain";

/** A crashed scan may be reclaimed after this lease; normal scans time out far sooner. */
export const DOCUMENT_SCAN_LEASE_MS = 10 * 60_000;

export type DocumentScanFailureReason =
  | MalwareScanErrorReason
  | "storage_error"
  | "storage_driver_unavailable"
  | "checksum_missing"
  | "size_mismatch"
  | "checksum_mismatch"
  | "integrity_mismatch"
  | "release_conflict"
  | "state_changed";

export type DocumentScanNoopReason =
  | "not_found"
  | "not_quarantined"
  | "already_available"
  | "in_progress"
  | "infected_terminal"
  | "state_changed";

export type DocumentScanResult =
  | { outcome: "CLEAN"; documentId: string; released: boolean }
  | { outcome: "INFECTED"; documentId: string; signature: string }
  | { outcome: "ERROR"; documentId: string; reason: DocumentScanFailureReason }
  | { outcome: "NOOP"; documentId: string; reason: DocumentScanNoopReason };

export interface ScanQuarantinedDocumentOptions {
  documentId: string;
  /** Injectable for tests; defaults to the environment-configured adapter. */
  scanner?: MalwareScanner;
  /** Injectable for tests; defaults to the configured private StorageAdapter. */
  storage?: StorageAdapter;
  now?: Date;
  /** Acting user for audit attribution (the uploader when called from upload). */
  actorId?: string | null;
  request?: Request;
}

interface ScanTarget {
  id: string;
  ownerId: string;
  status: string;
  scanStatus: string;
  scanEngine: string | null;
  scanSignature: string | null;
  scanAttempts: number;
  storageDriver: string;
  storageKey: string;
  sizeBytes: number;
  checksumSha256: string | null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function audit(
  options: ScanQuarantinedDocumentOptions,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordAuditEvent({
    actorId: options.actorId ?? null,
    action,
    targetType: "Document",
    targetId: options.documentId,
    metadata,
    request: options.request,
  });
}

async function persistScanOutcome(
  documentId: string,
  scanStatus: "CLEAN" | "INFECTED" | "ERROR",
  data: {
    engine: string | null;
    reason?: string | null;
    signature?: string | null;
    now: Date;
  },
): Promise<boolean> {
  const updated = await prisma.document.updateMany({
    where: {
      id: documentId,
      status: "QUARANTINED",
      scanStatus: "SCANNING",
    },
    data: {
      scanStatus,
      scanEngine: data.engine,
      scanReason: data.reason ?? null,
      scanSignature: data.signature ?? null,
      scannedAt: data.now,
    },
  });
  return updated.count === 1;
}

async function failScan(
  target: ScanTarget,
  options: ScanQuarantinedDocumentOptions,
  engine: string,
  reason: DocumentScanFailureReason,
  attempts: number,
  now: Date,
): Promise<DocumentScanResult> {
  const persisted = await persistScanOutcome(target.id, "ERROR", {
    engine,
    reason,
    now,
  });
  if (!persisted) {
    return {
      outcome: "NOOP",
      documentId: target.id,
      reason: "state_changed",
    };
  }

  await audit(options, AUDIT_ACTIONS.DOCUMENT_SCAN_COMPLETED, {
    outcome: "ERROR",
    engine,
    reason,
    attempts,
    released: false,
  });

  return { outcome: "ERROR", documentId: target.id, reason };
}

/**
 * Release a persisted-CLEAN, still-quarantined document after re-verifying the
 * exact stored object. Used both immediately after a clean scan and to recover
 * a crash between "CLEAN persisted" and "AVAILABLE released".
 */
async function releaseCleanDocument(
  target: ScanTarget,
  options: ScanQuarantinedDocumentOptions,
  storage: StorageAdapter,
  engine: string | null,
  attempts: number,
  now: Date,
): Promise<DocumentScanResult> {
  async function failRelease(reason: DocumentScanFailureReason): Promise<DocumentScanResult> {
    const updated = await prisma.document.updateMany({
      where: {
        id: target.id,
        status: "QUARANTINED",
        scanStatus: "CLEAN",
      },
      data: {
        scanStatus: "ERROR",
        scanReason: reason,
        scannedAt: now,
      },
    });
    if (updated.count !== 1) {
      return {
        outcome: "NOOP",
        documentId: target.id,
        reason: "state_changed",
      };
    }
    await audit(options, AUDIT_ACTIONS.DOCUMENT_SCAN_COMPLETED, {
      outcome: "ERROR",
      engine,
      reason,
      attempts,
      released: false,
    });
    return { outcome: "ERROR", documentId: target.id, reason };
  }

  let bytes: Buffer;
  if (target.storageDriver !== currentStorageDriver()) {
    return failRelease("storage_driver_unavailable");
  }
  try {
    bytes = await storage.get(target.storageKey);
  } catch {
    return failRelease("storage_error");
  }

  if (
    !target.checksumSha256 ||
    bytes.byteLength !== target.sizeBytes ||
    sha256(bytes) !== target.checksumSha256
  ) {
    return failRelease("integrity_mismatch");
  }

  const released = await prisma.document.updateMany({
    where: {
      id: target.id,
      status: "QUARANTINED",
      scanStatus: "CLEAN",
      storageKey: target.storageKey,
      checksumSha256: target.checksumSha256,
      sizeBytes: target.sizeBytes,
    },
    data: { status: "AVAILABLE" },
  });

  if (released.count === 1) {
    await audit(options, AUDIT_ACTIONS.DOCUMENT_SCAN_COMPLETED, {
      outcome: "CLEAN",
      engine,
      attempts,
      released: true,
    });
    await audit(options, AUDIT_ACTIONS.DOCUMENT_SCAN_RELEASED, {
      engine,
      attempts,
    });
    return { outcome: "CLEAN", documentId: target.id, released: true };
  }

  // A concurrent release may have won the race. Confirm it released the same
  // version; anything else is a conflict and must stay quarantined.
  const current = await prisma.document.findUnique({
    where: { id: target.id },
    select: {
      status: true,
      scanStatus: true,
      storageKey: true,
      checksumSha256: true,
    },
  });
  if (
    current?.status === "AVAILABLE" &&
    current.scanStatus === "CLEAN" &&
    current.storageKey === target.storageKey &&
    current.checksumSha256 === target.checksumSha256
  ) {
    return { outcome: "CLEAN", documentId: target.id, released: true };
  }

  const confined = await prisma.document.findUnique({
    where: { id: target.id },
    select: { status: true, scanStatus: true },
  });
  if (confined?.status === "QUARANTINED" && confined.scanStatus === "CLEAN") {
    return failRelease("release_conflict");
  }

  return { outcome: "NOOP", documentId: target.id, reason: "state_changed" };
}

/**
 * Scan one quarantined document. Safe to call repeatedly: stale SCANNING
 * claims are reclaimable after the lease, CLEAN+quarantined documents are
 * released idempotently, and INFECTED documents are never retried automatically.
 */
export async function scanQuarantinedDocument(
  options: ScanQuarantinedDocumentOptions,
): Promise<DocumentScanResult> {
  const now = options.now ?? new Date();
  const scanner = options.scanner ?? getMalwareScanner();
  const storage = options.storage ?? getStorage();

  const target = (await prisma.document.findUnique({
    where: { id: options.documentId },
    select: {
      id: true,
      ownerId: true,
      status: true,
      scanStatus: true,
      scanEngine: true,
      scanSignature: true,
      scanAttempts: true,
      storageDriver: true,
      storageKey: true,
      sizeBytes: true,
      checksumSha256: true,
    },
  })) as ScanTarget | null;

  if (!target) {
    return { outcome: "NOOP", documentId: options.documentId, reason: "not_found" };
  }

  if (target.status !== "QUARANTINED") {
    return {
      outcome: "NOOP",
      documentId: target.id,
      reason:
        target.status === "AVAILABLE" && target.scanStatus === "CLEAN"
          ? "already_available"
          : "not_quarantined",
    };
  }

  // Recovery path: CLEAN was persisted but the process died before release.
  if (target.scanStatus === "CLEAN") {
    return releaseCleanDocument(
      target,
      options,
      storage,
      target.scanEngine,
      target.scanAttempts,
      now,
    );
  }

  // Infected files are not automatically re-scanned; an operator must treat
  // them as rejected evidence rather than hoping a later scan clears them.
  if (target.scanStatus === "INFECTED") {
    return {
      outcome: "NOOP",
      documentId: target.id,
      reason: "infected_terminal",
    };
  }

  const staleBefore = new Date(now.getTime() - DOCUMENT_SCAN_LEASE_MS);
  const claimed = await prisma.document.updateMany({
    where: {
      id: target.id,
      status: "QUARANTINED",
      OR: [
        { scanStatus: { in: ["UNSCANNED", "ERROR"] } },
        { scanStatus: "SCANNING", scanStartedAt: null },
        { scanStatus: "SCANNING", scanStartedAt: { lt: staleBefore } },
      ],
    },
    data: {
      scanStatus: "SCANNING",
      scanStartedAt: now,
      scanAttempts: { increment: 1 },
      scanEngine: null,
      scanReason: null,
      scanSignature: null,
      scannedAt: null,
    },
  });

  if (claimed.count !== 1) {
    return {
      outcome: "NOOP",
      documentId: target.id,
      reason: "in_progress",
    };
  }

  const attempts = target.scanAttempts + 1;

  // Do not scan through a driver this process cannot read.
  if (target.storageDriver !== currentStorageDriver()) {
    return failScan(
      target,
      options,
      scanner.id,
      "storage_driver_unavailable",
      attempts,
      now,
    );
  }

  if (scanner.configured !== true) {
    return failScan(
      target,
      options,
      scanner.id,
      scanner.unavailableReason ?? "not_configured",
      attempts,
      now,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await storage.get(target.storageKey);
  } catch {
    return failScan(target, options, scanner.id, "storage_error", attempts, now);
  }

  if (
    !Number.isSafeInteger(target.sizeBytes) ||
    target.sizeBytes <= 0 ||
    target.sizeBytes > MAX_UPLOAD_BYTES ||
    bytes.byteLength !== target.sizeBytes
  ) {
    return failScan(target, options, scanner.id, "size_mismatch", attempts, now);
  }
  if (!target.checksumSha256) {
    return failScan(target, options, scanner.id, "checksum_missing", attempts, now);
  }
  if (sha256(bytes) !== target.checksumSha256) {
    return failScan(target, options, scanner.id, "checksum_mismatch", attempts, now);
  }

  const outcome = await scanDocument(scanner, bytes);

  if (outcome.status === "INFECTED") {
    const signature = sanitizeScanSignature(outcome.signature) ?? "unknown";
    const persisted = await persistScanOutcome(target.id, "INFECTED", {
      engine: outcome.engine,
      signature,
      now,
    });
    if (!persisted) {
      return {
        outcome: "NOOP",
        documentId: target.id,
        reason: "state_changed",
      };
    }
    await audit(options, AUDIT_ACTIONS.DOCUMENT_SCAN_COMPLETED, {
      outcome: "INFECTED",
      engine: outcome.engine,
      signature,
      attempts,
      released: false,
    });
    return { outcome: "INFECTED", documentId: target.id, signature };
  }

  if (outcome.status === "ERROR") {
    return failScan(
      target,
      options,
      outcome.engine,
      outcome.reason,
      attempts,
      now,
    );
  }

  // CLEAN is persisted first. Release is a separate conditional transition.
  const persisted = await persistScanOutcome(target.id, "CLEAN", {
    engine: outcome.engine,
    now,
  });
  if (!persisted) {
    return {
      outcome: "NOOP",
      documentId: target.id,
      reason: "state_changed",
    };
  }

  return releaseCleanDocument(
    target,
    options,
    storage,
    outcome.engine,
    attempts,
    now,
  );
}
