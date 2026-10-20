// Safe text extraction for the analysis pipeline.
//
// Only the formats below are supported. Legacy .doc, .odt and .rtf uploads are
// accepted by the document vault but are rejected for analysis with a clear,
// safe error rather than guessing at their binary structure.
//
// Extraction happens entirely server-side from bytes read through the private
// storage abstraction. Extracted text is used only for local matching and (with
// consent) the configured LLM provider. It is never logged.

import { inflateRawSync } from "node:zlib";

export const EXTRACTION_LIMITS = {
  maxExtractedChars: 120_000,
  minExtractedChars: 20,
  maxPdfPages: 300,
} as const;

/**
 * Hard bounds applied to the DOCX ZIP container BEFORE a parsing library is
 * allowed to decompress anything. The declared sizes in the central directory
 * are only used as a cheap first pass; every entry is then re-inflated with a
 * hard output budget so a crafted archive whose headers understate the real
 * decompressed size cannot bypass the limits (classic zip bomb).
 */
export const DOCX_ARCHIVE_LIMITS = {
  maxEntries: 2_048,
  maxEntryUncompressedBytes: 50 * 1024 * 1024,
  maxTotalUncompressedBytes: 100 * 1024 * 1024,
} as const;

export type ExtractionErrorCategory = "CONTENT_REJECTED" | "PERMANENT";

export class DocumentExtractionError extends Error {
  readonly code: string;
  readonly category: ExtractionErrorCategory;

  constructor(code: string, message: string, category: ExtractionErrorCategory = "CONTENT_REJECTED") {
    super(message);
    this.name = "DocumentExtractionError";
    this.code = code;
    this.category = category;
  }
}

export interface ExtractedDocumentText {
  text: string;
  extractionVersion: string;
  pageCount: number | null;
}

/**
 * Normalize extracted text without destroying the character offsets used by
 * highlighting. CRLF becomes LF; control characters and excessive blank lines
 * are collapsed. The normalized text is the coordinate space for all offsets.
 */
