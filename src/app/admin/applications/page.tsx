import Link from "next/link";
import { requireRole } from "@/lib/session";
import { listInstructorApplications } from "@/lib/instructor-applications";
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/domain";

export const dynamic = "force-dynamic";

const statusStyles: Record<string, string> = {
  PENDING: "text-tertiary border-tertiary/40 bg-tertiary-container/20",
  APPROVED: "text-secondary border-secondary/40 bg-secondary-container/20",
  REJECTED: "text-error border-error/40 bg-error-container/20",
  WITHDRAWN: "text-on-surface-variant border-outline-variant/40 bg-surface-container",
};

function isStatus(value: string | undefined): value is ApplicationStatus {
  return typeof value === "string" && (APPLICATION_STATUSES as readonly string[]).includes(value);
}

// Admin-only instructor-application review queue (filter + pagination).
export default async function AdminApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const { status, page } = await searchParams;
  const user = await requireRole(["ADMIN"]);

  const result = await listInstructorApplications({
    actor: user,
    status: isStatus(status) ? status : undefined,
    page,
    pageSize: 20,
  });

  return (
    <div>
      <h1 className="font-headline text-2xl font-bold text-on-surface mb-1">
        Instructor Applications
      </h1>
      <p className="text-on-surface-variant text-sm mb-6">
        Review and decide instructor applications. {result.total} total.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-5">
        <Link
          href="/admin/applications"
          className={`px-3 py-1.5 rounded border text-xs font-label uppercase tracking-wider transition-colors ${
            !isStatus(status)
              ? "border-primary/60 text-primary bg-primary-container/20"
              : "border-outline-variant/40 text-on-surface-variant hover:text-on-surface"
          }`}
        >
          All
        </Link>
        {APPLICATION_STATUSES.map((value) => (
          <Link
            key={value}
            href={`/admin/applications?status=${value}`}
            className={`px-3 py-1.5 rounded border text-xs font-label uppercase tracking-wider transition-colors ${
              status === value
                ? "border-primary/60 text-primary bg-primary-container/20"
                : "border-outline-variant/40 text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {value}
          </Link>
        ))}
      </div>

      {result.items.length === 0 ? (
        <div className="bg-surface-container border border-outline-variant/40 rounded p-8 text-center text-on-surface-variant text-sm">
          No applications match this filter.
        </div>
      ) : (
        <div className="bg-surface-container border border-outline-variant/40 rounded divide-y divide-outline-variant/20">
          {result.items.map((application) => (
            <Link
              key={application.id}
              href={`/admin/applications/${application.id}`}
              className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-surface-container-high transition-colors"
            >
              <div className="min-w-0">
                <div className="text-sm text-on-surface font-medium truncate">
                  {application.fullName}
                </div>
                <div className="text-xs text-on-surface-variant truncate">{application.email}</div>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <span className="text-xs text-on-surface-variant hidden sm:block">
                  {application.expertise.slice(0, 3).join(", ") || "—"}
                </span>
                <span
                  className={`px-2.5 py-1 rounded border text-[10px] font-label uppercase tracking-wider ${statusStyles[application.status] ?? ""}`}
                >
                  {application.status}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {result.totalPages > 1 ? (
        <div className="flex items-center justify-between mt-5 text-xs text-on-surface-variant">
          <span>
            Page {result.page} of {result.totalPages}
          </span>
          <div className="flex gap-2">
            {result.page > 1 ? (
              <Link
                href={`/admin/applications?${status ? `status=${status}&` : ""}page=${result.page - 1}`}
                className="px-3 py-1.5 rounded border border-outline-variant/40 hover:text-on-surface"
              >
                Previous
              </Link>
            ) : null}
            {result.page < result.totalPages ? (
              <Link
                href={`/admin/applications?${status ? `status=${status}&` : ""}page=${result.page + 1}`}
                className="px-3 py-1.5 rounded border border-outline-variant/40 hover:text-on-surface"
              >
                Next
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
