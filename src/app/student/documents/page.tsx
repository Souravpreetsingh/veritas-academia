import Link from "next/link";
import Shell from "@/components/Shell";
import DocumentUploadPanel from "@/components/DocumentUploadPanel";
import { requireUserForPage } from "@/lib/session";
import { listStudentDocuments } from "@/lib/portal-dashboard";

export const dynamic = "force-dynamic";

// Student documents.
//
// Replaces the former prototype document screens. Lists only the signed-in
// account's own documents (ownership is enforced in the query) and uploads
// through the real POST /api/documents endpoint. Scan status is shown exactly
// as stored: with no malware scanner connected, uploads stay quarantined and
// the page says so instead of implying they are verified.
//
// Guarded by the student portal layout (STUDENT or ADMIN).

function formatDate(value: Date): string {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_META: Record<string, { label: string; className: string }> = {
  AVAILABLE: {
    label: "Scanned",
    className: "bg-secondary/10 text-secondary border-secondary/30",
  },
  QUARANTINED: {
    label: "Pending security scan",
    className: "bg-tertiary-container/20 text-tertiary border-tertiary/30",
  },
  DELETED: {
    label: "Deleted",
    className: "bg-surface-variant text-on-surface-variant border-outline-variant/50",
  },
};

export default async function StudentDocumentsPage() {
  const user = await requireUserForPage("/student/documents");
  const documents = await listStudentDocuments(user);
  const pendingScan = documents.filter(
    (document) =>
      document.status === "QUARANTINED" || document.scanStatus !== "CLEAN",
  ).length;
  const isAdmin = user.role === "ADMIN";

  return (
    <Shell
      persona="student"
      label="Documents"
      group="documents"
      user={{ name: user.name, role: user.role }}
      mainClassName="relative pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6 w-full"
    >
      <div className="relative w-full overflow-hidden pb-12">
        <div className="pointer-events-none absolute -top-24 right-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl -z-10" />

        {isAdmin ? (
          <div className="mb-6 rounded-lg bg-tertiary-container/20 border border-tertiary/30 px-4 py-3 text-xs font-body text-on-surface">
            Administrator support view — this page shows your own account&apos;s documents only.
          </div>
        ) : null}

        <div className="pb-6 space-y-1.5 max-w-2xl">
          <h1 className="text-2xl lg:text-3xl font-headline font-bold text-on-surface tracking-tight">
            Documents
          </h1>
          <p className="text-sm font-body text-on-surface-variant">
            Files are stored in your private vault and are only ever attached to requests you
            commission. Every file passes a security scan before it can be attached.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 lg:order-1 order-2 rounded-xl bg-surface-container/60 border border-outline-variant/40 overflow-hidden shadow-xl">
            <div className="flex items-center justify-between gap-4 px-4 sm:px-5 py-4 border-b border-outline-variant/30">
              <h2 className="font-headline font-bold text-sm text-on-surface">Your files</h2>
              <span className="text-[11px] font-label text-on-surface-variant">
                {documents.length} file{documents.length === 1 ? "" : "s"}
              </span>
            </div>

            {documents.length === 0 ? (
              <div className="p-8 text-center space-y-3">
                <div className="flex items-center justify-center gap-2 text-primary font-headline text-sm font-semibold">
                  <span aria-hidden="true" className="material-symbols-outlined">
                    description
                  </span>
                  No documents yet
                </div>
                <p className="text-xs font-body text-on-surface-variant">
                  Upload your first manuscript to keep it ready for a service request.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-outline-variant/20">
                {documents.map((document) => {
                  const released =
                    document.status === "AVAILABLE" && document.scanStatus === "CLEAN";
                  const effectiveStatus =
                    document.status === "AVAILABLE" && !released
                      ? "QUARANTINED"
                      : document.status;
                  const status = STATUS_META[effectiveStatus] ?? {
                    label: effectiveStatus,
                    className:
                      "bg-surface-variant text-on-surface-variant border-outline-variant/50",
                  };
                  return (
                    <li
                      key={document.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-4"
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <span
                          aria-hidden="true"
                          className="material-symbols-outlined text-on-surface-variant mt-0.5"
                        >
                          description
                        </span>
                        <div className="min-w-0">
                          <div className="text-sm font-body text-on-surface truncate">
                            {document.originalName}
                          </div>
                          <div className="text-[11px] font-label text-on-surface-variant mt-0.5">
                            {fileSize(document.sizeBytes)} · Uploaded {formatDate(document.createdAt)}
                            {document.requestReference ? (
                              <>
                                {" · Request "}
                                <span className="font-mono text-secondary">
                                  {document.requestReference}
                                </span>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-label border ${status.className}`}
                        >
                          {status.label}
                        </span>
                        {released ? (
                          <a
                            href={`/api/documents/${encodeURIComponent(document.id)}/download`}
                            className="inline-flex items-center gap-1 text-[10px] font-label text-secondary hover:text-primary transition-colors"
                          >
                            <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
                              download
                            </span>
                            Download
                          </a>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {pendingScan > 0 ? (
              <div className="px-4 sm:px-5 py-4 border-t border-outline-variant/30 bg-tertiary-container/10">
                <p className="flex items-start gap-2 text-[11px] font-body text-on-surface-variant">
                  <span aria-hidden="true" className="material-symbols-outlined text-tertiary text-sm mt-0.5">
                    shield
                  </span>
                  {pendingScan} file{pendingScan === 1 ? " is" : "s are"} awaiting a malware scan.
                  Quarantined files cannot be attached to a request or downloaded until a scanner
                  clears them. No scanner is connected in this environment yet.
                </p>
              </div>
            ) : null}
          </div>

          <div className="lg:order-2 order-1 space-y-5">
            <DocumentUploadPanel />
            <div className="rounded-xl bg-surface-container/60 border border-outline-variant/40 p-4 text-[11px] font-label text-on-surface-variant space-y-2">
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-secondary text-sm">
                  lock
                </span>
                <span>Only you and the instructor you commission can access an attached file.</span>
              </div>
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="material-symbols-outlined text-secondary text-sm">
                  shield
                </span>
                <span>Downloads are served only after a file is cleared by the scanner.</span>
              </div>
            </div>
            <Link
              href="/student/new-service-request"
              className="inline-flex items-center gap-1 text-[11px] font-label text-secondary hover:text-primary transition-colors"
            >
              Commission a service request
              <span aria-hidden="true" className="material-symbols-outlined text-sm">
                arrow_forward
              </span>
            </Link>
          </div>
        </div>
      </div>
    </Shell>
  );
}
