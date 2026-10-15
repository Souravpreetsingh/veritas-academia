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
