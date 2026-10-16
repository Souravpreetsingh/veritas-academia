import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import {
  ALLOWED_CONTENT_TYPES,
  StorageError,
  type PutObjectInput,
  type StorageAdapter,
  type StoredObject,
} from "./types";

// Development-only private local storage.
//
// The root directory must live OUTSIDE the public static directory. Keys are
// randomized (year/month/<uuid>.<ext>) and never derived from user filenames,
// preventing path traversal and filename collisions.

interface LocalStorageOptions {
  root: string;
}

export function createLocalStorage({ root }: LocalStorageOptions): StorageAdapter {
  const absoluteRoot = path.resolve(root);

  function resolveKey(key: string): string {
    const target = path.resolve(absoluteRoot, key);
    // Guard against traversal (e.g. "../../etc/passwd").
    if (target !== absoluteRoot && !target.startsWith(absoluteRoot + path.sep)) {
      throw new StorageError("Invalid storage key.");
    }
    return target;
  }

  function extensionFor(contentType: string): string {
    const ext = ALLOWED_CONTENT_TYPES[contentType];
    if (!ext) {
      throw new StorageError(`Unsupported content type: ${contentType}`);
    }
    return ext;
  }

  return {
    async put({ data, contentType, originalName }: PutObjectInput): Promise<StoredObject> {
      const ext = extensionFor(contentType);
      const now = new Date();
      const prefix = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const key = `${prefix}/${randomUUID()}.${ext}`;
      const target = resolveKey(key);

      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);

      return {
        key,
        sizeBytes: data.byteLength,
        contentType,
        originalName: originalName ?? null,
        createdAt: now,
      };
    },

    async get(key: string): Promise<Buffer> {
      const target = resolveKey(key);
      try {
        return await readFile(target);
      } catch {
        throw new StorageError("Object not found.");
      }
    },

    async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
      const target = resolveKey(key);
      try {
        await stat(target);
      } catch {
        throw new StorageError("Object not found.");
      }
      // Streams from disk rather than buffering the whole file in memory.
      return Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>;
    },

    async exists(key: string): Promise<boolean> {
      try {
        await stat(resolveKey(key));
        return true;
      } catch {
        return false;
      }
    },

    async remove(key: string): Promise<void> {
      try {
        await unlink(resolveKey(key));
      } catch {
        // Deleting a missing object is not an error.
      }
    },
  };
}
