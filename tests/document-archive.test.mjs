import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import JSZip from "jszip";
import {
  DOCX_ARCHIVE_LIMITS,
  DocumentExtractionError,
  evaluateDocxArchiveEntries,
  extractDocumentText,
  inspectDocxArchive,
  verifyDocxArchiveEntries,
} from "../src/lib/analysis/extract-text.ts";

// DOCX archive-bomb guard tests. The upload limit (25 MB compressed) does not
// bound the decompressed size, so extraction must preflight the ZIP container
// before any parser decompresses it.

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function entry(overrides = {}) {
  return {
    name: "word/document.xml",
    directory: false,
    uncompressedSize: 16,
    compressedSize: 8,
    compressionMagic: "\u0008\u0000",
    compressedContent: new Uint8Array(8),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Header-level checks                                                 */
/* ------------------------------------------------------------------ */

test("entries beyond the count limit are rejected", () => {
  const entries = Array.from({ length: DOCX_ARCHIVE_LIMITS.maxEntries + 1 }, (_, i) =>
    entry({ name: `word/f${i}.xml` }),
  );
  const verdict = evaluateDocxArchiveEntries(entries);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "document_archive_too_complex");
});

test("an entry declaring more than the per-entry limit is rejected", () => {
  const verdict = evaluateDocxArchiveEntries([
    entry({ uncompressedSize: DOCX_ARCHIVE_LIMITS.maxEntryUncompressedBytes + 1 }),
  ]);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "document_archive_too_large");
});

test("entries whose declared total exceeds the limit are rejected", () => {
  const half = Math.ceil(DOCX_ARCHIVE_LIMITS.maxTotalUncompressedBytes / 2) + 1;
  const verdict = evaluateDocxArchiveEntries([
    entry({ name: "word/a.xml", uncompressedSize: half }),
    entry({ name: "word/b.xml", uncompressedSize: half }),
  ]);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "document_archive_too_large");
});

test("missing or malformed declared sizes fail closed", () => {
  assert.equal(evaluateDocxArchiveEntries([entry({ uncompressedSize: Number.NaN })]).ok, false);
  assert.equal(evaluateDocxArchiveEntries([entry({ compressedSize: -1 })]).ok, false);
  assert.equal(evaluateDocxArchiveEntries([]).ok, false);
});

test("a plausible small archive passes the header checks", () => {
  assert.equal(evaluateDocxArchiveEntries([entry()]).ok, true);
});

/* ------------------------------------------------------------------ */
/* Content verification (lying central directory)                      */
/* ------------------------------------------------------------------ */

test("content verification catches a header that understates the real size", () => {
  const payload = Buffer.alloc(4096, 7);
  const compressed = deflateRawSync(payload);
  const verdict = verifyDocxArchiveEntries([
    entry({ uncompressedSize: 16, compressedSize: compressed.length, compressedContent: compressed }),
  ]);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "document_archive_invalid");
});

test("content verification aborts decompression past the output budget", () => {
  const payload = Buffer.alloc(64 * 1024, 7);
  const compressed = deflateRawSync(payload);
  const verdict = verifyDocxArchiveEntries(
    [entry({ uncompressedSize: 16, compressedSize: compressed.length, compressedContent: compressed })],
    { maxEntries: 8, maxEntryUncompressedBytes: 1024, maxTotalUncompressedBytes: 2048 },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "document_archive_too_large");
});

test("content verification validates stored entries and honest deflate entries", () => {
  const stored = new Uint8Array(16).fill(1);
  assert.equal(
    verifyDocxArchiveEntries([
      entry({ compressionMagic: "\u0000\u0000", uncompressedSize: 16, compressedSize: 16, compressedContent: stored }),
    ]).ok,
    true,
  );

  const lie = verifyDocxArchiveEntries([
    entry({ compressionMagic: "\u0000\u0000", uncompressedSize: 32, compressedSize: 16, compressedContent: stored }),
  ]);
  assert.equal(lie.ok, false);
  assert.equal(lie.code, "document_archive_invalid");

  const payload = Buffer.from("hello docx ".repeat(64), "utf8");
  const compressed = deflateRawSync(payload);
  assert.equal(
    verifyDocxArchiveEntries([
      entry({ uncompressedSize: payload.length, compressedSize: compressed.length, compressedContent: compressed }),
    ]).ok,
    true,
  );
});

/* ------------------------------------------------------------------ */
/* Real ZIP inspection and end-to-end extraction guard                 */
/* ------------------------------------------------------------------ */

test("a real DOCX-style zip is inspected without decompressing it", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", "<w:document>hello</w:document>".repeat(40));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  const entries = await inspectDocxArchive(bytes);
  assert.ok(entries.some((e) => e.name === "word/document.xml" && !e.directory));
  assert.equal(evaluateDocxArchiveEntries(entries).ok, true);
  assert.equal(verifyDocxArchiveEntries(entries).ok, true);
});

test("extraction rejects an archive with too many entries before parsing", async () => {
  const zip = new JSZip();
  for (let i = 0; i <= DOCX_ARCHIVE_LIMITS.maxEntries; i += 1) {
    zip.file(`word/f${i}.xml`, "x");
  }
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  await assert.rejects(
    extractDocumentText({ contentType: DOCX_MIME, bytes }),
    (error) =>
      error instanceof DocumentExtractionError && error.code === "document_archive_too_complex",
  );
});

test("extraction rejects a zip whose central directory lies about the size", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", "x".repeat(4096));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  patchCentralDirectoryUncompressedSize(bytes, "word/document.xml", 32);

  await assert.rejects(
    extractDocumentText({ contentType: DOCX_MIME, bytes }),
    (error) =>
      error instanceof DocumentExtractionError && error.code === "document_archive_invalid",
  );
});

/** Patch the declared uncompressed size in the ZIP central directory entry. */
function patchCentralDirectoryUncompressedSize(buffer, fileName, newSize) {
  const nameBytes = Buffer.from(fileName, "utf8");
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;

  for (;;) {
    const at = buffer.indexOf(signature, offset);
    assert.notEqual(at, -1, "central directory entry not found");
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const name = buffer.subarray(at + 46, at + 46 + nameLength);
    if (name.equals(nameBytes)) {
      buffer.writeUInt32LE(newSize, at + 24);
      return;
    }
    offset = at + 46 + nameLength + extraLength + commentLength;
  }
}
