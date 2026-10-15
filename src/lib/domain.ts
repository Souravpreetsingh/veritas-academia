// Domain constants.
//
// Prisma `enum` is not supported on SQLite, so role/status columns are stored
// as String. These unions are the single source of truth for valid values and
// are enforced on every server write. See docs/data-model.md.

export const ROLES = ["STUDENT", "INSTRUCTOR", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export const APPLICATION_STATUSES = [
  "PENDING_REVIEW",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return (
    typeof value === "string" &&
    (APPLICATION_STATUSES as readonly string[]).includes(value)
  );
}

// Request lifecycle. Transitions are validated server-side in a later phase;
// only the allowed values are defined here.
export const REQUEST_STATUSES = [
  "DRAFT",
  "AWAITING_PAYMENT",
  "PAID",
  "ACCEPTED",
  "IN_PROGRESS",
  "REPORT_READY",
  "DELIVERED",
  "COMPLETED",
  "DECLINED",
  "CANCELLED",
  "REFUNDED",
  "DISPUTED",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export function isRequestStatus(value: unknown): value is RequestStatus {
  return (
    typeof value === "string" && (REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

/** Pure authorization decision: is `role` a member of `allowed`? */
export function isRoleAllowed(role: Role, allowed: readonly Role[]): boolean {
  return allowed.includes(role);
}

export const DOCUMENT_STATUSES = ["AVAILABLE", "QUARANTINED", "DELETED"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export function isDocumentStatus(value: unknown): value is DocumentStatus {
  return (
    typeof value === "string" && (DOCUMENT_STATUSES as readonly string[]).includes(value)
  );
}

export const ANALYSIS_JOB_TYPES = ["SIMILARITY", "AI_WRITING"] as const;
export type AnalysisJobType = (typeof ANALYSIS_JOB_TYPES)[number];

export function isAnalysisJobType(value: unknown): value is AnalysisJobType {
  return (
    typeof value === "string" && (ANALYSIS_JOB_TYPES as readonly string[]).includes(value)
  );
}

export const ANALYSIS_JOB_STATUSES = [
  "UNCONFIGURED",
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
] as const;
export type AnalysisJobStatus = (typeof ANALYSIS_JOB_STATUSES)[number];

export function isAnalysisJobStatus(value: unknown): value is AnalysisJobStatus {
  return (
    typeof value === "string" &&
    (ANALYSIS_JOB_STATUSES as readonly string[]).includes(value)
  );
}

// Permitted analysis-job status transitions. A job can only reach COMPLETED
// from PROCESSING, and COMPLETED is terminal — this prevents invalid states
// such as a job that never ran being marked complete.
const ANALYSIS_STATUS_TRANSITIONS: Record<AnalysisJobStatus, readonly AnalysisJobStatus[]> = {
  UNCONFIGURED: ["PENDING", "FAILED"],
  PENDING: ["PROCESSING", "FAILED", "UNCONFIGURED"],
  PROCESSING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: ["PENDING"],
};

export function canTransitionAnalysisStatus(
  from: AnalysisJobStatus,
  to: AnalysisJobStatus,
): boolean {
  return (ANALYSIS_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/** The portal a role is allowed to reach by default. */
export function homePathForRole(role: Role): string {
  switch (role) {
    case "INSTRUCTOR":
      return "/instructor";
    case "ADMIN":
      return "/"; // Administrator portal arrives in a later phase.
    case "STUDENT":
    default:
      return "/student";
  }
}
