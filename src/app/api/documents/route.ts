import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { authErrorResponse, jsonError } from "@/lib/api";
import { currentStorageDriver, getStorage, MAX_UPLOAD_BYTES } from "@/lib/storage";
import { sanitizeFilename, validateUpload } from "@/lib/storage/validation";
import { scanQuarantinedDocument } from "@/lib/document-scan";
import { canUploadToRequest } from "@/lib/authorization";
import { recordAuditEvent } from "@/lib/audit";
import { AUDIT_ACTIONS, type Role } from "@/lib/domain";
import { REQUEST_BODY_LIMITS, readBodyBytesWithLimit } from "@/lib/request-body";
import { guardUpload } from "@/lib/rate-limit-guard";

export const runtime = "nodejs";

const UPLOAD_ROLES: Role[] = ["STUDENT", "ADMIN"];

export async function POST(request: Request) {
  let user;
  try {
    user = await requireRole(UPLOAD_ROLES);
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  // Per-account abuse protection runs before the body is buffered, so a
  // blocked client cannot consume upload bandwidth or spam storage/quarantine.
  const limited = await guardUpload(user.id);
  if (limited) return limited;

  // Reject oversized uploads up front using the advertised length when present.
  // Content-Length is only a hint: the body is still read through a hard byte
  // budget below, because chunked requests can omit or understate it.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > REQUEST_BODY_LIMITS.uploadBytes) {
    await recordAuditEvent({
      actorId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_UPLOAD_DENIED,
      metadata: { reason: "payload_too_large", declaredLength },
      request,
    });
    return jsonError("The file exceeds the 25 MB limit.", 413);
  }

  const requestContentType = request.headers.get("content-type") ?? "";
  if (!requestContentType.toLowerCase().startsWith("multipart/form-data")) {
    return jsonError("Expected multipart/form-data with a file field.", 400);
  }

  // Buffer at most MAX_UPLOAD_BYTES plus multipart framing; never trust the
  // client's declared length alone.
  const body = await readBodyBytesWithLimit(request.body, REQUEST_BODY_LIMITS.uploadBytes);
  if (!body.ok) {
    if (body.reason === "too_large") {
      await recordAuditEvent({
        actorId: user.id,
        action: AUDIT_ACTIONS.DOCUMENT_UPLOAD_DENIED,
        metadata: { reason: "payload_too_large" },
        request,
      });
      return jsonError("The file exceeds the 25 MB limit.", 413);
    }
    return jsonError("Could not read the uploaded file.", 400);
  }

  let form: FormData;
  try {
    form = await new Response(body.bytes, {
      headers: { "content-type": requestContentType },
    }).formData();
  } catch {
    return jsonError("Expected multipart/form-data with a file field.", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError("No file provided.", 400);
  }
  if (file.size === 0) {
    return jsonError("The uploaded file is empty.", 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    await recordAuditEvent({
      actorId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_UPLOAD_DENIED,
      metadata: { reason: "file_too_large", size: file.size },
      request,
    });
    return jsonError("The file exceeds the 25 MB limit.", 413);
  }

  const requestIdRaw = form.get("requestId");
  const requestId = typeof requestIdRaw === "string" && requestIdRaw.trim() !== "" ? requestIdRaw.trim() : null;

  // Ownership: when attaching to a request, the caller must own it (or be admin).
  if (requestId) {
    const serviceRequest = await prisma.serviceRequest.findUnique({ where: { id: requestId } });
    if (!serviceRequest) {
      return jsonError("The specified request was not found.", 404);
    }
    if (!canUploadToRequest(user, serviceRequest)) {
      await recordAuditEvent({
        actorId: user.id,
        action: AUDIT_ACTIONS.DOCUMENT_UPLOAD_DENIED,
        targetType: "ServiceRequest",
        targetId: requestId,
        metadata: { reason: "not_request_owner" },
        request,
      });
      return jsonError("You are not authorized to upload to this request.", 403);
    }
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const validation = validateUpload({
    originalName: file.name,
    declaredContentType: file.type,
    buffer,
  });
  if (!validation.ok || !validation.contentType) {
    await recordAuditEvent({
      actorId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_UPLOAD_DENIED,
      metadata: { reason: "invalid_content", declaredType: file.type, detectedKind: validation.detectedKind },
      request,
    });
    return jsonError(validation.error ?? "Invalid file.", 415);
  }

  // Store first; only persist metadata after storage succeeds.
  let stored;
  try {
    stored = await getStorage().put({
      data: buffer,
      contentType: validation.contentType,
      originalName: file.name,
    });
  } catch (error) {
    console.error("[documents] storage put failed:", error);
    await recordAuditEvent({
      actorId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_UPLOAD_FAILED,
      metadata: { reason: "storage_error" },
      request,
    });
    return jsonError("Failed to store the document. Please try again.", 500);
  }

  const checksumSha256 = createHash("sha256").update(buffer).digest("hex");

  // Persist quarantined metadata first. Only this row's stored bytes may be
  // scanned; the client's content type/name never authorize release.
  let document;
  try {
    document = await prisma.document.create({
      data: {
        ownerId: user.id,
        requestId,
        storageDriver: currentStorageDriver(),
        storageKey: stored.key,
        originalName: sanitizeFilename(file.name),
        contentType: validation.contentType,
        sizeBytes: stored.sizeBytes,
        checksumSha256,
        status: "QUARANTINED",
        scanStatus: "UNSCANNED",
      },
    });
  } catch (error) {
    // Roll back the stored object so no orphaned file is left behind.
    console.error("[documents] metadata persistence failed:", error);
    await getStorage().remove(stored.key).catch(() => undefined);
    await recordAuditEvent({
      actorId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_UPLOAD_FAILED,
      metadata: { reason: "db_error" },
      request,
    });
    return jsonError("Failed to save document metadata. Please try again.", 500);
  }

  await recordAuditEvent({
    actorId: user.id,
    action: AUDIT_ACTIONS.DOCUMENT_UPLOAD,
    targetType: "Document",
    targetId: document.id,
    metadata: {
      contentType: validation.contentType,
      sizeBytes: stored.sizeBytes,
      status: "QUARANTINED",
      scanStatus: "UNSCANNED",
      requestId,
    },
    request,
  });

  // Scan the object that is actually on disk. Every failure leaves the record
  // QUARANTINED; the upload still succeeds so the user is not asked to retry
  // bytes that were stored correctly. A scanner outage must never fail open.
  try {
    await scanQuarantinedDocument({
      documentId: document.id,
      actorId: user.id,
      request,
    });
  } catch (error) {
    console.error("[documents] scan lifecycle failed:", error);
  }

  const finalDocument =
    (await prisma.document.findUnique({
      where: { id: document.id },
      select: {
        id: true,
        status: true,
        scanStatus: true,
        originalName: true,
        contentType: true,
        sizeBytes: true,
      },
    })) ?? document;

  return NextResponse.json(
    {
      id: finalDocument.id,
      status: finalDocument.status,
      scanStatus: finalDocument.scanStatus,
      originalName: finalDocument.originalName,
      contentType: finalDocument.contentType,
      sizeBytes: finalDocument.sizeBytes,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
