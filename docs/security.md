# Document security controls

How private academic documents are protected. Files are confidential work, so
they are never public and are only served through authorized routes.

## Storage

- Bytes live in a private store (`src/lib/storage`), **outside** the public
  static directory. Only the local driver is implemented; the interface is
  designed so an S3-compatible driver can be added without changing callers.
- Storage keys are **server-generated** (`year/month/<uuid>.<ext>`) and never
  derived from user filenames, preventing traversal and collisions. Path
  traversal keys are rejected by the adapter (`StorageError`).
- The database stores **metadata only** (`Document`), never file contents.

## Upload — `POST /api/documents`

1. **Authentication & role** — requires a signed-in `STUDENT` or `ADMIN`
   (`requireRole`).
2. **Size** — `Content-Length` is checked before the body is buffered (413 if
   oversized); the parsed file is re-checked against the 25 MB limit.
3. **Type** — the filename extension, the declared MIME type and the file's
   magic-byte signature must all agree and be on the allow-list (PDF, DOC, DOCX,
   ODT, RTF, TXT). A mismatch is rejected (415).
4. **Ownership** — when a `requestId` is supplied, the caller must own the
   request (or be an admin); otherwise 403.
5. **Ordering** — the object is stored first, then metadata is persisted. If the
   database write fails, the stored object is removed so no orphan remains.
6. **Quarantine** — uploaded files start `QUARANTINED`. A file only becomes
   `AVAILABLE` when a real scanner returns `CLEAN`; with no scanner configured
   everything stays quarantined.
7. **Audit** — success and every rejection reason are recorded (no contents).

## Download — `GET /api/documents/[id]/download`

1. **Authentication** — requires a signed-in user (`STUDENT`/`INSTRUCTOR`/
   `ADMIN`).
2. **Authorization** — owner, admin, or the instructor assigned to the linked
   request only. Unauthorized callers get **404** (not 403) so document
   existence is not leaked.
3. **Quarantine** — non-`AVAILABLE` documents are refused with **423**.
4. **Streaming** — the object is streamed from private storage, never buffered
   wholesale and never served statically.
5. **Response hardening** —
   `Content-Disposition: attachment` (no inline execution),
   `Content-Type` restricted to the allow-list (`application/octet-stream`
   otherwise), `X-Content-Type-Options: nosniff`, `Cache-Control: private,
   no-store`.
6. **Audit** — successful and blocked downloads are recorded.

## Audit trail — `AuditEvent`

Security actions are appended to `audit_events` by `src/lib/audit.ts`. Logging
is best-effort (failures never break the request) and stores only non-sensitive
context. `actorId` uses `onDelete: SetNull`, so history is retained after an
account is deleted.

## Not yet implemented (explicit)

- A real malware scanner (`MALWARE_SCANNER` is unconfigured; uploads stay
  quarantined).
- Admin review/quarantine-release workflow.
- At-rest encryption and object-store lifecycle policies.
