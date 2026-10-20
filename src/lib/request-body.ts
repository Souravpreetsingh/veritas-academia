// Bounded request-body reading.
//
// Route handlers must never buffer an unbounded request body: a single request
// could otherwise exhaust the server process memory before validation runs.
// These helpers read a web ReadableStream up to an explicit byte budget and
// fail closed past it. They never trust a Content-Length header, because a
// chunked or lying client can bypass header-only checks.
//
// The upload budget intentionally leaves room for multipart framing overhead
// above the raw-file limit enforced later by the document validation layer.

import { MAX_UPLOAD_BYTES } from "@/lib/storage/types";

export const REQUEST_BODY_LIMITS = {
  /** JSON bodies: largest legitimate payload is roughly 50 KB. */
  jsonBytes: 128 * 1024,
  /** Raw text bodies (e.g. an optional JSON decline payload). */
  textBytes: 256 * 1024,
  /** Razorpay webhook bodies (payments.ts enforces its own 200 KB char cap). */
  webhookBytes: 256 * 1024,
  /** Multipart upload framing allowed above MAX_UPLOAD_BYTES. */
  uploadBytes: MAX_UPLOAD_BYTES + 1024 * 1024,
} as const;

export type BodyReadFailureReason = "too_large" | "unreadable";

export type BodyReadResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: BodyReadFailureReason };

/**
 * Read at most `maxBytes` bytes from a request body stream. When the stream
 * exceeds the budget the reader is cancelled and no more data is buffered.
 */
export async function readBodyBytesWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BodyReadResult> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { ok: false, reason: "too_large" };
  }
  if (!stream) return { ok: true, bytes: new Uint8Array(0) };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "unreadable" };
  }

  if (chunks.length === 0) return { ok: true, bytes: new Uint8Array(0) };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** Decode a bounded request body as UTF-8 text. */
export async function readBodyTextWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: BodyReadFailureReason }> {
  const result = await readBodyBytesWithLimit(stream, maxBytes);
  if (!result.ok) return result;
  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(result.bytes) };
}

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; tooLarge: boolean };

/** Read and parse a bounded JSON request body; malformed JSON is not an error. */
export async function readJsonBodyWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number = REQUEST_BODY_LIMITS.jsonBytes,
): Promise<JsonBodyResult> {
  const result = await readBodyBytesWithLimit(stream, maxBytes);
  if (!result.ok) return { ok: false, tooLarge: result.reason === "too_large" };
  if (result.bytes.byteLength === 0) return { ok: false, tooLarge: false };
  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(result.bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, tooLarge: false };
  }
}
