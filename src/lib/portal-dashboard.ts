import { prisma } from "@/lib/db";
import {
  listStudentRequests,
  type ServiceRequestSummary,
} from "@/lib/service-requests";
import {
  listInstructorRequests,
  loadInstructorActorState,
  type InstructorRequestSummary,
} from "@/lib/instructor-requests";
import type { RequestStatus } from "@/lib/domain";
import type { AuthUser } from "@/lib/authorization";

// ---------------------------------------------------------------------------
// Read models for the student and instructor landing dashboards.
//
// Every query is scoped to the authenticated actor in the database layer:
//   * student data is filtered by `studentId`/`ownerId = actor.id`,
//   * instructor data is only returned for an approved, active INSTRUCTOR
//     whose own profile owns the requests (re-checked from the database).
// No figure on a dashboard is derived from any other user's records, and no
// value is fabricated when the underlying data does not exist.
//
// Kept free of `server-only` so the node:test suites can import it directly.
// ---------------------------------------------------------------------------

export interface StudentDocumentSummary {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  status: string;
  scanStatus: string;
  createdAt: Date;
  requestId: string | null;
  requestReference: string | null;
}

/**
 * The signed-in actor's own documents, newest first. Ownership is enforced in
 * the query itself — another user's documents can never be returned.
 */
export async function listStudentDocuments(actor: AuthUser): Promise<StudentDocumentSummary[]> {
  const rows = await prisma.document.findMany({
    where: { ownerId: actor.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      originalName: true,
      contentType: true,
      sizeBytes: true,
      status: true,
      scanStatus: true,
      createdAt: true,
      requestId: true,
      request: { select: { reference: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    originalName: row.originalName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    scanStatus: row.scanStatus,
    createdAt: row.createdAt,
    requestId: row.requestId,
    requestReference: row.request?.reference ?? null,
  }));
}

/** Statuses that no longer need student action. */
const TERMINAL_REQUEST_STATUSES: ReadonlySet<RequestStatus> = new Set([
  "COMPLETED",
  "DECLINED",
  "CANCELLED",
  "REFUNDED",
]);

export interface StudentDashboardData {
  totalRequests: number;
  openRequests: number;
  countsByStatus: Partial<Record<RequestStatus, number>>;
  recentRequests: ServiceRequestSummary[];
  documents: { total: number; pendingScan: number };
}

/** Real, ownership-scoped dashboard data for the signed-in student. */
export async function getStudentDashboard(actor: AuthUser): Promise<StudentDashboardData> {
  const [requests, documentGroups] = await Promise.all([
    listStudentRequests(actor),
    prisma.document.groupBy({
      by: ["status"],
      where: { ownerId: actor.id },
      _count: { _all: true },
    }),
  ]);

  const countsByStatus: Partial<Record<RequestStatus, number>> = {};
  for (const request of requests) {
    countsByStatus[request.status] = (countsByStatus[request.status] ?? 0) + 1;
  }

  let documentTotal = 0;
  let pendingScan = 0;
  for (const group of documentGroups) {
    documentTotal += group._count._all;
    if (group.status === "QUARANTINED") pendingScan += group._count._all;
  }

  return {
    totalRequests: requests.length,
    openRequests: requests.filter((request) => !TERMINAL_REQUEST_STATUSES.has(request.status))
      .length,
    countsByStatus,
    recentRequests: requests.slice(0, 5),
    documents: { total: documentTotal, pendingScan },
  };
}

export interface InstructorDashboardData {
  /** True only for an approved, active, non-suspended INSTRUCTOR. */
  eligible: boolean;
  /** Human-readable reasons the account is not eligible (empty when eligible). */
  reasons: string[];
  profile: { id: string; isApproved: boolean; isActive: boolean } | null;
  /** Real counts per status across all requests assigned to this instructor. */
  counts: Partial<Record<RequestStatus, number>>;
  recentRequests: InstructorRequestSummary[];
  totalAssigned: number;
}

/**
 * Real, role- and eligibility-gated dashboard data for the signed-in
 * instructor. A student, administrator, suspended account, or unapproved /
 * inactive instructor profile receives no instructor data at all.
 */
export async function getInstructorDashboard(
  actor: AuthUser,
): Promise<InstructorDashboardData> {
  const state = await loadInstructorActorState(actor);

  if (
    !state ||
    state.role !== "INSTRUCTOR" ||
    !state.profile ||
    !state.eligibility.eligible
  ) {
    return {
      eligible: false,
      reasons: state?.eligibility.reasons ?? ["Account not found."],
      profile: state?.profile ?? null,
      counts: {},
      recentRequests: [],
      totalAssigned: 0,
    };
  }

  const list = await listInstructorRequests({
    actor,
    query: { status: null, page: 1, pageSize: 5 },
  });

  return {
    eligible: true,
    reasons: [],
    profile: state.profile,
    counts: list.counts,
    recentRequests: list.items,
    totalAssigned: list.total,
  };
}
