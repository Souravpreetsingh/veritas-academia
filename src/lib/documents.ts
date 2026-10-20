import type { DocumentStatus } from "@/lib/domain";

// Document lifecycle helpers (pure and testable).

/** Scanner outcomes plus the legacy "never attempted" state. */
export type ScanStatus = "CLEAN" | "INFECTED" | "ERROR" | "UNSCANNED";

/**
 * Map a malware-scan outcome to a document status. This is a presentation
 * helper only: the real release path (src/lib/document-scan.ts) persists a
 * CLEAN scan result and then performs a conditional QUARANTINED -> AVAILABLE
 * transition tied to the stored file's checksum. Everything except a verified
 * CLEAN result stays QUARANTINED.
 */
export function statusForScanResult(scanStatus: ScanStatus): DocumentStatus {
  return scanStatus === "CLEAN" ? "AVAILABLE" : "QUARANTINED";
}
