import test from "node:test";
import assert from "node:assert/strict";
import { statusForScanResult } from "../src/lib/documents.ts";
import { getMalwareScanner, scanDocument } from "../src/lib/security/malware.ts";

// Document-lifecycle and malware-provider boundary tests. These enforce the
// rule that a file is never marked AVAILABLE unless a configured scanner
// returned a verified CLEAN result.

function withScannerEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("only a CLEAN scan result maps to AVAILABLE", () => {
  assert.equal(statusForScanResult("CLEAN"), "AVAILABLE");
  assert.equal(statusForScanResult("INFECTED"), "QUARANTINED");
  assert.equal(statusForScanResult("ERROR"), "QUARANTINED");
  assert.equal(statusForScanResult("UNSCANNED"), "QUARANTINED");
});

test("no scanner configured reports a typed ERROR, never CLEAN", async () => {
  await withScannerEnv({ MALWARE_SCANNER: undefined }, async () => {
    const scanner = getMalwareScanner();
    assert.equal(scanner.configured, false);
    const result = await scanDocument(scanner, Buffer.from("%PDF-1.7"));
    assert.deepEqual(result, {
      status: "ERROR",
      engine: "unconfigured",
      reason: "not_configured",
    });
    assert.equal(statusForScanResult(result.status), "QUARANTINED");
  });
});

test("clamav without a host fails closed as not configured", async () => {
  await withScannerEnv(
    { MALWARE_SCANNER: "clamav", CLAMAV_HOST: undefined, CLAMAV_PORT: "3310" },
    async () => {
      const scanner = getMalwareScanner();
      assert.equal(scanner.configured, false);
      const result = await scanDocument(scanner, Buffer.from("%PDF-1.7"));
      assert.equal(result.status, "ERROR");
      assert.equal(result.reason, "not_configured");
    },
  );
});

test("an unsupported scanner engine fails closed", async () => {
  await withScannerEnv({ MALWARE_SCANNER: "always-clean" }, async () => {
    const scanner = getMalwareScanner();
    assert.equal(scanner.configured, false);
    const result = await scanDocument(scanner, Buffer.from("data"));
    assert.equal(result.status, "ERROR");
    assert.equal(result.reason, "unsupported_engine");
  });
});

test("a scanner that throws fails closed to ERROR", async () => {
  const throwingScanner = {
    id: "broken-scanner",
    configured: true,
    async scan() {
      throw new Error("scanner backend offline");
    },
  };

  const result = await scanDocument(throwingScanner, Buffer.from("%PDF-1.7"));
  assert.equal(result.status, "ERROR");
  assert.equal(result.reason, "transport_error");
  assert.equal(statusForScanResult(result.status), "QUARANTINED");
});

test("an unconfigured scanner is never invoked and cannot report CLEAN", async () => {
  let invoked = false;
  const unconfigured = {
    id: "not-configured",
    configured: false,
    unavailableReason: "not_configured",
    async scan() {
      invoked = true;
      return { status: "CLEAN", engine: "not-configured" };
    },
  };

  const result = await scanDocument(unconfigured, Buffer.from("data"));
  assert.equal(result.status, "ERROR");
  assert.equal(result.reason, "not_configured");
  assert.equal(invoked, false);
});

test("malformed adapter outcomes are never treated as a clean scan", async () => {
  const badScanners = [
    { status: "BOGUS", engine: "bad" },
    { status: "INFECTED", engine: "bad", signature: "" },
  ];

  for (const outcome of badScanners) {
    const scanner = {
      id: "bad",
      configured: true,
      async scan() {
        return outcome;
      },
    };
    const result = await scanDocument(scanner, Buffer.from("data"));
    assert.equal(result.status, "ERROR");
    assert.equal(result.reason, "malformed_response");
  }
});
