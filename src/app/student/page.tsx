import Link from "next/link";
import Shell from "@/components/Shell";
import { requireUserForPage } from "@/lib/session";
import { getStudentDashboard } from "@/lib/portal-dashboard";
import { formatMoney } from "@/lib/format";
import { requestStatusMeta } from "@/lib/request-status";
import type { RequestStatus } from "@/lib/domain";

export const dynamic = "force-dynamic";

// Student dashboard.
//
// Replaces the former static prototype at /student. Every number, request and
// document below belongs to the signed-in account and is read from the
// database on each render; nothing is fabricated and empty states are shown
// when there is no data.
//
// Guarded by the student portal layout (STUDENT or ADMIN).

const STATUS_ORDER: RequestStatus[] = [
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
];

function formatDate(value: Date): string {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function StudentDashboardPage() {
  const user = await requireUserForPage("/student");
  const dashboard = await getStudentDashboard(user);
  const firstName = user.name.trim().split(/\s+/)[0] || user.name;
  const isAdmin = user.role === "ADMIN";

  const statusCounts = STATUS_ORDER.flatMap((status) => {
    const count = dashboard.countsByStatus[status] ?? 0;
    return count > 0 ? [{ status, count }] : [];
  });

  const nextActions: { text: string; href: string; label: string }[] = [];
  const drafts = dashboard.countsByStatus.DRAFT ?? 0;
  const awaitingPayment = dashboard.countsByStatus.AWAITING_PAYMENT ?? 0;
  if (drafts > 0) {
    nextActions.push({
      text: `${drafts} draft request${drafts === 1 ? "" : "s"} still need to be reviewed and submitted.`,
      href: "/student/my-requests",
      label: "Review drafts",
    });
  }
  if (awaitingPayment > 0) {
    nextActions.push({
      text: `${awaitingPayment} request${awaitingPayment === 1 ? "" : "s"} awaiting payment confirmation.`,
      href: "/student/my-requests",
      label: "Open requests",
    });
  }
  if (dashboard.totalRequests === 0) {
    nextActions.push({
      text: "Commission your first audit from an approved instructor.",
      href: "/student/find-faculty",
      label: "Find instructors",
    });
  }

  return (
    <Shell
      persona="student"
      label="Dashboard"
      group="dashboard"
      user={{ name: user.name, role: user.role }}
      mainClassName="relative pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6 w-full"
    >
      <div className="relative w-full overflow-hidden pb-12">
        <div className="pointer-events-none absolute -top-24 right-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl -z-10" />
        <div className="pointer-events-none absolute top-72 -left-20 w-80 h-80 bg-secondary/10 rounded-full blur-3xl -z-10" />

        {isAdmin ? (
          <div className="mb-6 rounded-lg bg-tertiary-container/20 border border-tertiary/30 px-4 py-3 text-xs font-body text-on-surface">
            Administrator support view — this dashboard shows your own account&apos;s data only.
          </div>
        ) : null}

        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 pb-6">
          <div className="space-y-1.5 max-w-2xl">
            <h1 className="text-2xl lg:text-3xl font-headline font-bold text-on-surface tracking-tight">
              Welcome back, {firstName}
            </h1>
            <p className="text-sm font-body text-on-surface-variant">
              Your service requests, documents and next steps — everything here comes from your
              account records.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <Link
              href="/student/find-faculty"
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded bg-surface-container-high border border-outline-variant/40 hover:border-secondary/40 text-xs font-headline font-semibold text-on-surface transition-colors"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-sm">
                school
              </span>
              Find instructors
            </Link>
            <Link
              href="/student/new-service-request"
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded bg-primary text-on-primary hover:bg-primary-container text-xs font-headline font-semibold transition-colors"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-sm">
                add
              </span>
              New request
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 pb-8">
          <StatCard
            label="Open requests"
            value={dashboard.openRequests}
            icon="pending_actions"
            href="/student/my-requests"
          />
          <StatCard
            label="Awaiting payment"
            value={awaitingPayment}
            icon="payments"
            href="/student/my-requests"
          />
          <StatCard
            label="Completed"
            value={dashboard.countsByStatus.COMPLETED ?? 0}
            icon="task_alt"
            href="/student/my-requests"
          />
          <StatCard
            label="Documents"
            value={dashboard.documents.total}
            icon="description"
            href="/student/documents"
            note={
              dashboard.documents.pendingScan > 0
                ? `${dashboard.documents.pendingScan} pending scan`
                : undefined
            }
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-xl bg-surface-container/60 border border-outline-variant/40 overflow-hidden shadow-xl">
              <div className="flex items-center justify-between gap-4 px-4 sm:px-5 py-4 border-b border-outline-variant/30">
                <h2 className="font-headline font-bold text-sm text-on-surface">
                  Recent requests
                </h2>
                <Link
                  href="/student/my-requests"
                  className="text-[11px] font-label text-secondary hover:text-primary transition-colors"
                >
                  View all →
                </Link>
              </div>

              {dashboard.recentRequests.length === 0 ? (
                <div className="p-8 text-center space-y-3">
                  <div className="flex items-center justify-center gap-2 text-primary font-headline text-sm font-semibold">
                    <span aria-hidden="true" className="material-symbols-outlined">
                      receipt_long
                    </span>
                    No service requests yet
                  </div>
                  <p className="text-xs font-body text-on-surface-variant">
                    Commission an audit from an approved instructor to see it tracked here.
                  </p>
                  <Link
                    href="/student/find-faculty"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded bg-primary text-on-primary hover:bg-primary-container text-xs font-headline font-semibold transition-colors"
                  >
                    Browse instructors
                  </Link>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-surface-container-high/70 text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
                        <th className="px-4 py-3 font-semibold">Reference &amp; Title</th>
                        <th className="px-4 py-3 font-semibold">Instructor</th>
                        <th className="px-4 py-3 font-semibold">Status</th>
                        <th className="px-4 py-3 font-semibold">Created</th>
                        <th className="px-4 py-3 font-semibold text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/20">
                      {dashboard.recentRequests.map((request) => {
                        const meta = requestStatusMeta(request.status);
                        return (
                          <tr
                            key={request.id}
                            className="hover:bg-surface-container-high/40 transition-colors"
                          >
                            <td className="px-4 py-4 align-top">
                              <div className="font-mono text-[11px] text-secondary">
                                {request.reference}
                              </div>
                              <div className="text-sm font-headline font-semibold text-on-surface mt-0.5 max-w-xs truncate">
                                {request.title}
                              </div>
                              <div className="text-[11px] font-body text-on-surface-variant mt-0.5">
                                {request.serviceName}
                              </div>
                            </td>
                            <td className="px-4 py-4 align-top text-sm font-body text-on-surface">
                              {request.instructorName}
                            </td>
                            <td className="px-4 py-4 align-top">
                              <span
                                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-label border ${meta.className}`}
                              >
                                <span aria-hidden="true" className="material-symbols-outlined text-[12px]">
                                  {meta.icon}
                                </span>
                                {meta.label}
                              </span>
                              <div className="text-[11px] font-label text-on-surface-variant mt-1.5">
                                {formatMoney(request.amountMinor, request.currency)}
                              </div>
                            </td>
                            <td className="px-4 py-4 align-top text-xs font-body text-on-surface">
                              {formatDate(request.createdAt)}
                            </td>
                            <td className="px-4 py-4 align-top text-right">
                              <Link
                                href={`/student/requests/${encodeURIComponent(request.reference)}`}
                                className="inline-flex items-center gap-1 text-[11px] font-label text-secondary hover:text-primary transition-colors"
                              >
                                Details
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">
                                  arrow_forward
                                </span>
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-5">
            {nextActions.length > 0 ? (
              <div className="rounded-xl bg-surface-container/60 border border-outline-variant/40 p-5 space-y-3">
                <h2 className="font-headline font-bold text-sm text-on-surface flex items-center gap-2">
                  <span aria-hidden="true" className="material-symbols-outlined text-secondary text-lg">
                    flag
                  </span>
                  Next steps
                </h2>
                <ul className="space-y-3">
                  {nextActions.map((action) => (
                    <li key={action.href + action.label} className="space-y-1.5">
                      <p className="text-xs font-body text-on-surface-variant">{action.text}</p>
                      <Link
                        href={action.href}
                        className="inline-flex items-center gap-1 text-[11px] font-label text-secondary hover:text-primary transition-colors"
                      >
                        {action.label}
                        <span aria-hidden="true" className="material-symbols-outlined text-sm">
                          arrow_forward
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {statusCounts.length > 0 ? (
              <div className="rounded-xl bg-surface-container/60 border border-outline-variant/40 p-5 space-y-3">
                <h2 className="font-headline font-bold text-sm text-on-surface">Status breakdown</h2>
                <ul className="space-y-2">
                  {statusCounts.map(({ status, count }) => {
                    const meta = requestStatusMeta(status);
                    return (
                      <li key={status} className="flex items-center justify-between gap-3 text-xs">
                        <span className="flex items-center gap-2 text-on-surface-variant">
                          <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
                            {meta.icon}
                          </span>
                          {meta.label}
                        </span>
                        <span className="font-headline font-semibold text-on-surface">{count}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            <div className="rounded-xl bg-surface-container/60 border border-outline-variant/40 p-5 space-y-3">
              <h2 className="font-headline font-bold text-sm text-on-surface">Your documents</h2>
              <p className="text-xs font-body text-on-surface-variant">
                {dashboard.documents.total === 0
                  ? "No documents uploaded yet. Files you upload stay private to your account."
                  : `${dashboard.documents.total} file${dashboard.documents.total === 1 ? "" : "s"} in your private vault.${
                      dashboard.documents.pendingScan > 0
                        ? ` ${dashboard.documents.pendingScan} awaiting a security scan.`
                        : ""
                    }`}
              </p>
              <Link
                href="/student/documents"
                className="inline-flex items-center gap-1 text-[11px] font-label text-secondary hover:text-primary transition-colors"
              >
                Manage documents
                <span aria-hidden="true" className="material-symbols-outlined text-sm">
                  arrow_forward
                </span>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function StatCard({
  label,
  value,
  icon,
  href,
  note,
}: {
  label: string;
  value: number;
  icon: string;
  href: string;
  note?: string;
}) {
  return (
    <Link
      href={href}
      className="p-3.5 rounded bg-surface-container border border-outline-variant/30 hover:border-secondary/40 transition-colors flex items-center gap-3"
    >
      <span aria-hidden="true" className="material-symbols-outlined text-secondary text-xl">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-headline text-lg font-bold text-on-surface leading-tight">{value}</div>
        <div className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
          {label}
        </div>
        {note ? (
          <div className="text-[10px] font-label text-tertiary mt-0.5">{note}</div>
        ) : null}
      </div>
    </Link>
  );
}
