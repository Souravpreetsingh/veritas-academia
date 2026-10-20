import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/components/Shell";
import PayNowPanel from "@/components/PayNowPanel";
import LlmConsentPanel from "@/components/LlmConsentPanel";
import { requireUserForPage } from "@/lib/session";
import { analysisAvailability } from "@/lib/analysis/index";
import { getStudentRequest } from "@/lib/service-requests";
import { getRequestPaymentSummary } from "@/lib/payments";
import { formatMoney, formatTurnaround } from "@/lib/format";
import { requestStatusMeta } from "@/lib/request-status";

// Request detail + progress timeline.
//
// Shadows the static Stitch screen at `/student/requests/[reference]`. Only the
// signed-in student's own request is rendered; any other reference 404s. The
// timeline shows real milestones only (created, submitted, payment, decision) —
// later stages are presented as locked rather than fabricated. Payment uses the
// real Razorpay checkout (PayNowPanel) and this page only ever reflects
// server-verified state.
//
// Guarded by the student portal layout (STUDENT or ADMIN).

function formatDateTime(value: Date): string {
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function RequestDetailPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const user = await requireUserForPage("/student/my-requests");
  const { reference } = await params;
  const request = await getStudentRequest(user, decodeURIComponent(reference));
  if (!request) notFound();

  const meta = requestStatusMeta(request.status);
  const submitted = request.status !== "DRAFT";
  const payment = await getRequestPaymentSummary(user, request.id);
  const paid =
    payment?.status === "PAID" ||
    request.status === "PAID" ||
    request.status === "ACCEPTED" ||
    request.status === "DECLINED";
  const llmAvailability = analysisAvailability().llmReview;

  return (
    <Shell
      persona="student"
      label="Request Details"
      group="my-requests"
      user={{ name: user.name, role: user.role }}
      mainClassName="relative pt-16 bg-background min-h-screen px-4 sm:px-6 lg:px-8 py-6 w-full"
    >
      <div className="relative w-full overflow-hidden pb-12 max-w-6xl">
        <div className="pointer-events-none absolute -top-24 right-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl -z-10" />

        <div className="flex flex-wrap items-center justify-between gap-4 pb-6">
          <div className="flex items-center gap-3">
            <Link
              href="/student/my-requests"
              className="group inline-flex items-center gap-2 px-3.5 py-1.5 rounded bg-surface-container-high hover:bg-surface-variant text-on-surface-variant hover:text-secondary transition-all text-xs font-label uppercase tracking-wider"
            >
              <span className="material-symbols-outlined text-sm transition-transform group-hover:-translate-x-1">
                arrow_back
              </span>
              My Requests
            </Link>
            <span className="font-mono text-xs text-secondary">{request.reference}</span>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-label border ${meta.className}`}
          >
            <span className="material-symbols-outlined text-[14px]">{meta.icon}</span>
            {meta.label}
          </span>
        </div>

        <div className="pb-6 space-y-1.5">
          <h1 className="text-2xl lg:text-3xl font-headline font-bold text-on-surface tracking-tight">
            {request.title}
          </h1>
          <p className="text-sm font-body text-on-surface-variant">
            {request.serviceName} · {request.instructorName}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 space-y-6">
            {request.status === "DECLINED" ? (
              <div className="rounded-xl bg-error-container/20 border border-error/40 p-5 space-y-1.5">
                <h2 className="font-headline font-bold text-sm text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-error text-lg">info</span>
                  Declined by {request.instructorName}
                </h2>
                <p className="text-sm font-body text-on-surface whitespace-pre-wrap">
                  {request.declineReason ?? "No reason was provided."}
                </p>
                {request.decisionAt ? (
                  <p className="text-[11px] font-label text-on-surface-variant">
                    Decided {formatDateTime(request.decisionAt)}
                  </p>
                ) : null}
              </div>
            ) : null}

            {/* Progress timeline */}
            <div className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-6 space-y-5">
              <h2 className="font-headline font-bold text-sm text-on-surface flex items-center gap-2">
                <span className="material-symbols-outlined text-secondary text-lg">timeline</span>
                Progress Timeline
              </h2>
              <ol className="space-y-4">
                <TimelineStep
                  done
                  title="Request created"
                  detail={formatDateTime(request.createdAt)}
                />
                <TimelineStep
                  done={submitted}
                  title="Submitted for payment"
                  detail={
                    submitted
                      ? paid
                        ? "Payment received"
                        : "Awaiting payment confirmation"
                      : "Complete the wizard to submit this request"
                  }
                />
                <TimelineStep
                  done={paid}
                  title="Payment confirmed"
                  detail={
                    paid
                      ? payment?.paidAt
                        ? `Verified by the payment provider on ${formatDateTime(payment.paidAt)}`
                        : "Verified by the payment provider"
                      : "Complete the checkout to continue"
                  }
                />
                <TimelineStep
                  done={request.decisionAt !== null}
                  title="Instructor decision"
                  detail={
                    request.decisionAt === null
                      ? "The assigned instructor has not responded yet"
                      : `${request.status === "DECLINED" ? "Declined" : "Accepted"} by ${request.instructorName} on ${formatDateTime(request.decisionAt)}`
                  }
                />
                <TimelineStep
                  done={false}
                  locked
                  title="Fulfilment & delivery"
                  detail="Available in a later phase"
                />
              </ol>
            </div>

            {/* Requirements */}
            <div className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-6 space-y-4">
              <h2 className="font-headline font-bold text-sm text-on-surface">Requirements &amp; scope</h2>
              <p className="text-sm font-body text-on-surface whitespace-pre-wrap">
                {request.instructions ?? "—"}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-2 border-t border-outline-variant/20">
                <Meta label="Turnaround" value={formatTurnaround(request.turnaroundHours)} />
                <Meta label="Service code" value={request.serviceCode} mono />
                <Meta
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

            {/* Documents */}
            <div className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-6 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-headline font-bold text-sm text-on-surface">Documents</h2>
                <span className="text-[11px] font-label text-on-surface-variant">
                  {request.documents.length} file{request.documents.length === 1 ? "" : "s"}
                </span>
              </div>
              {request.documents.length === 0 ? (
                <p className="text-xs font-body text-on-surface-variant">No documents attached.</p>
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
                        <span className="truncate font-body text-on-surface">{doc.originalName}</span>
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
                            <span className="material-symbols-outlined text-[14px]">download</span>
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

            {request.status === "PAID" ||
            request.status === "ACCEPTED" ||
            request.llmProcessingConsentAt ? (
              <LlmConsentPanel
                requestId={request.id}
                consentAt={request.llmProcessingConsentAt}
                consentVersion={request.llmProcessingConsentVersion}
                requestStatus={request.status}
                providerAvailable={llmAvailability.state === "AVAILABLE"}
                providerMessage={llmAvailability.message}
              />
            ) : null}
          </div>

          <div className="lg:col-span-1 lg:sticky lg:top-20 space-y-5">
            <div className="rounded-xl bg-surface-container p-6 shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-secondary to-primary" />
              <div className="text-[11px] font-label uppercase tracking-widest text-on-surface-variant">
                Locked total
              </div>
              <div className="font-headline font-bold text-3xl text-primary mt-1">
                {formatMoney(request.amountMinor, request.currency)}
              </div>

              {request.status === "DRAFT" ? (
                <>
                  <p className="text-[11px] font-body text-on-surface-variant mt-3">
                    This request is still a draft. Review and submit it to move it forward.
                  </p>
                  <div className="mt-4">
                    <Link
                      href={`/student/review-submit?request=${encodeURIComponent(request.id)}`}
                      className="block w-full py-3 rounded-lg bg-surface-container-high hover:bg-surface-variant border border-primary/40 text-center text-xs font-headline font-semibold text-primary transition-colors"
                    >
                      Review &amp; submit
                    </Link>
                  </div>
                </>
              ) : request.status === "AWAITING_PAYMENT" ? (
                <PayNowPanel
                  requestId={request.id}
                  reference={request.reference}
                  amountLabel={formatMoney(request.amountMinor, request.currency)}
                  checkoutActive={payment !== null && payment.status !== "PAID"}
                  lastAttemptFailed={payment?.status === "FAILED"}
                />
              ) : (
                <div className="mt-4 space-y-3">
                  <p className="text-[11px] font-body text-on-surface-variant">
                    {request.status === "DECLINED"
                      ? "This request was declined by the instructor after payment was received. Refund handling is not part of this phase."
                      : request.status === "PAID"
                        ? `Payment confirmed${payment?.paidAt ? ` on ${formatDateTime(payment.paidAt)}` : ""}. The instructor can now review your request.`
                        : request.status === "ACCEPTED"
                          ? "Payment confirmed and this request was accepted by the instructor."
                          : "This request is being processed."}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function TimelineStep({
  done,
  locked,
  title,
  detail,
}: {
  done: boolean;
  locked?: boolean;
  title: string;
  detail: string;
}) {
  const tone = done ? "border-secondary text-secondary" : locked ? "border-outline-variant/50 text-on-surface-variant/50" : "border-tertiary text-tertiary";
  const icon = done ? "check_circle" : locked ? "lock" : "pending";
  return (
    <li className="flex items-start gap-3">
      <span
        className={`w-8 h-8 rounded-full border flex items-center justify-center shrink-0 ${tone}`}
      >
        <span className="material-symbols-outlined text-base">{icon}</span>
      </span>
      <div className="pt-0.5">
        <div className={`text-sm font-headline font-semibold ${done ? "text-on-surface" : "text-on-surface-variant"}`}>
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