export function normalizeExtractedText(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\t/g, " ")
    .replace(/[ \u00a0]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function checkLength(text: string): string {
  if (text.length < EXTRACTION_LIMITS.minExtractedChars) {
    throw new DocumentExtractionError(
      "document_text_too_short",
      "The document does not contain enough extractable text to analyse.",
    );
  }
  if (text.length > EXTRACTION_LIMITS.maxExtractedChars) {
    throw new DocumentExtractionError(
      "document_text_too_large",
      "The extracted document text exceeds the analysis size limit.",
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// DOCX archive guard
// ---------------------------------------------------------------------------

export interface DocxArchiveLimits {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
}

export interface DocxArchiveEntry {
  name: string;
  directory: boolean;
  /** Declared by the central directory; untrusted until verified. */
  uncompressedSize: number;
  compressedSize: number;
  /** ZIP compression magic: "\x00\x00" stored, "\x08\x00" deflate. */
  compressionMagic: string;
  /** Raw compressed bytes, re-inflated under a hard output budget. */
  compressedContent: Uint8Array | null;
}

export type DocxArchiveVerdict =
  | { ok: true }
  | { ok: false; code: string; message: string };

const ARCHIVE_TOO_LARGE: DocxArchiveVerdict = {
  ok: false,
  code: "document_archive_too_large",
  message: "The DOCX archive expands beyond the analysis size limit.",
};

const ARCHIVE_INVALID: DocxArchiveVerdict = {
  ok: false,
  code: "document_archive_invalid",
  message: "The DOCX archive is malformed or inconsistent.",
};

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Cheap header-level checks: entry count and declared sizes. Runs before any
 * decompression and rejects obvious archive bombs outright.
 */
export function evaluateDocxArchiveEntries(
  entries: DocxArchiveEntry[],
  limits: DocxArchiveLimits = DOCX_ARCHIVE_LIMITS,
): DocxArchiveVerdict {
  if (entries.length === 0) return ARCHIVE_INVALID;
  if (entries.length > limits.maxEntries) {
    return {
      ok: false,
      code: "document_archive_too_complex",
      message: "The DOCX archive contains too many entries to analyse safely.",
    };
  }

  let total = 0;
  for (const entry of entries) {
    if (entry.directory) continue;
    if (!isNonNegativeInteger(entry.uncompressedSize) || !isNonNegativeInteger(entry.compressedSize)) {
      return ARCHIVE_INVALID;
    }
    if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) return ARCHIVE_TOO_LARGE;
    total += entry.uncompressedSize;
    if (total > limits.maxTotalUncompressedBytes) return ARCHIVE_TOO_LARGE;
  }
  return { ok: true };
}

/**
 * Authoritative check: re-inflate every entry under a hard output budget and
 * require the real size to match the declared size. A lying central directory
 * (declared small, actually huge) is caught here because zlib aborts as soon as
 * the output budget is exceeded rather than buffering the full expansion.
 */
export function verifyDocxArchiveEntries(
  entries: DocxArchiveEntry[],
  limits: DocxArchiveLimits = DOCX_ARCHIVE_LIMITS,
): DocxArchiveVerdict {
  let remaining = limits.maxTotalUncompressedBytes;

  for (const entry of entries) {
    if (entry.directory) continue;
    const content = entry.compressedContent;
    if (!content) return ARCHIVE_INVALID;

    if (entry.compressionMagic === "\x00\x00") {
      // Stored: decompression is a copy, so the real size is the byte length.
      if (content.byteLength !== entry.uncompressedSize) return ARCHIVE_INVALID;
      remaining -= content.byteLength;
      if (remaining < 0) return ARCHIVE_TOO_LARGE;
      continue;
    }

    const budget = Math.min(limits.maxEntryUncompressedBytes, remaining);
    let actual: number;
    try {
      actual = inflateRawSync(Buffer.from(content), { maxOutputLength: budget + 1 }).byteLength;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      return code === "ERR_BUFFER_TOO_LARGE" ? ARCHIVE_TOO_LARGE : ARCHIVE_INVALID;
    }
    if (actual !== entry.uncompressedSize) return ARCHIVE_INVALID;
    remaining -= actual;
    if (remaining < 0) return ARCHIVE_TOO_LARGE;
  }

  return { ok: true };
}

/**
 * Parse only the ZIP central directory (no decompression) and expose the
 * metadata needed by the guards above. Relies on JSZip's internal `_data`
 * representation; if that shape ever changes the guard fails closed because
 * the sizes are missing, never because the limits were skipped.
 */
export async function inspectDocxArchive(bytes: Buffer): Promise<DocxArchiveEntry[]> {
  type Loader = {
    loadAsync: (
      data: Buffer,
      options?: { checkCRC32?: boolean; createFolders?: boolean },
    ) => Promise<{ files: Record<string, unknown> }>;
  };
  const imported = (await import("jszip")) as unknown as Partial<Loader> & { default?: Loader };
  const loader = (imported.default ?? imported) as Loader;
  const zip = await loader.loadAsync(bytes, { checkCRC32: false, createFolders: false });

  const entries: DocxArchiveEntry[] = [];
  for (const [name, value] of Object.entries(zip.files)) {
    const file = value as {
      dir?: boolean;
      _data?: {
        uncompressedSize?: unknown;
        compressedSize?: unknown;
        compression?: { magic?: unknown };
        compressedContent?: unknown;
      };
    };

    if (file.dir === true) {
      entries.push({
        name,
        directory: true,
        uncompressedSize: 0,
        compressedSize: 0,
        compressionMagic: "\x00\x00",
        compressedContent: null,
      });
      continue;
    }

    const data = file._data;
    const compressedContent =
      data && data.compressedContent instanceof Uint8Array ? data.compressedContent : null;

    entries.push({
      name,
      directory: false,
      uncompressedSize:
        data && typeof data.uncompressedSize === "number" ? data.uncompressedSize : Number.NaN,
      compressedSize:
        data && typeof data.compressedSize === "number" ? data.compressedSize : Number.NaN,
      compressionMagic:
        data && data.compression && typeof data.compression.magic === "string"
          ? data.compression.magic
          : "",
      compressedContent,
    });
  }
  return entries;
}

async function extractPdf(bytes: Buffer): Promise<ExtractedDocumentText> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    try {
      if (pdf.numPages > EXTRACTION_LIMITS.maxPdfPages) {
        throw new DocumentExtractionError(
          "document_too_many_pages",
          "The PDF exceeds the analysis page limit.",
        );
      }
      const result = await extractText(pdf, { mergePages: true });
      return {
        text: checkLength(normalizeExtractedText(result.text)),
        extractionVersion: "unpdf-1",
        pageCount: result.totalPages,
      };
    } finally {
      // The runtime PDFDocumentProxy exposes destroy(), but the serverless type
      // bundle does not declare it. Always release worker resources.
      const destroyable = pdf as unknown as { destroy?: () => Promise<void> };
      await destroyable.destroy?.().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError(
      "pdf_extraction_failed",
      "The PDF text could not be extracted safely.",
    );
  }
}

async function extractDocx(bytes: Buffer): Promise<ExtractedDocumentText> {
  try {
    // Container preflight with hard decompression bounds before mammoth (or any
    // other parser) touches the archive. Fails closed with a safe error.
    const entries = await inspectDocxArchive(bytes);
    const headerVerdict = evaluateDocxArchiveEntries(entries);
    if (!headerVerdict.ok) {
      throw new DocumentExtractionError(headerVerdict.code, headerVerdict.message);
    }
    const contentVerdict = verifyDocxArchiveEntries(entries);
    if (!contentVerdict.ok) {
      throw new DocumentExtractionError(contentVerdict.code, contentVerdict.message);
    }

    const imported = await import("mammoth");
    const mammoth = (imported as unknown as { default?: typeof imported }).default ?? imported;
    const result = await mammoth.extractRawText({ buffer: bytes });
    return {
      text: checkLength(normalizeExtractedText(result.value)),
      extractionVersion: "mammoth-1",
      pageCount: null,
    };
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError(
      "docx_extraction_failed",
      "The DOCX text could not be extracted safely.",
    );
  }
}

function extractPlainText(bytes: Buffer): ExtractedDocumentText {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    throw new DocumentExtractionError(
      "text_decoding_failed",
      "The text document could not be decoded safely.",
    );
  }
  if (decoded.includes("\uFFFD") && decoded.split("\uFFFD").length > decoded.length / 100) {
    throw new DocumentExtractionError(
      "text_decoding_failed",
      "The text document does not appear to be valid UTF-8.",
    );
  }
  return {
    text: checkLength(normalizeExtractedText(decoded)),
    extractionVersion: "utf8-1",
    pageCount: null,
  };
}

/**
 * Extract normalized text from an authorized document. The caller is
 * responsible for authorization, quarantine checks, and size/checksum checks.
 */
export async function extractDocumentText(args: {
  contentType: string;
  bytes: Buffer;
}): Promise<ExtractedDocumentText> {
  switch (args.contentType) {
    case "application/pdf":
      return extractPdf(args.bytes);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return extractDocx(args.bytes);
    case "text/plain":
      return extractPlainText(args.bytes);
    case "application/msword":
    case "application/rtf":
    case "application/vnd.oasis.opendocument.text":
      throw new DocumentExtractionError(
        "unsupported_document_format",
        "This document format cannot be analysed yet. Upload a PDF, DOCX, or TXT file.",
      );
    default:
      throw new DocumentExtractionError(
        "unsupported_document_format",
        "This document type cannot be analysed.",
        "PERMANENT",
      );
  }
}
