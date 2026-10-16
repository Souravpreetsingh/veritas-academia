import type { Role } from "@/lib/domain";

// Pure authorization decisions. Kept free of Next.js/Prisma imports so they can
// be unit-tested directly and reused by every route handler.

export interface AuthUser {
  id: string;
  role: Role;
}

export function isRequestOwner(userId: string, request: { studentId: string }): boolean {
  return request.studentId === userId;
}

/** Who may attach a document to a service request: its owner, or an admin. */
export function canUploadToRequest(user: AuthUser, request: { studentId: string }): boolean {
  return user.role === "ADMIN" || isRequestOwner(user.id, request);
}

export interface AccessibleDocument {
  ownerId: string;
  request?: { instructor?: { userId: string } | null } | null;
}

/** Identity-based access: owner, admin, or the instructor assigned to the request. */
export function canAccessDocument(user: AuthUser, document: AccessibleDocument): boolean {
  if (user.role === "ADMIN") return true;
  if (document.ownerId === user.id) return true;
  if (user.role === "INSTRUCTOR" && document.request?.instructor?.userId === user.id) {
    return true;
  }
  return false;
}

/** Quarantined / deleted documents are never downloadable. */
export function isDocumentDownloadable(status: string): boolean {
  return status === "AVAILABLE";
}
