// Private document storage interface.
//
// Documents may contain confidential academic work, so storage is abstracted
// behind this interface. Implementations MUST store files outside the public
// static directory and MUST NOT expose public URLs.

export interface StoredObject {
  /** Server-generated, opaque storage key. Never derived from user input. */
  key: string;
  sizeBytes: number;
  contentType: string;
  /** Original filename for display only; never used to build a path. */
  originalName: string | null;
  createdAt: Date;
}

export interface PutObjectInput {
  data: Buffer;
  contentType: string;
  originalName?: string;
}

export interface StorageAdapter {
  /** Persist an object and return its metadata with a randomized key. */
  put(input: PutObjectInput): Promise<StoredObject>;
  /** Read an object by key. Throws StorageError when missing or invalid. */
  get(key: string): Promise<Buffer>;
  /** Stream an object by key without buffering the whole file in memory. */
  getStream(key: string): Promise<ReadableStream<Uint8Array>>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

// Allowed upload types. Enforced on the server when uploads are introduced.
export const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/rtf": "rtf",
  "text/plain": "txt",
  "application/vnd.oasis.opendocument.text": "odt",
};

// 25 MB — matching the existing upload screen's stated limit.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Design for authorized downloads (implemented in a later phase).
 *
 * Files are never served statically. Downloads flow through a route handler
 * that:
 *   1. authenticates the caller (requireUser),
 *   2. loads the document record and verifies ownership / participant rights,
 *   3. streams the object from the storage adapter,
 *   4. writes an audit event.
 *
 * This helper only produces the internal path; it grants no access by itself.
 */
export function authorizedDownloadPath(documentId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}/download`;
}
