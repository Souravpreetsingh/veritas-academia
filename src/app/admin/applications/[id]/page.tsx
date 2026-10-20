import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/session";
import { getInstructorApplication } from "@/lib/instructor-applications";
import { AppError } from "@/lib/app-errors";
import AdminDecisionPanel from "@/components/AdminDecisionPanel";

export const dynamic = "force-dynamic";

const statusStyles: Record<string, string> = {
  PENDING: "text-tertiary border-tertiary/40 bg-tertiary-container/20",
  APPROVED: "text-secondary border-secondary/40 bg-secondary-container/20",
  REJECTED: "text-error border-error/40 bg-error-container/20",
  WITHDRAWN: "text-on-surface-variant border-outline-variant/40 bg-surface-container",
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

// Admin-only application detail + decision panel.
export default async function AdminApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireRole(["ADMIN"]);

  let application;
  try {
    application = await getInstructorApplication({ actor: user, applicationId: id });
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  return (
    <div className="max-w-3xl">
      <Link href="/admin/applications" className="text-xs text-on-surface-variant hover:text-on-surface">
        ← Back to queue
      </Link>

      <div className="flex items-center justify-between gap-4 mt-3 mb-6">
        <h1 className="font-headline text-2xl font-bold text-on-surface">{application.fullName}</h1>
        <span
          className={`px-3 py-1 rounded border text-xs font-label uppercase tracking-wider ${statusStyles[application.status] ?? ""}`}
        >
          {application.status}
        </span>
      </div>

      <div className="bg-surface-container border border-outline-variant/40 rounded p-6 space-y-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-on-surface-variant text-xs mb-1">Email</div>
            <div className="text-on-surface">{application.email}</div>
          </div>
          <div>
            <div className="text-on-surface-variant text-xs mb-1">Phone</div>
            <div className="text-on-surface">{application.phone ?? "—"}</div>
          </div>
          <div>
            <div className="text-on-surface-variant text-xs mb-1">Submitted</div>
            <div className="text-on-surface">{formatDate(application.createdAt)}</div>
          </div>
          <div>
            <div className="text-on-surface-variant text-xs mb-1">Reviewed</div>
            <div className="text-on-surface">{formatDate(application.reviewedAt)}</div>
          </div>
        </div>

        <div>
          <div className="text-on-surface-variant text-xs mb-1">Background & experience</div>
          <p className="text-on-surface text-sm whitespace-pre-wrap">{application.bio}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <div className="text-on-surface-variant text-xs mb-1">Expertise</div>
            <div className="text-on-surface text-sm">
              {application.expertise.length ? application.expertise.join(", ") : "—"}
            </div>
          </div>
          <div>
            <div className="text-on-surface-variant text-xs mb-1">Qualifications</div>
            <div className="text-on-surface text-sm">
              {application.qualifications.length ? application.qualifications.join(", ") : "—"}
            </div>
          </div>
        </div>

        {application.proposedServices.length > 0 ? (
          <div>
            <div className="text-on-surface-variant text-xs mb-2">Proposed services</div>
            <ul className="space-y-1 text-sm text-on-surface">
              {application.proposedServices.map((service, index) => (
                <li key={index}>
                  {service.name} — {(service.amountMinor / 100).toFixed(2)} ({service.turnaroundHours}h)
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {application.rejectionReason ? (
          <div className="border border-error/40 bg-error-container/10 rounded p-4 text-sm">
            <div className="text-error font-label text-xs uppercase tracking-wider mb-1">
              Rejection reason
            </div>
            <p className="text-on-surface">{application.rejectionReason}</p>
          </div>
        ) : null}
      </div>

      <AdminDecisionPanel
        applicationId={application.id}
        status={application.status}
        isOwnApplication={application.userId === user.id}
      />
    </div>
  );
}
