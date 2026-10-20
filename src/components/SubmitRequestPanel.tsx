"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Step 04 — review & dispatch. Server validates the transition; this only
// triggers it and reflects the result.

export default function SubmitRequestPanel({
  requestId,
  reference,
}: {
  requestId: string;
  reference: string;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/student/requests/${encodeURIComponent(requestId)}/submit`,
        { method: "POST" },
      );
      const payload = (await response.json().catch(() => ({}))) as { reference?: string; error?: string };
      if (!response.ok) {
        setError(payload.error ?? "Could not submit the request.");
        return;
      }
      router.push(`/student/requests/${encodeURIComponent(payload.reference ?? reference)}`);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3">
      {error ? (
        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-error-container/30 border border-error/40 text-xs text-on-surface">
          <span className="material-symbols-outlined text-error text-base shrink-0">error</span>
          <span>{error}</span>
        </div>
      ) : null}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full py-3.5 px-4 rounded-lg bg-gradient-to-r from-primary to-primary-container hover:from-primary-fixed-dim hover:to-primary text-on-primary disabled:opacity-60 disabled:cursor-not-allowed font-headline font-bold text-xs uppercase tracking-wider transition-all duration-200 shadow-[0_0_20px_rgba(255,45,120,0.4)] flex items-center justify-center gap-2"
      >
        <span className="material-symbols-outlined text-base">
          {submitting ? "hourglass_top" : "send"}
        </span>
        {submitting ? "Submitting…" : "Confirm & submit request"}
      </button>
      <p className="text-[11px] font-label text-on-surface-variant text-center">
        Submitting moves this request to <strong className="text-on-surface">Awaiting Payment</strong>.
        No payment is taken here.
      </p>
    </div>
  );
}
