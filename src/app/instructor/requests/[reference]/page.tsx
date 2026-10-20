import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/components/Shell";
import InstructorDecisionPanel from "@/components/InstructorDecisionPanel";
import AnalysisWorkbench from "@/components/AnalysisWorkbench";
import { requireUserForPage } from "@/lib/session";
import { getAnalysisOverview } from "@/lib/analysis/queries";
import {
  getInstructorRequest,
  loadInstructorActorState,
} from "@/lib/instructor-requests";
import { formatMoney, formatTurnaround } from "@/lib/format";
import { requestStatusMeta } from "@/lib/request-status";
import { canTransitionRequestStatus } from "@/lib/domain";

// Request detail + acceptance workflow.
//
// Shadows the static Stitch screen at `/instructor/requests/[reference]`. Only
// a request genuinely assigned to the signed-in instructor (or an administrator
// visiting for read-only support) is rendered; any other reference 404s.
//
// Guarded by the instructor portal layout (INSTRUCTOR or ADMIN).

function formatDateTime(value: Date): string {
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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

export default async function InstructorRequestDetailPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const user = await requireUserForPage("/instructor/incoming-requests");
  const { reference } = await params;
  const request = await getInstructorRequest(user, decodeURIComponent(reference));
  if (!request) notFound();

  const meta = requestStatusMeta(request.status);
  const submitted = request.status !== "DRAFT";

  // Re-derive the acting instructor's current state for UI gating only — the
  // mutation routes repeat every check server-side.
  const actorState = user.role === "INSTRUCTOR" ? await loadInstructorActorState(user) : null;
  const analysisOverview = await getAnalysisOverview(user, request.id);
  const isAssignedInstructor = actorState?.profile?.id === request.instructorProfileId;
  const decisionOpen =
    canTransitionRequestStatus(request.status, "ACCEPTED") &&
    canTransitionRequestStatus(request.status, "DECLINED");
  const canDecide = isAssignedInstructor && actorState.eligibility.eligible && decisionOpen;

  return (
    <Shell
      persona="instructor"
      label={`Request ${request.reference}`}
      group="incoming-requests"
      user={{ name: user.name, role: user.role }}
      mainClassName="w-full pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6"
    >
      <div className="max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-6">
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/instructor/incoming-requests"
              className="group inline-flex items-center gap-2 px-3.5 py-1.5 rounded bg-surface-container-high hover:bg-surface-variant text-on-surface-variant hover:text-secondary transition-all text-xs font-label uppercase tracking-wider"
            >
              <span className="material-symbols-outlined text-sm transition-transform group-hover:-translate-x-1">
                arrow_back
              </span>
              Incoming Requests
            </Link>
            <span className="font-mono text-xs text-secondary">{request.reference}</span>
          </div>
          <div className="flex items-center gap-3">
            {user.role === "ADMIN" ? (
              <span className="px-2.5 py-1 rounded text-[10px] font-label uppercase tracking-wider border border-tertiary/40 text-tertiary bg-tertiary-container/20">
                Administrator support view
              </span>
            ) : null}
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-label border ${meta.className}`}
            >
              <span className="material-symbols-outlined text-[14px]">{meta.icon}</span>
              {meta.label}
            </span>
          </div>
        </div>

        <div className="pb-6 space-y-1.5">
          <h1 className="text-2xl lg:text-3xl font-headline font-bold text-on-surface tracking-tight">
            {request.title}
          </h1>
          <p className="text-sm font-body text-on-surface-variant">
            {request.serviceName} · {request.serviceCode} · requested by {request.studentName} on{" "}
            {formatDate(request.createdAt)}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 space-y-6">
            {request.status === "DECLINED" ? (
              <div className="rounded-xl bg-error-container/20 border border-error/40 p-5 space-y-1.5">
                <h2 className="font-headline font-bold text-sm text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-error text-lg">block</span>
                  Declined
                  {request.decisionAt ? ` on ${formatDateTime(request.decisionAt)}` : ""}
                </h2>
                {request.declineReason ? (
                  <p className="text-sm font-body text-on-surface whitespace-pre-wrap">
                    Reason shared with the student: {request.declineReason}
                  </p>
                ) : (
                  <p className="text-sm font-body text-on-surface-variant">
                    No reason was provided to the student.
                  </p>
                )}
              </div>
            ) : null}

            {/* Milestones — only timestamps that genuinely exist are shown. */}
            <div className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-6 space-y-5">
              <h2 className="font-headline font-bold text-sm text-on-surface flex items-center gap-2">
                <span className="material-symbols-outlined text-secondary text-lg">timeline</span>
                Milestones
              </h2>
              <ol className="space-y-4">
                <Milestone done title="Request created" detail={formatDateTime(request.createdAt)} />
                <Milestone
                  done={submitted}
                  title="Submitted by the student"
                  detail={submitted ? "Awaiting your decision" : "Still a draft"}
                />
                <Milestone
                  done={request.decisionAt !== null}
                  title="Instructor decision"
                  detail={
                    request.decisionAt === null
                      ? "Not decided yet"
                      : `${request.status === "DECLINED" ? "Declined" : "Accepted"} on ${formatDateTime(request.decisionAt)}`
                  }
                />
              </ol>
            </div>

            {/* Requirements and student instructions */}
            <div className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-6 space-y-4">
              <h2 className="font-headline font-bold text-sm text-on-surface">
                Requirements &amp; student instructions
              </h2>
              <p className="text-sm font-body text-on-surface whitespace-pre-wrap">
                {request.instructions ?? "—"}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-2 border-t border-outline-variant/20">
                <Meta label="Turnaround" value={formatTurnaround(request.turnaroundHours)} />
                <Meta label="Service code" value={request.serviceCode} mono />
                <Meta
                  label="Requested deadline"
                  value={
                    request.deadlineAt ? formatDate(request.deadlineAt) : "Not specified"
                  }
                />
              </div>
            </div>

            {/* Documents — metadata only; downloads use the authorized route. */}
            <div className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-6 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-headline font-bold text-sm text-on-surface">Documents</h2>
                <span className="text-[11px] font-label text-on-surface-variant">
                  {request.documents.length} file{request.documents.length === 1 ? "" : "s"}
                </span>
              </div>
              {request.documents.length === 0 ? (
                <p className="text-xs font-body text-on-surface-variant">
                  No documents were attached to this request.
                </p>
              ) : (
                <ul className="space-y-2">
                  {request.documents.map((doc) => (
                    <li
                      key={doc.id}
                      className="flex items-center justify-between gap-3 p-3 rounded bg-surface-container-high text-xs"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="material-symbols-outlined text-base text-on-surface-variant">
                          description
                        </span>
                        <span className="truncate font-body text-on-surface">
                          {doc.originalName}
                        </span>
                      </span>
                      <span className="flex items-center gap-3 shrink-0">
                        <span className="text-[10px] font-label text-on-surface-variant">
                          {fileSize(doc.sizeBytes)}
                        </span>
                        {doc.status === "AVAILABLE" && doc.scanStatus === "CLEAN" ? (
                          <a
                            href={`/api/documents/${encodeURIComponent(doc.id)}/download`}
                            className="inline-flex items-center gap-1 text-[10px] font-label text-secondary hover:text-primary transition-colors"
                          >
                            <span className="material-symbols-outlined text-[14px]">
                              download
                            </span>
                            Download
                          </a>
                        ) : (
                          <span className="text-[10px] font-label text-tertiary px-1.5 py-0.5 rounded bg-tertiary-container/20 border border-tertiary/30">
                            Pending scan
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {analysisOverview ? (
              <AnalysisWorkbench
                requestId={request.id}
                overview={analysisOverview}
                readOnly={user.role === "ADMIN"}
              />
            ) : null}
          </div>

          <div className="lg:col-span-1 lg:sticky lg:top-20 space-y-5">
            <div className="rounded-xl bg-surface-container p-6 shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-secondary to-primary" />
              <div className="text-[11px] font-label uppercase tracking-widest text-on-surface-variant">
                Quoted total (price snapshot)
              </div>
              <div className="font-headline font-bold text-3xl text-primary mt-1">
                {formatMoney(request.amountMinor, request.currency)}
              </div>
              <p className="text-[11px] font-body text-on-surface-variant mt-2">
                Locked when the request was created from the published service price. Accepting or
                declining never changes it.
              </p>
            </div>

            {user.role === "ADMIN" ? (
              <div className="rounded-xl bg-surface-container border border-outline-variant/40 p-5 text-xs font-body text-on-surface-variant">
                Administrators may review this dossier for support, but accept/decline decisions
                are made by the assigned instructor only.
              </div>
            ) : canDecide ? (
              <InstructorDecisionPanel
                requestId={request.id}
                reference={request.reference}
                amountLabel={formatMoney(request.amountMinor, request.currency)}
                deadlineLabel={request.deadlineAt ? formatDate(request.deadlineAt) : null}
              />
            ) : (
              <div className="rounded-xl bg-surface-container border border-outline-variant/40 p-5 space-y-2">
                <div className="text-[11px] font-label uppercase tracking-widest text-on-surface-variant">
                  Decision
                </div>
                <p className="text-xs font-body text-on-surface-variant">
                  {!actorState?.eligibility.eligible
                    ? "Your instructor account is not currently eligible to accept or decline requests. Decisions are re-checked against your account status on the server."
                    : request.status === "ACCEPTED"
                      ? `You accepted this request${request.decisionAt ? ` on ${formatDateTime(request.decisionAt)}` : ""}.`
                      : request.status === "DECLINED"
                        ? `This request was declined${request.decisionAt ? ` on ${formatDateTime(request.decisionAt)}` : ""}.`
                        : request.status === "AWAITING_PAYMENT"
                          ? "The student has not completed payment yet. You can accept or decline once their payment is verified."
                          : "This request is not currently open for a decision."}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Milestone({
  done,
  title,
  detail,
}: {
  done: boolean;
  title: string;
  detail: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={`w-8 h-8 rounded-full border flex items-center justify-center shrink-0 ${
          done ? "border-secondary text-secondary" : "border-outline-variant/50 text-on-surface-variant/50"
        }`}
      >
        <span className="material-symbols-outlined text-base">
          {done ? "check_circle" : "pending"}
        </span>
      </span>
      <div className="pt-0.5">
        <div
          className={`text-sm font-headline font-semibold ${done ? "text-on-surface" : "text-on-surface-variant"}`}
        >
          {title}
        </div>
        <div className="text-[11px] font-body text-on-surface-variant">{detail}</div>
      </div>
    </li>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant/80 mb-1">
        {label}
      </div>
      <div className={`text-sm text-on-surface ${mono ? "font-mono" : "font-body"}`}>{value}</div>
    </div>
  );
}
