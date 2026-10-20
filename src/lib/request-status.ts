import type { RequestStatus } from "@/lib/domain";

// Presentation metadata for request statuses. Free of server imports so both
// server and client components can use it. These are display labels only — the
// list of valid statuses and their transitions lives in src/lib/domain.ts.

export interface RequestStatusMeta {
  label: string;
  icon: string;
  className: string;
}

const STATUS_META: Record<RequestStatus, RequestStatusMeta> = {
  DRAFT: {
    label: "Draft",
    icon: "edit_note",
    className: "bg-surface-variant text-on-surface-variant border-outline-variant/50",
  },
  AWAITING_PAYMENT: {
    label: "Awaiting Payment",
    icon: "payments",
    className: "bg-tertiary-container/20 text-tertiary border-tertiary/40",
  },
  PAID: {
    label: "Paid",
    icon: "verified",
    className: "bg-secondary/10 text-secondary border-secondary/30",
  },
  ACCEPTED: {
    label: "Accepted",
    icon: "task_alt",
    className: "bg-secondary/10 text-secondary border-secondary/30",
  },
  IN_PROGRESS: {
    label: "In Progress",
    icon: "pending",
    className: "bg-tertiary-container/20 text-tertiary border-tertiary/40",
  },
  REPORT_READY: {
    label: "Report Ready",
    icon: "description",
    className: "bg-primary/10 text-primary border-primary/30",
  },
  DELIVERED: {
    label: "Delivered",
    icon: "inventory",
    className: "bg-secondary/10 text-secondary border-secondary/30",
  },
  COMPLETED: {
    label: "Completed",
    icon: "check_circle",
    className: "bg-secondary/10 text-secondary border-secondary/30",
  },
  DECLINED: {
    label: "Declined",
    icon: "block",
    className: "bg-error-container/20 text-error border-error/40",
  },
  CANCELLED: {
    label: "Cancelled",
    icon: "cancel",
    className: "bg-surface-variant text-on-surface-variant border-outline-variant/50",
  },
  REFUNDED: {
    label: "Refunded",
    icon: "undo",
    className: "bg-surface-variant text-on-surface-variant border-outline-variant/50",
  },
  DISPUTED: {
    label: "Disputed",
    icon: "gavel",
    className: "bg-error-container/20 text-error border-error/40",
  },
};

const FALLBACK: RequestStatusMeta = {
  label: "Unknown",
  icon: "help",
  className: "bg-surface-variant text-on-surface-variant border-outline-variant/50",
};

export function requestStatusMeta(status: string): RequestStatusMeta {
  return STATUS_META[status as RequestStatus] ?? FALLBACK;
}
