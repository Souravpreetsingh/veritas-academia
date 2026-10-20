import Link from "next/link";
import Shell from "@/components/Shell";
import { requireUserForPage } from "@/lib/session";
import {
  INSTRUCTOR_INBOX_PAGE_SIZE_DEFAULT,
  listInstructorRequests,
  parseInstructorRequestQuery,
} from "@/lib/instructor-requests";
import { formatMoney, formatTurnaround } from "@/lib/format";
import { requestStatusMeta } from "@/lib/request-status";
import type { RequestStatus } from "@/lib/domain";

// Incoming Requests (instructor inbox).
//
// Shadows the static Stitch screen at `/instructor/incoming-requests` and lists
// only requests genuinely assigned to the signed-in instructor, newest first.
// Every figure on this page comes from the database — there are no fabricated
// SLA, escrow or workload metrics.
//
// Guarded by the instructor portal layout (INSTRUCTOR or ADMIN). Administrators
// see an empty (read-only) inbox: another instructor's queue is never exposed.

function formatDate(value: Date): string {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const FILTERS: { value: RequestStatus | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "PAID", label: "Ready for decision" },
  { value: "AWAITING_PAYMENT", label: "Awaiting payment" },
  { value: "ACCEPTED", label: "Accepted" },
  { value: "DECLINED", label: "Declined" },
];

