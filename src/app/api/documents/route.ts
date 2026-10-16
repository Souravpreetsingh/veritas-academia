import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { authErrorResponse, jsonError } from "@/lib/api";
import { currentStorageDriver, getStorage, MAX_UPLOAD_BYTES } from "@/lib/storage";
import { sanitizeFilename, validateUpload } from "@/lib/storage/validation";
import { getMalwareScanner } from "@/lib/security/malware";
import { canUploadToRequest } from "@/lib/authorization";
import { statusForScanResult } from "@/lib/documents";
import { recordAuditEvent } from "@/lib/audit";
import { AUDIT_ACTIONS, type Role } from "@/lib/domain";

export const runtime = "nodejs";

// Allow a little multipart framing overhead beyond the raw file limit.
const REQUEST_OVERHEAD_BYTES = 1024 * 1024;
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

  // Reject oversized uploads up front, before buffering the body.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES + REQUEST_OVERHEAD_BYTES) {
    await recordAuditEvent({
      actorId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_UPLOAD_DENIED,
      metadata: { reason: "payload_too_large", declaredLength },
      request,
    });
    return jsonError("The file exceeds the 25 MB limit.", 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
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

  // Quarantine until a real scanner clears it. With no scanner configured, the
  // document is never marked AVAILABLE.
  const scanner = getMalwareScanner();
  const scan = await scanner.scan(buffer, {
    originalName: file.name,
    contentType: validation.contentType,
  });
  const status = statusForScanResult(scan.status);

  try {
    const document = await prisma.document.create({
      data: {
        ownerId: user.id,
        requestId,
        storageDriver: currentStorageDriver(),
        storageKey: stored.key,
        originalName: sanitizeFilename(file.name),
        contentType: validation.contentType,
        sizeBytes: stored.sizeBytes,
        status,
      },
    });

    await recordAuditEvent({
      actorId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_UPLOAD,
      targetType: "Document",
      targetId: document.id,
      metadata: { contentType: validation.contentType, sizeBytes: stored.sizeBytes, status, requestId },
      request,
    });

    return NextResponse.json(
      {
        id: document.id,
        status: document.status,
        originalName: document.originalName,
        contentType: document.contentType,
        sizeBytes: document.sizeBytes,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
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
}
