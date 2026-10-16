import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalStorage } from "../src/lib/storage/local.ts";
import { StorageError } from "../src/lib/storage/types.ts";

// Exercises the private local storage adapter against a throwaway directory.
// Verifies randomized keys, streaming reads, traversal protection and removal
// (used to roll back orphaned objects when metadata persistence fails).

async function withStorage(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "turnint-storage-"));
  try {
    return await fn(createLocalStorage({ root }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("put stores bytes under a randomized, non-user-derived key", async () => {
  await withStorage(async (storage) => {
    const data = Buffer.from("%PDF-1.7 academic work");
    const object = await storage.put({
      data,
      contentType: "application/pdf",
      originalName: "../../evil.pdf",
    });
    assert.match(object.key, /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/);
    assert.ok(!object.key.includes("evil"));
    assert.equal(object.sizeBytes, data.byteLength);
    assert.equal(await storage.exists(object.key), true);
  });
});

test("put rejects unsupported content types", async () => {
  await withStorage(async (storage) => {
    await assert.rejects(
      () => storage.put({ data: Buffer.from("x"), contentType: "application/x-msdownload" }),
      StorageError,
    );
  });
});

test("getStream returns the stored bytes", async () => {
  await withStorage(async (storage) => {
    const data = Buffer.from("streamed contents");
    const object = await storage.put({ data, contentType: "text/plain" });
    const stream = await storage.getStream(object.key);
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString("utf8"), "streamed contents");
  });
});

test("getStream / get throw for a missing object", async () => {
  await withStorage(async (storage) => {
    await assert.rejects(() => storage.getStream("2020/01/missing.pdf"), StorageError);
    await assert.rejects(() => storage.get("2020/01/missing.pdf"), StorageError);
  });
});

test("path traversal keys are rejected", async () => {
  await withStorage(async (storage) => {
    await assert.rejects(() => storage.get("../../etc/passwd"), StorageError);
    await assert.rejects(() => storage.getStream("../../etc/passwd"), StorageError);
  });
});

test("remove deletes an object and is safe to call twice (rollback path)", async () => {
  await withStorage(async (storage) => {
    const object = await storage.put({ data: Buffer.from("%PDF-1.7"), contentType: "application/pdf" });
    await storage.remove(object.key);
    assert.equal(await storage.exists(object.key), false);
    // Removing again must not throw — used when rolling back a failed upload.
    await storage.remove(object.key);
  });
});
