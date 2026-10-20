import Link from "next/link";
import Shell from "@/components/Shell";
import { requireUserForPage } from "@/lib/session";
import { listStudentRequests } from "@/lib/service-requests";
import { formatMoney, formatTurnaround } from "@/lib/format";
import { requestStatusMeta } from "@/lib/request-status";

// My Requests (academic audits dashboard).
//
// Shadows the static Stitch screen at `/student/my-requests` and lists only the
// signed-in student's own requests from the database. There is no fabricated
// reviewer, score, or SLA metric: only real fields.
//
// Guarded by the student portal layout (STUDENT or ADMIN).

function formatDate(value: Date): string {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function MyRequestsPage() {
  const user = await requireUserForPage("/student/my-requests");
  const requests = await listStudentRequests(user);

  return (
    <Shell
      persona="student"
      label="My Requests"
      group="my-requests"
      user={{ name: user.name, role: user.role }}
      mainClassName="relative pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6 w-full"
    >
      <div className="relative w-full overflow-hidden pb-12">
        <div className="pointer-events-none absolute -top-24 right-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl -z-10" />
        <div className="pointer-events-none absolute top-72 -left-20 w-80 h-80 bg-secondary/10 rounded-full blur-3xl -z-10" />

        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 pb-6">
          <div className="space-y-1.5 max-w-2xl">
            <h1 className="text-2xl lg:text-3xl font-headline font-bold text-on-surface tracking-tight">
              My service requests
            </h1>
            <p className="text-sm font-body text-on-surface-variant">
              Track every commissioned audit, its assigned instructor and its current ledger status.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-surface-container border border-outline-variant/40">
              <span className="text-xs font-headline font-semibold text-on-surface">
                {requests.length}
              </span>
              <span className="text-[11px] font-label text-on-surface-variant">
                total request{requests.length === 1 ? "" : "s"}
              </span>
            </div>
            <Link
              href="/student/new-service-request"
              className="flex items-center gap-2 px-3.5 py-2 rounded bg-primary text-on-primary hover:bg-primary-container text-xs font-headline font-semibold transition-colors"
            >
              <span className="material-symbols-outlined text-sm">add</span>
              New request
            </Link>
          </div>
        </div>

        {requests.length === 0 ? (
          <div className="rounded-xl bg-surface-container/50 border border-outline-variant/30 p-10 text-center space-y-4">
            <div className="flex items-center justify-center gap-2 text-primary font-headline text-base font-semibold">
              <span className="material-symbols-outlined">receipt_long</span>
              No requests yet
            </div>
            <p className="text-sm font-body text-on-surface-variant">
              Commission your first audit from an approved instructor to see it tracked here.
            </p>
            <Link
              href="/student/new-service-request"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-on-primary hover:bg-primary-container text-xs font-headline font-semibold transition-colors"
            >
              <span className="material-symbols-outlined text-base">school</span>
              Browse instructors
            </Link>
          </div>
        ) : (
          <div className="rounded-xl bg-surface-container/60 border border-outline-variant/40 overflow-hidden shadow-xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-surface-container-high/70 text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
                    <th className="px-4 py-3 font-semibold">Reference &amp; Scope</th>
                    <th className="px-4 py-3 font-semibold">Documents</th>
                    <th className="px-4 py-3 font-semibold">Faculty Reviewer</th>
                    <th className="px-4 py-3 font-semibold">Ledger Status</th>
                    <th className="px-4 py-3 font-semibold">Timeline &amp; SLA</th>
                    <th className="px-4 py-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant/20">
                  {requests.map((request) => {
                    const meta = requestStatusMeta(request.status);
                    return (
                      <tr key={request.id} className="hover:bg-surface-container-high/40 transition-colors">
                        <td className="px-4 py-4 align-top">
                          <div className="font-mono text-[11px] text-secondary">{request.reference}</div>
                          <div className="text-sm font-headline font-semibold text-on-surface mt-0.5 max-w-xs truncate">
                            {request.title}
                          </div>
                          <div className="text-[11px] font-body text-on-surface-variant mt-0.5">
                            {request.serviceName}
                          </div>
                        </td>
                        <td className="px-4 py-4 align-top">
                          <div className="flex items-center gap-1.5 text-xs text-on-surface-variant">
                            <span className="material-symbols-outlined text-base">description</span>
                            {request.documentCount}
                          </div>
                        </td>
                        <td className="px-4 py-4 align-top text-sm font-body text-on-surface">
                          {request.instructorName}
                        </td>
                        <td className="px-4 py-4 align-top">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-label border ${meta.className}`}
                          >
                            <span className="material-symbols-outlined text-[12px]">{meta.icon}</span>
                            {meta.label}
                          </span>
                          <div className="text-[11px] font-label text-on-surface-variant mt-1.5">
                            {formatMoney(request.amountMinor, request.currency)}
                          </div>
                        </td>
                        <td className="px-4 py-4 align-top">
                          <div className="text-xs font-body text-on-surface">
                            {formatDate(request.createdAt)}
                          </div>
                          <div className="text-[11px] font-label text-on-surface-variant flex items-center gap-1 mt-0.5">
                            <span className="material-symbols-outlined text-[12px]">timer</span>
                            {formatTurnaround(request.turnaroundHours)}
                          </div>
                        </td>
                        <td className="px-4 py-4 align-top text-right">
                          <Link
                            href={`/student/requests/${encodeURIComponent(request.reference)}`}
                            className="inline-flex items-center gap-1 text-[11px] font-label text-secondary hover:text-primary transition-colors"
                          >
                            Details
                            <span className="material-symbols-outlined text-sm">arrow_forward</span>
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}
