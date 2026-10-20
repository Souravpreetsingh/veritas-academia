import Link from "next/link";
import { requireRole } from "@/lib/session";
import { getAdminOverviewStats, listInstructorApplications } from "@/lib/instructor-applications";

export const dynamic = "force-dynamic";

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return value;
  }
}

// Admin-only overview: real database-backed counts plus the pending queue.
export default async function AdminOverviewPage() {
  const user = await requireRole(["ADMIN"]);

  const stats = await getAdminOverviewStats({ actor: user });
  const pending = await listInstructorApplications({
    actor: user,
    status: "PENDING",
    pageSize: 5,
  });

  const applicationCards = [
    {
      label: "Pending",
      value: stats.applications.pending,
      href: "/admin/applications?status=PENDING",
      tone: "text-tertiary",
    },
    {
      label: "Approved",
      value: stats.applications.approved,
      href: "/admin/applications?status=APPROVED",
      tone: "text-secondary",
    },
    {
      label: "Rejected",
      value: stats.applications.rejected,
      href: "/admin/applications?status=REJECTED",
      tone: "text-error",
    },
    {
      label: "Withdrawn",
      value: stats.applications.withdrawn,
      href: "/admin/applications?status=WITHDRAWN",
      tone: "text-on-surface-variant",
    },
  ];

  const accountCards = [
    { label: "Students", value: stats.accounts.students },
    { label: "Instructors", value: stats.accounts.instructors },
    { label: "Administrators", value: stats.accounts.admins },
  ];

  return (
    <div>
      <h1 className="font-headline text-2xl font-bold text-on-surface mb-1">Admin Overview</h1>
      <p className="text-on-surface-variant text-sm mb-6">
        Instructor application review and platform access at a glance.{" "}
        {stats.applications.total} application{stats.applications.total === 1 ? "" : "s"} on record.
      </p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 mb-8">
        {applicationCards.map((card) => (
          <Link
            key={card.label}
            href={card.href}
            className="bg-surface-container border border-outline-variant/40 rounded p-4 hover:bg-surface-container-high transition-colors"
          >
            <div
              className={`font-label text-[10px] uppercase tracking-widest ${card.tone}`}
            >
              {card.label}
            </div>
            <div className="font-headline text-3xl font-bold text-on-surface mt-2">
              {card.value}
            </div>
          </Link>
        ))}
      </div>

      <div className="flex items-center justify-between gap-4 mb-3">
        <h2 className="font-headline text-lg font-bold text-on-surface">Awaiting review</h2>
        <Link
          href="/admin/applications?status=PENDING"
          className="text-xs font-label text-secondary hover:underline"
        >
          View queue
        </Link>
      </div>

      {pending.items.length === 0 ? (
        <div className="bg-surface-container border border-outline-variant/40 rounded p-8 text-center text-on-surface-variant text-sm mb-8">
          No applications are awaiting review.
        </div>
      ) : (
        <div className="bg-surface-container border border-outline-variant/40 rounded divide-y divide-outline-variant/20 mb-8">
          {pending.items.map((application) => (
            <Link
              key={application.id}
              href={`/admin/applications/${application.id}`}
              className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-surface-container-high transition-colors"
            >
              <div className="min-w-0">
                <div className="text-sm text-on-surface font-medium truncate">
                  {application.fullName}
                </div>
                <div className="text-xs text-on-surface-variant truncate">
                  {application.email}
                </div>
              </div>
              <span className="text-xs text-on-surface-variant shrink-0">
                {formatDate(application.createdAt)}
              </span>
            </Link>
          ))}
        </div>
      )}

      <h2 className="font-headline text-lg font-bold text-on-surface mb-3">Accounts</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        {accountCards.map((card) => (
          <div
            key={card.label}
            className="bg-surface-container border border-outline-variant/40 rounded p-4"
          >
            <div className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant">
              {card.label}
            </div>
            <div className="font-headline text-2xl font-bold text-on-surface mt-2">
              {card.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
