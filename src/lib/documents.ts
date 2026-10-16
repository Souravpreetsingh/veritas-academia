import type { DocumentStatus } from "@/lib/domain";

// Document lifecycle helpers (pure and testable).

export type ScanStatus = "CLEAN" | "INFECTED" | "UNSCANNED";

/**
 * Map a malware-scan outcome to a document status. Files are only AVAILABLE
 * when a real scanner CLEARED them; everything else — including "UNSCANNED" —
 * stays QUARANTINED.
 */
export function statusForScanResult(scanStatus: ScanStatus): DocumentStatus {
  return scanStatus === "CLEAN" ? "AVAILABLE" : "QUARANTINED";
}
