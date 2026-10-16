import test from "node:test";
import assert from "node:assert/strict";
import {
  detectFileKind,
  extensionOf,
  sanitizeFilename,
  validateUpload,
} from "../src/lib/storage/validation.ts";
import { MAX_UPLOAD_BYTES } from "../src/lib/storage/types.ts";

// Pure upload-validation tests. No database or Next.js runtime required.

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]); // %PDF-1.7
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]); // PK\x03\x04 (docx/odt)
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]); // legacy .doc
const RTF = Buffer.from("{\\rtf1\\ansi hello }");
const TEXT = Buffer.from("Chapter 1. This is plain academic text.\n");
const BINARY = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00]);

test("extensionOf handles dotfiles, paths and multiple dots", () => {
  assert.equal(extensionOf("essay.pdf"), "pdf");
  assert.equal(extensionOf("C:\\Users\\me\\Thesis.DOCX"), "docx");
  assert.equal(extensionOf("a.b.c.rtf"), "rtf");
  assert.equal(extensionOf("noextension"), "");
  assert.equal(extensionOf(".hidden"), "");
});

test("detectFileKind recognises signatures", () => {
  assert.equal(detectFileKind(PDF), "pdf");
  assert.equal(detectFileKind(ZIP), "zip");
  assert.equal(detectFileKind(OLE), "ole");
  assert.equal(detectFileKind(RTF), "rtf");
  assert.equal(detectFileKind(TEXT), "text");
  assert.equal(detectFileKind(BINARY), "unknown");
});

test("accepts a valid PDF matching name, declared type and signature", () => {
  const result = validateUpload({
    originalName: "thesis.pdf",
    declaredContentType: "application/pdf",
    buffer: PDF,
  });
  assert.equal(result.ok, true);
  assert.equal(result.contentType, "application/pdf");
  assert.equal(result.extension, "pdf");
});

test("accepts docx (zip signature) and legacy doc (OLE signature)", () => {
  assert.equal(
    validateUpload({
      originalName: "chapter.docx",
      declaredContentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: ZIP,
    }).ok,
    true,
  );
  assert.equal(
    validateUpload({
      originalName: "old.doc",
      declaredContentType: "application/msword",
      buffer: OLE,
    }).ok,
    true,
  );
});

test("rejects disallowed content types", () => {
  const result = validateUpload({
    originalName: "archive.zip",
    declaredContentType: "application/zip",
    buffer: ZIP,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unsupported file type/);
});

test("rejects when the extension disagrees with the declared type", () => {
  const result = validateUpload({
    originalName: "thesis.exe",
    declaredContentType: "application/pdf",
    buffer: PDF,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /extension/i);
});

test("rejects when the file contents do not match the declared type", () => {
  // An executable/HTML payload masquerading as a PDF.
  const result = validateUpload({
    originalName: "evil.pdf",
    declaredContentType: "application/pdf",
    buffer: Buffer.from("<html><script>alert(1)</script>"),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /do not match/i);
});

test("rejects empty files", () => {
  const result = validateUpload({
    originalName: "empty.pdf",
    declaredContentType: "application/pdf",
    buffer: Buffer.alloc(0),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /empty/i);
});

test("rejects files over the 25 MB limit", () => {
  const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
  oversized.set([0x25, 0x50, 0x44, 0x46]); // valid PDF header, but too large
  const result = validateUpload({
    originalName: "huge.pdf",
    declaredContentType: "application/pdf",
    buffer: oversized,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /25 MB/);
});

test("sanitizeFilename strips path separators and control characters", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("C:\\temp\\the\"sis.pdf"), "thesis.pdf");
  assert.equal(sanitizeFilename("   "), "document");
});
