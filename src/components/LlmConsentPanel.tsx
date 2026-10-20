"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LLM_CONSENT_VERSION } from "@/lib/analysis/types";

interface LlmConsentPanelProps {
  requestId: string;
  consentAt: Date | string | null;
  consentVersion: string | null;
  requestStatus: string;
  providerAvailable: boolean;
  providerMessage: string;
}

function formatDateTime(value: Date | string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function LlmConsentPanel({
  requestId,
  consentAt,
  consentVersion,
  requestStatus,
  providerAvailable,
  providerMessage,
}: LlmConsentPanelProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const granted =
    consentAt !== null && consentVersion === LLM_CONSENT_VERSION;
  const outdated = consentAt !== null && !granted;
  const eligibleStatus = requestStatus === "PAID" || requestStatus === "ACCEPTED";

  async function update(consent: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/student/requests/${encodeURIComponent(requestId)}/analysis-consent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ consent }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        setMessage({
          tone: "error",
          text:
            typeof payload.error === "string"
              ? payload.error
              : "Your consent choice could not be saved.",
        });
        return;
      }
      setMessage({
        tone: "ok",
        text: consent
          ? "Consent recorded. LLM-assisted review can now be requested by your assigned instructor."
          : "Consent withdrawn. No new external LLM processing will start for this request.",
      });
      router.refresh();
    } catch {
      setMessage({
        tone: "error",
        text: "The consent choice could not be sent. Check your connection and try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-headline font-bold text-sm text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-secondary text-lg">policy</span>
            LLM-assisted review consent
          </h2>
          <p className="text-[11px] font-body text-on-surface-variant mt-1 max-w-xl">
            Optional. Your assigned instructor can request a language-model review only if you
            explicitly allow it. This is separate from local corpus matching, which runs entirely
            on this server.
          </p>
        </div>
        <span
          className={`text-[9px] font-label uppercase tracking-wider px-2 py-0.5 rounded border ${
            granted
              ? "border-secondary/40 text-secondary bg-secondary-container/20"
              : "border-outline-variant/40 text-on-surface-variant bg-surface-container-high"
          }`}
        >
          {granted ? "Consent granted" : outdated ? "Consent needs renewal" : "No consent"}
        </span>
      </div>

      <div className="rounded-lg border border-outline-variant/30 bg-surface-container-high/40 p-4 space-y-2">
        <p className="text-[11px] font-body text-on-surface">
          If you allow it, the extracted plain text of documents attached to this request and
          short excerpts of local-corpus matches may be sent to the external LLM provider configured
          by the platform. The provider does not receive your storage keys, raw file bytes, payment
          details, or account credentials.
        </p>
        <p className="text-[11px] font-body text-on-surface-variant">
          LLM output is model-generated observation, not verified fact, plagiarism proof, or proof
          of AI authorship. It must be reviewed by your instructor. You may withdraw consent at any
          time; an external request already in progress may still finish, but no new external
          processing will start.
        </p>
        <p className="text-[10px] font-mono text-on-surface-variant/70">
          Notice version: {LLM_CONSENT_VERSION}
          {outdated && consentVersion ? ` (recorded consent: ${consentVersion})` : ""}
        </p>
      </div>

      {outdated ? (
        <p className="text-[11px] font-body text-tertiary">
          The privacy notice has changed since your last consent. Please review it and allow
          external LLM processing again if you still agree.
        </p>
      ) : null}

      {!providerAvailable ? (
        <p className="text-[11px] font-body text-on-surface-variant">
          {providerMessage} You can record your choice once the platform enables external LLM
          processing.
        </p>
      ) : null}

      {!eligibleStatus ? (
        <p className="text-[11px] font-body text-on-surface-variant">
          Consent can be recorded after payment is verified and before the request is declined.
        </p>
      ) : null}

      {granted ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] font-body text-on-surface-variant">
            Recorded {formatDateTime(consentAt)}. Withdrawing stops new external calls but does not
            erase analysis results already produced.
          </p>
          <button
            type="button"
            onClick={() => update(false)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-surface-container-high hover:bg-surface-variant text-on-surface-variant text-[10px] font-label uppercase tracking-wider disabled:opacity-50 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">cancel</span>
            {busy ? "Saving…" : "Withdraw consent"}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] font-body text-on-surface-variant">
            No document text will be sent to an external LLM unless you allow it here.
          </p>
          <button
            type="button"
            onClick={() => update(true)}
            disabled={busy || !providerAvailable || !eligibleStatus}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-secondary text-on-secondary text-[10px] font-label uppercase tracking-wider hover:bg-secondary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <span className="material-symbols-outlined text-sm">verified_user</span>
            {busy ? "Saving…" : "Allow LLM-assisted review"}
          </button>
        </div>
      )}

      {message ? (
        <p
          className={`text-[11px] font-body ${message.tone === "ok" ? "text-secondary" : "text-error"}`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
