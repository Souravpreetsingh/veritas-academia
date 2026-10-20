import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/components/Shell";
import SubmitRequestPanel from "@/components/SubmitRequestPanel";
import { requireUserForPage } from "@/lib/session";
import { getStudentRequestById } from "@/lib/service-requests";
import { formatMoney, formatTurnaround } from "@/lib/format";

// Review & Submit (wizard step 04).
//
// Shadows the static Stitch screen at `/student/review-submit`. Loads the
// signed-in student's own draft by id; a request id that the student does not
// own is answered with a 404 (no ownership disclosure).
//
// Guarded by the student portal layout (STUDENT or ADMIN).

type RawParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function ReviewSubmitPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const user = await requireUserForPage("/student/review-submit");
  if (user.role !== "STUDENT" && user.role !== "ADMIN") notFound();

  const params = await searchParams;
  const requestId = firstValue(params.request);
  const request = requestId ? await getStudentRequestById(user, requestId) : null;

  if (!request) {
    return (
      <Shell
        persona="student"
        label="Review & Submit"
        group="new-service-request"
        user={{ name: user.name, role: user.role }}
        mainClassName="relative pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6 w-full"
      >
        <div className="max-w-2xl rounded-xl bg-surface-container/60 border border-outline-variant/40 p-8 text-center space-y-4">
          <div className="flex items-center justify-center gap-2 text-primary font-headline text-base font-semibold">
            <span className="material-symbols-outlined">receipt_long</span>
            No draft to review
          </div>
          <p className="text-sm font-body text-on-surface-variant">
            Start a new service request to review and submit it here.
          </p>
          <Link
            href="/student/new-service-request"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-on-primary hover:bg-primary-container text-xs font-headline font-semibold transition-colors"
          >
            <span className="material-symbols-outlined text-base">add</span>
            New service request
          </Link>
        </div>
      </Shell>
    );
  }

  const isDraft = request.status === "DRAFT";

  return (
    <Shell
      persona="student"
      label="Review & Submit"
      group="new-service-request"
      user={{ name: user.name, role: user.role }}
      mainClassName="relative pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6 w-full"
    >
      <div className="relative w-full overflow-hidden pb-12 max-w-5xl">
        <div className="pointer-events-none absolute -top-24 right-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl -z-10" />

        <div className="pb-6 space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-label text-on-surface-variant">
            <Link href="/student/my-requests" className="hover:text-secondary transition-colors">
              My Requests
            </Link>
            <span className="text-outline-variant">/</span>
            <span className="text-on-surface font-medium">Review &amp; Submit</span>
          </div>
          <h1 className="text-2xl lg:text-3xl font-headline font-bold text-on-surface tracking-tight">
            Review your request
          </h1>
          <p className="text-sm font-body text-on-surface-variant">
            Confirm the details below. Reference{" "}
            <span className="font-mono text-secondary">{request.reference}</span>.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-6 space-y-5">
              <DetailRow label="Service" value={request.serviceName} />
              <DetailRow label="Instructor" value={request.instructorName} />
              <DetailRow label="Title" value={request.title} />
              <div>
                <div className="text-[11px] font-label uppercase tracking-widest text-on-surface-variant mb-1.5">
                  Requirements &amp; scope
                </div>
                <p className="text-sm font-body text-on-surface whitespace-pre-wrap">
                  {request.instructions ?? "—"}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <DetailRow label="Turnaround" value={formatTurnaround(request.turnaroundHours)} />
                <DetailRow
                  label="Expected deadline"
                  value={
                    request.deadlineAt
                      ? new Date(request.deadlineAt).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })
                      : "Not specified"
                  }
                />
              </div>
            </div>

            <div className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-6 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-headline font-bold text-sm text-on-surface">
                  Attached documents
                </h2>
                <Link
                  href={`/student/requests/${encodeURIComponent(request.reference)}`}
                  className="text-[11px] font-label text-secondary hover:text-primary transition-colors"
                >
                  Manage →
                </Link>
              </div>
              {request.documents.length === 0 ? (
                <p className="text-xs font-body text-on-surface-variant">
                  No documents attached yet. You can attach files from the request detail page.
                </p>
              ) : (
                <ul className="space-y-2">
                  {request.documents.map((doc) => (
                    <li
                      key={doc.id}
                      className="flex items-center justify-between gap-3 p-2.5 rounded bg-surface-container-high text-xs"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="material-symbols-outlined text-base text-on-surface-variant">
                          description
                        </span>
                        <span className="truncate font-body text-on-surface">{doc.originalName}</span>
                      </span>
                      <span className="flex items-center gap-3 shrink-0">
                        <span className="text-[10px] font-label text-on-surface-variant">
                          {fileSize(doc.sizeBytes)}
                        </span>
                        <span
                          className={`text-[10px] font-label px-1.5 py-0.5 rounded ${
                            doc.status === "AVAILABLE" && doc.scanStatus === "CLEAN"
                              ? "bg-secondary/10 text-secondary border border-secondary/30"
                              : "bg-tertiary-container/20 text-tertiary border border-tertiary/30"
                          }`}
                        >
                          {doc.status === "AVAILABLE" && doc.scanStatus === "CLEAN"
                            ? "Scanned"
                            : "Pending scan"}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="lg:col-span-1 lg:sticky lg:top-20 space-y-5">
            <div className="rounded-xl bg-surface-container p-6 shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-secondary to-primary" />
              <div className="text-[11px] font-label uppercase tracking-widest text-on-surface-variant">
                Request total
              </div>
              <div className="font-headline font-bold text-3xl text-primary mt-1">
                {formatMoney(request.amountMinor, request.currency)}
              </div>
              <p className="text-[11px] font-body text-on-surface-variant mt-2">
                Price locked at request creation. Payment is completed securely from the request
                page after submission.
              </p>

              <div className="mt-5 pt-5 border-t border-outline-variant/30">
                {isDraft ? (
                  <SubmitRequestPanel requestId={request.id} reference={request.reference} />
                ) : (
                  <div className="space-y-3 text-center">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-secondary/10 text-secondary border border-secondary/30 text-[11px] font-label">
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                      {request.status.replace(/_/g, " ")}
                    </span>
                    <Link
                      href={`/student/requests/${encodeURIComponent(request.reference)}`}
                      className="block w-full py-3 rounded-lg bg-surface-container-high hover:bg-surface-variant border border-outline-variant/40 text-xs font-headline font-semibold text-on-surface transition-colors"
                    >
                      View request
                    </Link>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl bg-surface-container/60 border border-outline-variant/40 p-4 text-[11px] font-label text-on-surface-variant space-y-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-secondary text-sm">lock</span>
                <span>Your documents stay in the private vault.</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-secondary text-sm">shield</span>
                <span>Only your assigned instructor can access them.</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-label uppercase tracking-widest text-on-surface-variant mb-1">
        {label}
      </div>
      <div className="text-sm font-body text-on-surface">{value}</div>
    </div>
  );
}
