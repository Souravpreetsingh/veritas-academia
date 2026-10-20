"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Admin decision panel. Approve, or reject with a required reason. The server
// re-derives the acting administrator and re-validates everything; this UI is
// only a convenience.
export default function AdminDecisionPanel({
  applicationId,
  status,
  isOwnApplication = false,
}: {
  applicationId: string;
  status: string;
  isOwnApplication?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "approve" | "reject">("idle");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  if (status === "PENDING" && isOwnApplication) {
    return (
      <div className="bg-surface-container border border-outline-variant/40 rounded p-5 text-sm text-on-surface-variant">
        This is your own application. Another administrator must review it; you cannot decide it
        yourself.
      </div>
    );
  }

  if (status !== "PENDING") {
    return (
      <div className="bg-surface-container border border-outline-variant/40 rounded p-5 text-sm text-on-surface-variant">
        This application has already been {status.toLowerCase()}. No further action is available.
      </div>
    );
  }

  async function decide(decision: "APPROVE" | "REJECT") {
    setSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/applications/${applicationId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          decision === "REJECT" ? { decision, rejectionReason: reason } : { decision },
        ),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setMessage({ tone: "error", text: data.error ?? "Could not record the decision." });
        // A conflict means the application was already decided elsewhere;
        // re-render so the page reflects the real, current status.
        if (response.status === 409) router.refresh();
        return;
      }
      setMessage({
        tone: "ok",
        text: decision === "APPROVE" ? "Application approved." : "Application rejected.",
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
    <div className="bg-surface-container border border-outline-variant/40 rounded p-5">
      <div className="font-label text-xs uppercase tracking-wider text-on-surface-variant mb-3">
        Decision
      </div>

      {mode === "idle" ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={submitting}
            onClick={() => setMode("approve")}
            className="px-4 py-2 rounded bg-secondary text-on-secondary text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => setMode("reject")}
            className="px-4 py-2 rounded border border-error/50 text-error text-sm font-semibold hover:bg-error-container/20 disabled:opacity-50 transition-colors"
          >
            Reject
          </button>
        </div>
      ) : mode === "approve" ? (
        <div className="space-y-3">
          <p className="text-sm text-on-surface">
            Approve this application? The applicant is promoted to instructor immediately and gains
            access to the instructor workspace.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={submitting}
              onClick={() => decide("APPROVE")}
              className="px-4 py-2 rounded bg-secondary text-on-secondary text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {submitting ? "Approving…" : "Confirm approval"}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => setMode("idle")}
              className="px-4 py-2 rounded border border-outline-variant/50 text-on-surface-variant text-sm hover:text-on-surface transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block text-xs font-label text-on-surface-variant" htmlFor="reason">
            Rejection reason (required)
          </label>
          <textarea
            id="reason"
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full bg-surface-container-low border border-outline-variant/50 text-on-surface rounded px-3 py-2 text-sm focus:border-error focus:ring-1 focus:ring-error/40 outline-none"
            placeholder="Explain why this application is being rejected."
          />
          <div className="flex gap-3">
            <button
              type="button"
              disabled={submitting || reason.trim().length < 10}
              onClick={() => decide("REJECT")}
              className="px-4 py-2 rounded bg-error text-on-error text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              Confirm rejection
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("idle");
                setReason("");
              }}
              className="px-4 py-2 rounded border border-outline-variant/50 text-on-surface-variant text-sm hover:text-on-surface transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {message ? (
        <p
          className={`mt-3 text-sm ${message.tone === "ok" ? "text-secondary" : "text-error"}`}
          role="status"
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
