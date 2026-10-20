import Link from "next/link";
import Shell from "@/components/Shell";
import { requireUserForPage } from "@/lib/session";
import { getInstructorDashboard } from "@/lib/portal-dashboard";
import { formatMoney } from "@/lib/format";
import { requestStatusMeta } from "@/lib/request-status";

export const dynamic = "force-dynamic";

// Instructor dashboard.
//
// Replaces the former static prototype at /instructor. Instructor data is only
// loaded for an approved, active, non-suspended instructor account, and every
// request shown is one genuinely assigned to that instructor. No earnings,
// ratings, availability or performance figures exist in this phase, so none
// are shown.
//
// Guarded by the instructor portal layout (INSTRUCTOR or ADMIN).

function formatDate(value: Date): string {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function InstructorDashboardPage() {
  const user = await requireUserForPage("/instructor");
  const dashboard = await getInstructorDashboard(user);
  const firstName = user.name.trim().split(/\s+/)[0] || user.name;
  const isAdmin = user.role === "ADMIN";

  const readyForDecision = dashboard.counts.PAID ?? 0;
  const awaitingPayment = dashboard.counts.AWAITING_PAYMENT ?? 0;
  const accepted = dashboard.counts.ACCEPTED ?? 0;

  return (
    <Shell
      persona="instructor"
      label="Overview"
      group="overview"
      user={{ name: user.name, role: user.role }}
      mainClassName="w-full pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6"
    >
      <div className="pb-12 max-w-6xl">
        {isAdmin ? (
          <div className="mb-6 rounded-lg bg-tertiary-container/20 border border-tertiary/30 px-4 py-3 text-xs font-body text-on-surface">
            Administrator support view — instructor dashboards show data only for instructor
            accounts.
          </div>
        ) : null}

        {!dashboard.eligible ? (
          <div className="max-w-2xl rounded-xl bg-surface-container/60 border border-outline-variant/40 p-8 space-y-4">
            <div className="flex items-center gap-2 text-tertiary font-headline font-bold">
              <span aria-hidden="true" className="material-symbols-outlined">
                lock
              </span>
              Instructor workspace unavailable
            </div>
            {isAdmin ? (
              <p className="text-sm font-body text-on-surface-variant">
                No instructor profile is linked to this administrator account. Instructor request
                data is never shown in support view.
              </p>
            ) : (
              <>
                <p className="text-sm font-body text-on-surface-variant">
                  Your account is not currently an approved, active instructor, so no instructor
                  data is shown.
                </p>
                {dashboard.reasons.length > 0 ? (
                  <ul className="space-y-1.5">
                    {dashboard.reasons.map((reason) => (
                      <li
                        key={reason}
                        className="flex items-start gap-2 text-xs font-body text-on-surface-variant"
                      >
                        <span aria-hidden="true" className="material-symbols-outlined text-[14px] text-tertiary mt-0.5">
                          info
                        </span>
                        {reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <Link
                  href="/student/instructor-application"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded bg-surface-container-high border border-outline-variant/40 text-xs font-headline font-semibold text-on-surface hover:border-secondary/40 transition-colors"
                >
                  View application status
                </Link>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 pb-6">
              <div className="space-y-1.5 max-w-2xl">
                <h1 className="text-2xl lg:text-3xl font-headline font-bold text-on-surface tracking-tight">
                  Welcome back, {firstName}
                </h1>
                <p className="text-sm font-body text-on-surface-variant">
                  Requests assigned to you and their current state — nothing here is estimated.
                </p>
                {dashboard.profile ? (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-label uppercase tracking-wider bg-secondary/10 text-secondary border border-secondary/30">
                      <span aria-hidden="true" className="material-symbols-outlined text-[12px]">
                        verified
                      </span>
                      Approved
                    </span>
                    {dashboard.profile.isActive ? (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-label uppercase tracking-wider bg-secondary/10 text-secondary border border-secondary/30">
                        <span aria-hidden="true" className="material-symbols-outlined text-[12px]">
                          check_circle
                        </span>
                        Active
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <Link
                href="/instructor/incoming-requests"
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded bg-primary text-on-primary hover:bg-primary-container text-xs font-headline font-semibold transition-colors shrink-0"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-sm">
                  inbox
                </span>
                Open incoming requests
              </Link>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 pb-8">
              <StatCard
                label="Ready for decision"
                value={readyForDecision}
                icon="pending_actions"
                href="/instructor/incoming-requests?status=PAID"
              />
              <StatCard
                label="Awaiting payment"
                value={awaitingPayment}
                icon="payments"
                href="/instructor/incoming-requests?status=AWAITING_PAYMENT"
              />
              <StatCard
                label="Accepted"
                value={accepted}
                icon="task_alt"
                href="/instructor/incoming-requests?status=ACCEPTED"
              />
              <StatCard
                label="Assigned total"
                value={dashboard.totalAssigned}
                icon="assignment"
                href="/instructor/incoming-requests"
              />
            </div>

            <div className="rounded-xl bg-surface-container/60 border border-outline-variant/40 overflow-hidden shadow-xl">
              <div className="flex items-center justify-between gap-4 px-4 sm:px-5 py-4 border-b border-outline-variant/30">
                <h2 className="font-headline font-bold text-sm text-on-surface">
                  Recent assignments
                </h2>
                <Link
                  href="/instructor/incoming-requests"
                  className="text-[11px] font-label text-secondary hover:text-primary transition-colors"
                >
                  View all →
                </Link>
              </div>

              {dashboard.recentRequests.length === 0 ? (
                <div className="p-8 text-center space-y-3">
                  <div className="flex items-center justify-center gap-2 text-primary font-headline text-sm font-semibold">
                    <span aria-hidden="true" className="material-symbols-outlined">
                      inbox
                    </span>
                    No requests assigned yet
                  </div>
                  <p className="text-xs font-body text-on-surface-variant">
                    When a student commissions one of your published services, the request will
                    appear here.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-surface-container-high/70 text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
                        <th className="px-4 py-3 font-semibold">Reference &amp; Scope</th>
                        <th className="px-4 py-3 font-semibold">Student</th>
                        <th className="px-4 py-3 font-semibold">Quoted Total</th>
                        <th className="px-4 py-3 font-semibold">Deadline</th>
                        <th className="px-4 py-3 font-semibold">Status</th>
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
                              {request.studentName}
                            </td>
                            <td className="px-4 py-4 align-top text-sm font-body text-on-surface">
                              {formatMoney(request.amountMinor, request.currency)}
                            </td>
                            <td className="px-4 py-4 align-top text-xs font-body text-on-surface">
                              {request.deadlineAt ? formatDate(request.deadlineAt) : "—"}
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
                            </td>
                            <td className="px-4 py-4 align-top text-right">
                              <Link
                                href={`/instructor/requests/${encodeURIComponent(request.reference)}`}
                                className="inline-flex items-center gap-1 text-[11px] font-label text-secondary hover:text-primary transition-colors"
                              >
                                Review
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
          </>
        )}
      </div>
    </Shell>
  );
}

function StatCard({
  label,
  value,
  icon,
  href,
}: {
  label: string;
  value: number;
  icon: string;
  href: string;
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
      </div>
    </Link>
  );
}
