import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { authErrorResponse, jsonError } from "@/lib/api";
import { getStorage, StorageError, ALLOWED_CONTENT_TYPES } from "@/lib/storage";
import { sanitizeFilename } from "@/lib/storage/validation";
import { canAccessDocument, isDocumentDownloadable } from "@/lib/authorization";
import { recordAuditEvent } from "@/lib/audit";
import { AUDIT_ACTIONS, type Role } from "@/lib/domain";

export const runtime = "nodejs";

const DOWNLOAD_ROLES: Role[] = ["STUDENT", "INSTRUCTOR", "ADMIN"];

/** Only ever emit an explicitly allow-listed type; never an inline-capable type. */
function safeContentType(contentType: string): string {
  return ALLOWED_CONTENT_TYPES[contentType] ? contentType : "application/octet-stream";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let user;
  try {
    user = await requireRole(DOWNLOAD_ROLES);
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const document = await prisma.document.findUnique({
    where: { id },
    include: { request: { include: { instructor: true } } },
  });
  if (!document) {
    return jsonError("Document not found.", 404);
  }

  // Authorization: owner, admin, or the instructor assigned to the request.
  if (!canAccessDocument(user, document)) {
    await recordAuditEvent({
      actorId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_DOWNLOAD_DENIED,
      targetType: "Document",
      targetId: document.id,
      metadata: { reason: "not_authorized" },
      request,
    });
    // 404 to avoid confirming the existence of another user's document.
    return jsonError("Document not found.", 404);
  }

  // Quarantined / deleted / unscanned documents are never served. Both the
  // document status and the persisted scan state must authorize release.
  if (!isDocumentDownloadable(document)) {
    await recordAuditEvent({
      actorId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_DOWNLOAD_BLOCKED_QUARANTINE,
      targetType: "Document",
      targetId: document.id,
      metadata: { status: document.status, scanStatus: document.scanStatus },
      request,
    });
    return jsonError("This document is not available for download.", 423);
  }

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await getStorage().getStream(document.storageKey);
  } catch (error) {
    if (error instanceof StorageError) {
      return jsonError("Document data is unavailable.", 410);
    }
    throw error;
  }

  await recordAuditEvent({
    actorId: user.id,
    action: AUDIT_ACTIONS.DOCUMENT_DOWNLOAD,
    targetType: "Document",
    targetId: document.id,
    metadata: { contentType: document.contentType, sizeBytes: document.sizeBytes },
    request,
  });

  const headers = new Headers({
    "Content-Type": safeContentType(document.contentType),
    "Content-Length": String(document.sizeBytes),
    "Content-Disposition": `attachment; filename="${sanitizeFilename(document.originalName)}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });

  return new NextResponse(stream, { status: 200, headers });
}
