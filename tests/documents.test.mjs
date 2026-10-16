import test from "node:test";
import assert from "node:assert/strict";
import { statusForScanResult } from "../src/lib/documents.ts";
import { getMalwareScanner } from "../src/lib/security/malware.ts";

// Document-lifecycle and malware-provider boundary tests. These enforce the
// rule that a file is never marked AVAILABLE unless a real scanner cleared it.

test("only a CLEAN scan makes a document AVAILABLE", () => {
  assert.equal(statusForScanResult("CLEAN"), "AVAILABLE");
  assert.equal(statusForScanResult("INFECTED"), "QUARANTINED");
});

test("an unscanned file stays QUARANTINED", () => {
  assert.equal(statusForScanResult("UNSCANNED"), "QUARANTINED");
});

test("no scanner is configured, so uploads report UNSCANNED (never CLEAN)", async () => {
  const scanner = getMalwareScanner();
  assert.equal(scanner.configured, false);
  const result = await scanner.scan(Buffer.from("%PDF-1.7"), {
    originalName: "thesis.pdf",
    contentType: "application/pdf",
  });
  assert.equal(result.status, "UNSCANNED");
  // And therefore the upload would be quarantined, not available.
  assert.equal(statusForScanResult(result.status), "QUARANTINED");
});

test("a configured-but-unimplemented scanner still refuses to clear files", async () => {
  const previous = process.env.MALWARE_SCANNER;
  process.env.MALWARE_SCANNER = "clamav";
  try {
    const scanner = getMalwareScanner();
    assert.equal(scanner.configured, false);
    const result = await scanner.scan(Buffer.from("%PDF-1.7"), {
      originalName: "thesis.pdf",
      contentType: "application/pdf",
    });
    assert.equal(result.status, "UNSCANNED");
  } finally {
    if (previous === undefined) delete process.env.MALWARE_SCANNER;
    else process.env.MALWARE_SCANNER = previous;
  }
});
