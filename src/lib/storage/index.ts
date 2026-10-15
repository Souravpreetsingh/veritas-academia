import path from "node:path";
import { readEnv } from "@/lib/env";
import { createLocalStorage } from "./local";
import { StorageError, type StorageAdapter } from "./types";

export * from "./types";

let cached: StorageAdapter | null = null;

/**
 * Resolve the configured storage adapter. Only the local development adapter is
 * implemented; an S3-compatible driver will be added behind this same factory.
 */
export function getStorage(): StorageAdapter {
  if (cached) return cached;

  const driver = readEnv("STORAGE_DRIVER") ?? "local";

  if (driver === "local") {
    const root = readEnv("STORAGE_LOCAL_ROOT") ?? "./private-storage";
    cached = createLocalStorage({ root: path.resolve(process.cwd(), root) });
    return cached;
  }

  throw new StorageError(
    `Storage driver "${driver}" is not implemented. Set STORAGE_DRIVER="local".`,
  );
}
