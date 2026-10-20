import test from "node:test";
import assert from "node:assert/strict";
import {
  REQUEST_BODY_LIMITS,
  readBodyBytesWithLimit,
  readBodyTextWithLimit,
  readJsonBodyWithLimit,
} from "../src/lib/request-body.ts";
import { MAX_UPLOAD_BYTES } from "../src/lib/storage/types.ts";

// Bounded request-body tests. Routes must never buffer an unbounded body even
// when Content-Length is absent, chunked, or wrong.

function streamOf(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test("bounded body reader returns bytes within the budget", async () => {
  const result = await readBodyBytesWithLimit(
    streamOf(new Uint8Array([1, 2]), new Uint8Array([3])),
    10,
  );
  assert.equal(result.ok, true);
  assert.deepEqual([...result.bytes], [1, 2, 3]);
});

test("bounded body reader rejects and cancels past the budget", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
    },
    cancel() {
      cancelled = true;
    },
  });

  const result = await readBodyBytesWithLimit(stream, 10);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too_large");
  assert.equal(cancelled, true, "the reader must cancel the stream, not drain it");
});

test("an absent body is an empty byte string, not an error", async () => {
  const result = await readBodyBytesWithLimit(null, 10);
  assert.equal(result.ok, true);
  assert.equal(result.bytes.byteLength, 0);
});

test("bounded text reader decodes UTF-8", async () => {
  const result = await readBodyTextWithLimit(
    streamOf(new TextEncoder().encode('{"reason":"ünïcode"}')),
    64,
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, '{"reason":"ünïcode"}');
});

test("bounded JSON reader parses, rejects oversized, and rejects malformed", async () => {
  const ok = await readJsonBodyWithLimit(streamOf(new TextEncoder().encode('{"a":1}')), 64);
  assert.deepEqual(ok, { ok: true, value: { a: 1 } });

  const tooLarge = await readJsonBodyWithLimit(streamOf(new Uint8Array(128)), 64);
  assert.deepEqual(tooLarge, { ok: false, tooLarge: true });

  const malformed = await readJsonBodyWithLimit(streamOf(new TextEncoder().encode("{")), 64);
  assert.deepEqual(malformed, { ok: false, tooLarge: false });

  const empty = await readJsonBodyWithLimit(streamOf(), 64);
  assert.deepEqual(empty, { ok: false, tooLarge: false });
});

test("upload budget leaves framing room above the raw file limit", () => {
  assert.ok(REQUEST_BODY_LIMITS.uploadBytes > MAX_UPLOAD_BYTES);
  assert.ok(REQUEST_BODY_LIMITS.uploadBytes - MAX_UPLOAD_BYTES <= 1024 * 1024);
});

test("JSON/webhook budgets stay small enough to bound memory", () => {
  assert.ok(REQUEST_BODY_LIMITS.jsonBytes <= 128 * 1024);
  assert.ok(REQUEST_BODY_LIMITS.webhookBytes <= 256 * 1024);
});