export default async function IncomingRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; pageSize?: string }>;
}) {
  const user = await requireUserForPage("/instructor/incoming-requests");
  const params = await searchParams;

  const parsed = parseInstructorRequestQuery(params);
  const query = parsed.ok
    ? parsed.value
    : { status: null, page: 1, pageSize: INSTRUCTOR_INBOX_PAGE_SIZE_DEFAULT };

  const result = await listInstructorRequests({ actor: user, query });

  const awaitingPayment = result.counts.AWAITING_PAYMENT ?? 0;
  const readyForDecision = result.counts.PAID ?? 0;
  const accepted = result.counts.ACCEPTED ?? 0;
  const declined = result.counts.DECLINED ?? 0;

  const filterHref = (status: RequestStatus | null) =>
    status
      ? `/instructor/incoming-requests?status=${encodeURIComponent(status)}`
      : "/instructor/incoming-requests";
  const pageHref = (page: number) =>
    `/instructor/incoming-requests?${query.status ? `status=${query.status}&` : ""}page=${page}`;

  return (
    <Shell
      persona="instructor"
      label="Incoming Requests"
      group="incoming-requests"
      user={{ name: user.name, role: user.role }}
      mainClassName="w-full pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6"
    >
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6">
        <div className="space-y-1.5 max-w-2xl">
          <h1 className="text-2xl font-headline font-bold text-on-surface tracking-tight">
            Incoming Requests
          </h1>
          <p className="text-xs font-body text-on-surface-variant">
            Review requests assigned to you, inspect their requirements and documents, then accept
            or decline each one.
          </p>
        </div>
      </div>

      {/* Real queue counts for this instructor only. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 pb-6">
        <CountCard label="Awaiting payment" value={awaitingPayment} icon="payments" />
        <CountCard label="Ready for decision" value={readyForDecision} icon="pending_actions" />
        <CountCard label="Accepted" value={accepted} icon="task_alt" />
        <CountCard label="Declined" value={declined} icon="block" />
      </div>

      <div className="flex flex-wrap items-center gap-2 pb-5">
        {FILTERS.map((filter) => {
          const active = query.status === filter.value;
          return (
            <Link
              key={filter.label}
              href={filterHref(filter.value)}
              aria-current={active ? "true" : undefined}
              className={`px-3 py-1.5 rounded border text-[11px] font-label uppercase tracking-wider transition-colors ${
                active
                  ? "border-primary/60 text-primary bg-primary-container/20"
                  : "border-outline-variant/40 text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {filter.label}
            </Link>
          );
        })}
      </div>

      {result.items.length === 0 ? (
        <div className="rounded-xl bg-surface-container/50 border border-outline-variant/30 p-10 text-center space-y-3">
          <div className="flex items-center justify-center gap-2 text-primary font-headline text-base font-semibold">
            <span className="material-symbols-outlined">inbox</span>
            {query.status ? "No requests match this filter" : "No requests assigned yet"}
          </div>
          <p className="text-sm font-body text-on-surface-variant">
            {query.status
              ? "Try a different status filter."
              : "When a student commissions one of your services, the request will appear here."}
          </p>
        </div>
      ) : (
        <div className="rounded-xl bg-surface-container/60 border border-outline-variant/40 overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-surface-container-high/70 text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
                  <th className="px-4 py-3 font-semibold">Reference &amp; Scope</th>
                  <th className="px-4 py-3 font-semibold">Student</th>
                  <th className="px-4 py-3 font-semibold">Service</th>
                  <th className="px-4 py-3 font-semibold">Documents</th>
                  <th className="px-4 py-3 font-semibold">Quoted Total</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Submitted</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/20">
                {result.items.map((request) => {
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
                      </td>
                      <td className="px-4 py-4 align-top text-sm font-body text-on-surface">
                        {request.studentName}
                      </td>
                      <td className="px-4 py-4 align-top">
                        <div className="text-xs font-body text-on-surface">
                          {request.serviceName}
                        </div>
                        <div className="text-[11px] font-label text-on-surface-variant flex items-center gap-1 mt-0.5">
                          <span className="material-symbols-outlined text-[12px]">timer</span>
                          {formatTurnaround(request.turnaroundHours)}
                        </div>
                      </td>
                      <td className="px-4 py-4 align-top">
                        <div className="flex items-center gap-1.5 text-xs text-on-surface-variant">
                          <span className="material-symbols-outlined text-base">description</span>
                          {request.documentCount}
                        </div>
                      </td>
                      <td className="px-4 py-4 align-top text-sm font-body text-on-surface">
                        {formatMoney(request.amountMinor, request.currency)}
                      </td>
                      <td className="px-4 py-4 align-top">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-label border ${meta.className}`}
                        >
                          <span className="material-symbols-outlined text-[12px]">{meta.icon}</span>
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-4 py-4 align-top">
                        <div className="text-xs font-body text-on-surface">
                          {formatDate(request.createdAt)}
                        </div>
                        {request.deadlineAt ? (
                          <div className="text-[11px] font-label text-on-surface-variant mt-0.5">
                            Deadline {formatDate(request.deadlineAt)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 align-top text-right">
                        <Link
                          href={`/instructor/requests/${encodeURIComponent(request.reference)}`}
                          className="inline-flex items-center gap-1 text-[11px] font-label text-secondary hover:text-primary transition-colors"
                        >
                          Review
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

      {result.totalPages > 1 ? (
        <div className="flex items-center justify-between mt-5 text-xs text-on-surface-variant">
          <span>
            Page {result.page} of {result.totalPages} · {result.total} request
            {result.total === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            {result.page > 1 ? (
              <Link
                href={pageHref(result.page - 1)}
                className="px-3 py-1.5 rounded border border-outline-variant/40 hover:text-on-surface"
              >
                Previous
              </Link>
            ) : null}
            {result.page < result.totalPages ? (
              <Link
                href={pageHref(result.page + 1)}
                className="px-3 py-1.5 rounded border border-outline-variant/40 hover:text-on-surface"
              >
                Next
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </Shell>
  );
}

function CountCard({ label, value, icon }: { label: string; value: number; icon: string }) {
  return (
    <div className="p-3.5 rounded bg-surface-container border border-outline-variant/30 flex items-center gap-3">
      <span className="material-symbols-outlined text-secondary text-xl">{icon}</span>
      <div>
        <div className="font-headline text-lg font-bold text-on-surface leading-tight">{value}</div>
        <div className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
          {label}
        </div>
      </div>
    </div>
  );
}
