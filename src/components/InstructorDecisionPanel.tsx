"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Accept / decline decision panel for an assigned service request.
//
// The server re-derives the acting instructor, the assignment, the current
// eligibility and the transition on every submission; this UI is only a
// convenience wrapper with an explicit confirmation step. After a successful
// decision the router refreshes so the page reflects the stored status.
export default function InstructorDecisionPanel({
  requestId,
  reference,
  amountLabel,
  deadlineLabel,
}: {
  requestId: string;
  reference: string;
  amountLabel: string;
  deadlineLabel: string | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "confirm-accept" | "decline">("idle");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const reasonLength = reason.trim().length;
  const reasonInvalid = reasonLength > 0 && reasonLength < 10;

  async function decide(action: "accept" | "decline") {
    setSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/instructor/requests/${encodeURIComponent(requestId)}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body:
            action === "decline"
              ? JSON.stringify(reason.trim() === "" ? {} : { reason: reason.trim() })
              : undefined,
        },
      );
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setMessage({ tone: "error", text: payload.error ?? "Could not record the decision." });
        return;
      }
      setMessage({
        tone: "ok",
        text:
          action === "accept"
            ? `Request ${reference} accepted. The quoted total is now locked.`
            : `Request ${reference} declined.`,
      });
      setMode("idle");
      setReason("");
      router.refresh();
    } catch {
      setMessage({ tone: "error", text: "Network error. Please try again." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl bg-surface-container p-6 shadow-2xl relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-secondary to-primary" />
      <div className="text-[11px] font-label uppercase tracking-widest text-on-surface-variant">
        Decision required
      </div>
      <p className="text-[11px] font-body text-on-surface-variant mt-2">
        By accepting you confirm you can deliver the requested service within the displayed scope,
        quoted total and turnaround. Declining keeps the request on record with your decision.
      </p>

      {mode === "idle" ? (
        <div className="flex flex-col gap-2.5 mt-4">
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              setMessage(null);
              setMode("confirm-accept");
            }}
            className="w-full py-2.5 rounded bg-secondary text-on-secondary text-xs font-headline font-bold uppercase tracking-wider hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-base">task_alt</span>
            Accept request
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              setMessage(null);
              setMode("decline");
            }}
            className="w-full py-2.5 rounded border border-error/50 text-error text-xs font-headline font-semibold uppercase tracking-wider hover:bg-error-container/20 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-base">block</span>
            Decline request
          </button>
        </div>
      ) : null}

      {mode === "confirm-accept" ? (
        <div className="mt-4 space-y-3" role="group" aria-label="Confirm acceptance">
          <div className="p-3.5 rounded bg-surface-container-high/70 space-y-2 text-xs font-body">
            <div className="flex items-center justify-between gap-4">
              <span className="text-on-surface-variant font-label">Request</span>
              <span className="text-on-surface font-mono">{reference}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-on-surface-variant font-label">Quoted total</span>
              <span className="text-primary font-bold">{amountLabel}</span>
            </div>
            {deadlineLabel ? (
              <div className="flex items-center justify-between gap-4">
                <span className="text-on-surface-variant font-label">Requested deadline</span>
                <span className="text-on-surface">{deadlineLabel}</span>
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={() => decide("accept")}
              className="w-full py-2.5 rounded bg-gradient-to-r from-secondary to-secondary-container text-on-secondary text-xs font-headline font-bold uppercase tracking-wider hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-opacity flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-base">
                {submitting ? "hourglass_top" : "check_circle"}
              </span>
              {submitting ? "Recording…" : "Confirm acceptance"}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => setMode("idle")}
              className="w-full py-2 rounded border border-outline-variant/50 text-on-surface-variant hover:text-on-surface text-xs font-label uppercase tracking-wider transition-colors"
            >
              Keep reviewing
            </button>
          </div>
        </div>
      ) : null}

      {mode === "decline" ? (
        <div className="mt-4 space-y-3" role="group" aria-label="Decline request">
          <label
            className="block text-xs font-label text-on-surface-variant"
            htmlFor="decline-reason"
          >
            Reason for the student (optional)
          </label>
          <textarea
            id="decline-reason"
            rows={4}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={2000}
            className="w-full bg-surface-container-low border border-outline-variant/50 text-on-surface rounded px-3 py-2 text-sm focus:border-error focus:ring-1 focus:ring-error/40 outline-none"
            placeholder="e.g. The requested deadline is not feasible with the depth this review requires."
          />
          <p className="text-[10px] font-label text-on-surface-variant">
            {reasonInvalid
              ? "Use at least 10 characters, or leave empty to decline without a reason."
              : "This reason is shared with the student on their request."}
          </p>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={submitting || reasonInvalid}
              onClick={() => decide("decline")}
              className="w-full py-2.5 rounded bg-error text-on-error text-xs font-headline font-bold uppercase tracking-wider hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-opacity flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-base">
                {submitting ? "hourglass_top" : "call_missed"}
              </span>
              {submitting ? "Recording…" : "Confirm decline"}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => {
                setMode("idle");
                setReason("");
              }}
              className="w-full py-2 rounded border border-outline-variant/50 text-on-surface-variant hover:text-on-surface text-xs font-label uppercase tracking-wider transition-colors"
            >
              Keep reviewing
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p
          className={`mt-3 text-xs font-body ${message.tone === "ok" ? "text-secondary" : "text-error"}`}
          role="status"
          aria-live="polite"
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
