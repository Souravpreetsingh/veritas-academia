import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from "./types";

// Server-side upload validation. The browser-provided content type is never
// trusted on its own: the declared MIME type, the filename extension, and the
// actual file signature (magic bytes) must all agree.

export type FileKind = "pdf" | "zip" | "ole" | "rtf" | "text" | "unknown";

/** Expected signature kind for each allowed content type. */
const CONTENT_TYPE_KIND: Record<string, FileKind> = {
  "application/pdf": "pdf",
  "application/msword": "ole",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "zip",
  "application/rtf": "rtf",
  "text/plain": "text",
  "application/vnd.oasis.opendocument.text": "zip",
};

/** Expected filename extension for each allowed content type. */
const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/rtf": "rtf",
  "text/plain": "txt",
  "application/vnd.oasis.opendocument.text": "odt",
};

export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((b, i) => buffer[i] === b);
}

/** Detect a file kind from its leading bytes. */
export function detectFileKind(buffer: Buffer): FileKind {
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return "zip"; // PK\x03\x04
  if (startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])) return "zip"; // empty zip
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole"; // OLE2
  if (startsWith(buffer, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return "rtf"; // {\rtf

  // Plain-text heuristic: no NUL bytes in the first 4 KB and mostly printable.
  const sample = buffer.subarray(0, 4096);
  if (sample.length === 0) return "text";
  if (sample.includes(0x00)) return "unknown";
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte !== 0x7f)) {
      printable++;
    }
  }
  return printable / sample.length > 0.9 ? "text" : "unknown";
}

export interface ValidateUploadInput {
  originalName: string;
  declaredContentType: string;
  buffer: Buffer;
}

export interface ValidateUploadResult {
  ok: boolean;
  contentType?: string;
  extension?: string;
  detectedKind?: FileKind;
  error?: string;
}

export function validateUpload({
  originalName,
  declaredContentType,
  buffer,
}: ValidateUploadInput): ValidateUploadResult {
  if (buffer.byteLength === 0) {
    return { ok: false, error: "The uploaded file is empty." };
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "The file exceeds the 25 MB limit." };
  }

  const declared = (declaredContentType || "").toLowerCase();
  const expectedKind = CONTENT_TYPE_KIND[declared];
  if (!expectedKind || !ALLOWED_CONTENT_TYPES[declared]) {
    return { ok: false, error: "Unsupported file type. Allowed: PDF, DOC, DOCX, ODT, RTF, TXT." };
  }

  const extension = extensionOf(originalName);
  const expectedExtension = CONTENT_TYPE_EXTENSION[declared];
  if (extension !== expectedExtension) {
    return { ok: false, error: `File extension does not match the declared type (expected .${expectedExtension}).` };
  }

  const detectedKind = detectFileKind(buffer);
  // The signature must match the declared type's expected kind.
  const signatureOk = detectedKind === expectedKind;
  if (!signatureOk) {
    return {
      ok: false,
      detectedKind,
      error: "File contents do not match the declared file type.",
    };
  }

  return { ok: true, contentType: declared, extension, detectedKind };
}

/** Safe filename for a Content-Disposition header. */
export function sanitizeFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "document").trim();
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\]/g, "").slice(0, 200);
  return cleaned.length > 0 ? cleaned : "document";
}
