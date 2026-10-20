"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnalysisJobSummary, AnalysisResultSummary } from "@/lib/analysis/jobs";
import type { AnalysisOverview } from "@/lib/analysis/queries";
import type { AnalysisJobStatus, AnalysisJobType } from "@/lib/domain";
import type { LlmObservations, SimilaritySourceMatch } from "@/lib/analysis/types";
import {
  AI_DETECTION_DISCLAIMER,
  LLM_CONSENT_VERSION,
  LLM_OBSERVATION_DISCLAIMER,
  LLM_WRITING_PATTERN_DISCLAIMER,
  LOCAL_CORPUS_DISCLAIMER,
} from "@/lib/analysis/types";

interface AnalysisWorkbenchProps {
  requestId: string;
  overview: AnalysisOverview;
  readOnly: boolean;
}

const ACTIVE_STATUSES: AnalysisJobStatus[] = [
  "PENDING",
  "QUEUED",
  "PROCESSING",
  "RETRYABLE",
];

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusMeta(status: AnalysisJobStatus): {
  label: string;
  className: string;
  icon: string;
} {
  switch (status) {
    case "COMPLETED":
      return {
        label: "Completed",
        className: "border-secondary/40 bg-secondary-container/20 text-secondary",
        icon: "check_circle",
      };
    case "FAILED":
      return {
        label: "Failed",
        className: "border-error/40 bg-error-container/20 text-error",
        icon: "error",
      };
    case "PROCESSING":
      return {
        label: "Processing",
        className: "border-tertiary/40 bg-tertiary-container/20 text-tertiary",
        icon: "progress_activity",
      };
    case "RETRYABLE":
      return {
        label: "Retry scheduled",
        className: "border-tertiary/40 bg-tertiary-container/20 text-tertiary",
        icon: "schedule",
      };
    case "QUEUED":
      return {
        label: "Queued",
        className: "border-tertiary/40 bg-tertiary-container/20 text-tertiary",
        icon: "hourglass_top",
      };
    case "UNCONFIGURED":
      return {
        label: "Not configured",
        className: "border-outline-variant/40 bg-surface-container-high text-on-surface-variant",
        icon: "block",
      };
    case "PENDING":
    default:
      return {
        label: "Awaiting worker",
        className: "border-outline-variant/40 bg-surface-container-high text-on-surface-variant",
        icon: "pending",
      };
  }
}

function StatusBadge({ status }: { status: AnalysisJobStatus }) {
  const meta = statusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] font-label uppercase tracking-wider ${meta.className}`}
    >
      <span className="material-symbols-outlined text-[13px]">{meta.icon}</span>
      {meta.label}
    </span>
  );
}

function UnavailableNotice({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface-container-high/50 p-4 space-y-1.5">
      <div className="flex items-center gap-2 text-xs font-headline font-semibold text-on-surface">
        <span className="material-symbols-outlined text-base text-on-surface-variant">block</span>
        {title}
      </div>
      <p className="text-[11px] font-body text-on-surface-variant">{message}</p>
    </div>
  );
}

function JobState({
  job,
  emptyText,
}: {
  job: AnalysisJobSummary | null;
  emptyText: string;
}) {
  if (!job) {
    return <p className="text-[11px] font-body text-on-surface-variant">{emptyText}</p>;
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={job.status} />
        <span className="text-[10px] font-mono text-on-surface-variant/70">{job.id}</span>
      </div>
      {job.error ? (
        <p className="text-[11px] font-body text-error">
          {job.error.message}
          {job.error.code ? (
            <span className="text-[10px] font-mono text-error/70"> ({job.error.code})</span>
          ) : null}
        </p>
      ) : null}
      {job.status === "PENDING" ? (
        <p className="text-[11px] font-body text-on-surface-variant">
          The job is persisted and waiting for the server-side analysis worker. It is not
          complete yet.
        </p>
      ) : null}
      {job.status === "RETRYABLE" ? (
        <p className="text-[11px] font-body text-on-surface-variant">
          A reversible provider error occurred. The next attempt is scheduled for{" "}
          {formatDateTime(job.nextAttemptAt)}.
        </p>
      ) : null}
      {job.status === "PROCESSING" || job.status === "QUEUED" ? (
        <p className="text-[11px] font-body text-on-surface-variant">
          The worker is processing this job. No result exists until it completes.
        </p>
      ) : null}
      {job.status === "COMPLETED" && !job.result ? (
        <p className="text-[11px] font-body text-error">
          This job is marked complete, but no result record is available. Do not treat it as a
          finding; ask an administrator to check the persisted analysis data.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-body text-on-surface-variant/70">
        <span>Created {formatDateTime(job.createdAt)}</span>
        <span>Attempts {job.attempts}</span>
        {job.completedAt ? <span>Completed {formatDateTime(job.completedAt)}</span> : null}
        {job.failedAt ? <span>Failed {formatDateTime(job.failedAt)}</span> : null}
      </div>
    </div>
  );
}

function MatchList({ matches }: { matches: SimilaritySourceMatch[] }) {
  if (matches.length === 0) {
    return (
      <p className="text-[11px] font-body text-on-surface-variant">
        No matching passages were found by this local matcher.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {matches.length > 25 ? (
        <p className="text-[10px] font-body text-on-surface-variant">
          Showing the first 25 of {matches.length} matched passages. The token-overlap
          total above includes all matches.
        </p>
      ) : null}
      <ul className="space-y-3">
        {matches.slice(0, 25).map((match) => (
        <li
          key={`${match.matchId ?? match.sourceId}-${match.offset}`}
          className="rounded-lg bg-surface-container-high/60 border border-outline-variant/20 p-3 space-y-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            {match.sourceTitle ? (
              <span className="text-xs font-headline font-semibold text-on-surface">
                {match.sourceTitle}
              </span>
            ) : (
              <span className="text-xs font-headline font-semibold text-on-surface">
                Local source
              </span>
            )}
            {match.sourceUrl ? (
              <a
                href={match.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] font-label text-secondary hover:text-primary inline-flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-[13px]">open_in_new</span>
                Source
              </a>
            ) : null}
            <span className="text-[10px] font-mono text-on-surface-variant/60">
              chars {match.offset}–{match.offset + match.length}
            </span>
          </div>
          {match.matchedExcerpt ? (
            <blockquote className="border-l-2 border-secondary/50 pl-3 text-[11px] font-body text-on-surface whitespace-pre-wrap">
              {match.matchedExcerpt}
            </blockquote>
          ) : null}
          {match.sourceExcerpt ? (
            <p className="text-[10px] font-body text-on-surface-variant">
              <span className="font-label uppercase tracking-wider text-on-surface-variant/70">
                Corpus excerpt:{" "}
              </span>
              {match.sourceExcerpt}
            </p>
          ) : null}
        </li>
      ))}
      </ul>
    </div>
  );
}

function SimilarityResult({
  result,
  local,
}: {
  result: AnalysisResultSummary;
  local: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <div className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
            {local ? "Local corpus token overlap" : "Provider similarity"}
          </div>
          <div className="font-headline font-bold text-3xl text-primary">
            {result.similarityPercent === null
              ? "Not reported"
              : `${result.similarityPercent.toFixed(2)}%`}
          </div>
        </div>
        <p className="text-[10px] font-body text-on-surface-variant max-w-sm">
          {local
            ? "Share of extracted word tokens covered by exact normalized 8-token sequences in the bundled public-domain corpus. This is not internet-wide plagiarism detection."
            : "Provider-reported similarity. Review the provider's methodology before relying on it."}
        </p>
      </div>
      {!local && result.metadata?.disclaimer ? (
        <p className="text-[10px] font-body text-on-surface-variant">
          {result.metadata.disclaimer}
        </p>
      ) : null}
      {local && result.metadata ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-body text-on-surface-variant">
          {result.metadata.corpusId ? <span>Corpus: {result.metadata.corpusId}</span> : null}
          {result.metadata.corpusSize !== null ? (
            <span>Sources: {result.metadata.corpusSize}</span>
          ) : null}
          {result.metadata.matchedTokens !== null &&
          result.metadata.totalTokens !== null ? (
            <span>
              Tokens: {result.metadata.matchedTokens}/{result.metadata.totalTokens}
            </span>
          ) : null}
          {result.metadata.shingleSize !== null ? (
            <span>Shingle: {result.metadata.shingleSize}</span>
          ) : null}
        </div>
      ) : null}
      <MatchList matches={result.matches} />
    </div>
  );
}

function LlmResult({ observations }: { observations: LlmObservations }) {
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-tertiary/40 bg-tertiary-container/10 p-3">
        <div className="flex items-center gap-2 text-[10px] font-label uppercase tracking-widest text-tertiary">
          <span className="material-symbols-outlined text-sm">model_training</span>
          Model-generated observations · not verified facts
        </div>
        <p className="text-[11px] font-body text-on-surface-variant mt-1">
          {LLM_OBSERVATION_DISCLAIMER}
        </p>
      </div>

      <div>
        <h4 className="text-xs font-headline font-semibold text-on-surface">Document overview</h4>
        <p className="text-[11px] font-body text-on-surface-variant whitespace-pre-wrap mt-1">
          {observations.documentOverview}
        </p>
      </div>

      <div>
        <h4 className="text-xs font-headline font-semibold text-on-surface">
          Structure and writing quality
        </h4>
        <p className="text-[11px] font-body text-on-surface-variant whitespace-pre-wrap mt-1">
          {observations.structureAndQuality}
        </p>
      </div>

      <div>
        <h4 className="text-xs font-headline font-semibold text-on-surface">
          Writing-pattern observations (AI-writing assistance)
        </h4>
        <p className="text-[10px] font-body text-on-surface-variant mt-1">
          {LLM_WRITING_PATTERN_DISCLAIMER}
        </p>
        {observations.writingPatternObservations.length === 0 ? (
          <p className="text-[11px] font-body text-on-surface-variant mt-2">
            The model reported no writing-pattern observations.
          </p>
        ) : (
          <ul className="space-y-2 mt-2">
            {observations.writingPatternObservations.map((item) => (
              <li
                key={`${item.pattern}-${item.explanation}`}
                className="rounded-lg bg-surface-container-high/60 border border-outline-variant/20 p-3"
              >
                <p className="text-[11px] font-body text-on-surface">{item.pattern}</p>
                <p className="text-[10px] font-body text-on-surface-variant mt-1">
                  {item.explanation}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-xs font-headline font-semibold text-on-surface">
          Passages for citation review
        </h4>
        {observations.citationReview.length === 0 ? (
          <p className="text-[11px] font-body text-on-surface-variant mt-1">
            The model did not identify any locatable citation-review passages.
          </p>
        ) : (
          <ul className="space-y-2 mt-1">
            {observations.citationReview.map((passage) => (
              <li
                key={`${passage.offset}-${passage.length}`}
                className="rounded-lg bg-surface-container-high/60 border border-outline-variant/20 p-3 space-y-1"
              >
                <blockquote className="border-l-2 border-tertiary/50 pl-3 text-[11px] font-body text-on-surface whitespace-pre-wrap">
                  {passage.excerpt}
                </blockquote>
                <p className="text-[10px] font-body text-on-surface-variant">
                  {passage.reason}
                </p>
                <p className="text-[9px] font-mono text-on-surface-variant/60">
                  chars {passage.offset}–{passage.offset + passage.length}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-xs font-headline font-semibold text-on-surface">
          Explanations of supplied local matches
        </h4>
        <p className="text-[10px] font-body text-on-surface-variant mt-1">
          Only matches produced by the local corpus matcher are listed; the model
          cannot search external sources and produces no similarity score.
        </p>
        {observations.matchExplanations.length === 0 ? (
          <p className="text-[11px] font-body text-on-surface-variant mt-1">
            No local matches were supplied, or the model did not explain any.
          </p>
        ) : (
          <ul className="space-y-2 mt-1">
            {observations.matchExplanations.map((explanation) => (
              <li
                key={explanation.matchId}
                className="rounded-lg bg-surface-container-high/60 border border-outline-variant/20 p-3"
              >
                <div className="text-[9px] font-mono text-secondary">{explanation.matchId}</div>
                <p className="text-[11px] font-body text-on-surface-variant mt-1">
                  {explanation.explanation}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-xs font-headline font-semibold text-on-surface">
          Instructor investigation questions
        </h4>
        {observations.instructorQuestions.length === 0 ? (
          <p className="text-[11px] font-body text-on-surface-variant mt-1">
            No questions were generated.
          </p>
        ) : (
          <ul className="list-disc pl-5 space-y-1 mt-1 text-[11px] font-body text-on-surface-variant">
            {observations.instructorQuestions.map((question, index) => (
              <li key={`${index}-${question}`}>{question}</li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-xs font-headline font-semibold text-on-surface">Grounded summary</h4>
        <p className="text-[11px] font-body text-on-surface-variant whitespace-pre-wrap mt-1">
          {observations.reportSummary}
        </p>
      </div>

      <div>
        <h4 className="text-xs font-headline font-semibold text-on-surface">Limitations</h4>
        <ul className="list-disc pl-5 space-y-1 mt-1 text-[11px] font-body text-on-surface-variant">
          {observations.limitations.map((limitation, index) => (
            <li key={`${index}-${limitation}`}>{limitation}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function AnalysisWorkbench({
  requestId,
  overview,
  readOnly,
}: AnalysisWorkbenchProps) {
  const router = useRouter();
  const availableDocuments = useMemo(
    () =>
      overview.documents.filter(
        (document) =>
          document.status === "AVAILABLE" && document.scanStatus === "CLEAN",
      ),
    [overview.documents],
  );
  const [documentId, setDocumentId] = useState(
    availableDocuments[0]?.id ?? overview.documents[0]?.id ?? "",
  );
  const [busy, setBusy] = useState<AnalysisJobType | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  // Derive the active selection so a refresh that adds/removes documents cannot
  // leave the workbench pointing at a stale id. No effect or cascading render
  // is needed: if the stored choice is gone, fall back to the best current one.
  const activeDocumentId = overview.documents.some((document) => document.id === documentId)
    ? documentId
    : (availableDocuments[0]?.id ?? overview.documents[0]?.id ?? "");

  const selectedDocument =
    overview.documents.find((document) => document.id === activeDocumentId) ?? null;
  const selectedDocumentAvailable =
    selectedDocument?.status === "AVAILABLE" && selectedDocument.scanStatus === "CLEAN";
  const latestJobs = overview.latestJobsByDocument[activeDocumentId] ?? {};

  const active = Object.values(overview.latestJobsByDocument).some((byType) =>
    Object.values(byType).some((job) =>
      job ? ACTIVE_STATUSES.includes(job.status) : false,
    ),
  );

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => router.refresh(), 8_000);
    return () => window.clearInterval(timer);
  }, [active, router]);

  const localJob = latestJobs.LOCAL_SIMILARITY ?? null;
  const llmJob = latestJobs.LLM_REVIEW ?? null;
  const specialistSimilarityJob = latestJobs.SIMILARITY ?? null;
  const specialistAiJob = latestJobs.AI_WRITING ?? null;
  const hasConsent =
    overview.llmConsentAt !== null &&
    overview.llmConsentVersion === LLM_CONSENT_VERSION;
  const localAvailable = overview.availability.localSimilarity.state === "AVAILABLE";
  const llmAvailable = overview.availability.llmReview.state === "AVAILABLE";
  const specialistSimilarityAvailable =
    overview.availability.similarity.state === "AVAILABLE";
  const specialistAiAvailable = overview.availability.aiWriting.state === "AVAILABLE";

  async function initiate(type: AnalysisJobType) {
    if (!activeDocumentId || !selectedDocumentAvailable) {
      setMessage({ tone: "error", text: "Select an available document first." });
      return;
    }
    setBusy(type);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/instructor/requests/${encodeURIComponent(requestId)}/analysis`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentId: activeDocumentId, type }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        setMessage({
          tone: "error",
          text:
            typeof payload.error === "string"
              ? payload.error
              : "The analysis job could not be created.",
        });
        return;
      }
      setMessage({
        tone: "ok",
        text:
          type === "LLM_REVIEW"
            ? "LLM review job created. It will run only through the server worker, after the consent, configuration, and integrity checks."
            : type === "LOCAL_SIMILARITY"
              ? "Local corpus similarity job created. It is persisted and awaiting the worker."
              : "Analysis job created. It is persisted and awaiting the worker.",
      });
      router.refresh();
    } catch {
      setMessage({
        tone: "error",
        text: "The analysis request could not be sent. Check your connection and try again.",
      });
    } finally {
      setBusy(null);
    }
  }

  function buttonDisabled(type: AnalysisJobType): boolean {
    if (
      readOnly ||
      !overview.canInitiate ||
      !activeDocumentId ||
      !selectedDocumentAvailable ||
      busy !== null
    ) {
      return true;
    }
    if (type === "LOCAL_SIMILARITY") return !localAvailable;
    if (type === "LLM_REVIEW") return !llmAvailable || !hasConsent;
    if (type === "SIMILARITY") return !specialistSimilarityAvailable;
    return !specialistAiAvailable;
  }

  const runReason = !overview.canInitiate
    ? readOnly
      ? "Administrator support view is read-only."
      : "Analysis becomes available only after verified payment with an eligible assigned instructor and a scanned, available document."
    : !selectedDocument
      ? "No document is attached to this request."
      : !selectedDocumentAvailable
        ? "The selected document is quarantined, deleted, or otherwise unavailable for analysis."
        : null;

  return (
    <section className="rounded-xl bg-surface-container/70 border border-outline-variant/40 p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-headline font-bold text-sm text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-secondary text-lg">analytics</span>
            Document analysis
          </h2>
          <p className="text-[11px] font-body text-on-surface-variant mt-1 max-w-2xl">
            Local corpus similarity, LLM-assisted observations, specialist plagiarism, and
            specialist AI-writing detection are separate capabilities. Nothing is fabricated when
            a provider is unavailable.
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-surface-container-high hover:bg-surface-variant text-on-surface-variant text-[10px] font-label uppercase tracking-wider transition-colors"
        >
          <span className="material-symbols-outlined text-sm">refresh</span>
          Refresh
        </button>
      </div>

      <div className="rounded-lg border border-outline-variant/30 bg-surface-container-high/40 p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
          <label className="block space-y-1.5">
            <span className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
              Document
            </span>
            <select
              value={activeDocumentId}
              onChange={(event) => setDocumentId(event.target.value)}
              disabled={overview.documents.length === 0}
              className="w-full rounded bg-background border border-outline-variant/40 px-3 py-2 text-xs font-body text-on-surface focus:border-secondary outline-none disabled:opacity-60"
            >
              {overview.documents.length === 0 ? (
                <option value="">No documents</option>
              ) : (
                overview.documents.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.originalName} ({formatBytes(document.sizeBytes)})
                    {document.status === "AVAILABLE" && document.scanStatus === "CLEAN"
                      ? ""
                      : " — pending scan"}
                  </option>
                ))
              )}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => initiate("LOCAL_SIMILARITY")}
              disabled={buttonDisabled("LOCAL_SIMILARITY")}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-secondary text-on-secondary text-[10px] font-label uppercase tracking-wider hover:bg-secondary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <span className="material-symbols-outlined text-sm">travel_explore</span>
              {busy === "LOCAL_SIMILARITY" ? "Creating…" : "Local similarity"}
            </button>
            <button
              type="button"
              onClick={() => initiate("LLM_REVIEW")}
              disabled={buttonDisabled("LLM_REVIEW")}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-tertiary text-on-tertiary text-[10px] font-label uppercase tracking-wider hover:bg-tertiary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <span className="material-symbols-outlined text-sm">model_training</span>
              {busy === "LLM_REVIEW" ? "Creating…" : "LLM review"}
            </button>
          </div>
        </div>

        {runReason ? (
          <p className="text-[11px] font-body text-on-surface-variant">{runReason}</p>
        ) : null}
        {!hasConsent ? (
          <p className="text-[11px] font-body text-tertiary">
            LLM review is disabled until the student explicitly allows external LLM processing on
            their request page.
          </p>
        ) : (
          <p className="text-[11px] font-body text-on-surface-variant">
            Student consent recorded {formatDateTime(overview.llmConsentAt)}. Document text may be
            sent to the configured external LLM provider when the job runs. The provider is never
            given storage keys or raw file bytes.
          </p>
        )}
        {!llmAvailable && overview.availability.llmReview.state !== "AVAILABLE" ? (
          <p className="text-[11px] font-body text-on-surface-variant">
            {overview.availability.llmReview.message}
          </p>
        ) : null}
        {message ? (
          <p
            className={`text-[11px] font-body ${message.tone === "ok" ? "text-secondary" : "text-error"}`}
          >
            {message.text}
          </p>
        ) : null}
      </div>

      {/* Local corpus similarity */}
      <div className="rounded-lg border border-outline-variant/30 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-headline font-semibold text-on-surface">
              Local corpus similarity
            </h3>
            <p className="text-[10px] font-body text-on-surface-variant">
              Deterministic local matching only — not internet or academic-database detection.
            </p>
          </div>
          <span
            className={`text-[9px] font-label uppercase tracking-wider px-2 py-0.5 rounded border ${
              localAvailable
                ? "border-secondary/40 text-secondary bg-secondary-container/20"
                : "border-outline-variant/40 text-on-surface-variant"
            }`}
          >
            {localAvailable ? "Available" : "Unavailable"}
          </span>
        </div>
        <p className="text-[10px] font-body text-on-surface-variant">{LOCAL_CORPUS_DISCLAIMER}</p>
        <JobState job={localJob} emptyText="Local corpus similarity has not run yet." />
        {localJob?.status === "COMPLETED" && localJob.result ? (
          <SimilarityResult result={localJob.result} local />
        ) : null}
      </div>

      {/* LLM observations */}
      <div className="rounded-lg border border-tertiary/30 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-headline font-semibold text-on-surface">
              LLM-assisted observations
            </h3>
            <p className="text-[10px] font-body text-on-surface-variant">
              Model observations grounded in extracted text and supplied local matches.
            </p>
          </div>
          <span
            className={`text-[9px] font-label uppercase tracking-wider px-2 py-0.5 rounded border ${
              llmAvailable
                ? "border-tertiary/40 text-tertiary bg-tertiary-container/20"
                : "border-outline-variant/40 text-on-surface-variant"
            }`}
          >
            {llmAvailable
              ? "Configured"
              : overview.availability.llmReview.state === "NOT_CONFIGURED"
                ? "Not configured"
                : "Unavailable"}
          </span>
        </div>
        <p className="text-[10px] font-body text-on-surface-variant">{LLM_OBSERVATION_DISCLAIMER}</p>
        <JobState job={llmJob} emptyText="LLM-assisted review has not run yet." />
        {llmJob?.status === "COMPLETED" && llmJob.result?.observations ? (
          <LlmResult observations={llmJob.result.observations} />
        ) : null}
      </div>

      {/* Specialist plagiarism */}
      <div className="rounded-lg border border-outline-variant/30 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-headline font-semibold text-on-surface">
              Specialist plagiarism provider
            </h3>
            <p className="text-[10px] font-body text-on-surface-variant">
              Separate paid provider integration; not the local corpus matcher.
            </p>
          </div>
          <span className="text-[9px] font-label uppercase tracking-wider px-2 py-0.5 rounded border border-outline-variant/40 text-on-surface-variant">
            {specialistSimilarityAvailable
              ? "Configured"
              : overview.availability.similarity.state === "NOT_CONFIGURED"
                ? "Not configured"
                : "Unavailable"}
          </span>
        </div>
        {!specialistSimilarityAvailable ? (
          <UnavailableNotice
            title="Specialist plagiarism detection is unavailable"
            message="No specialist provider is configured. No score, source, or completed report is shown."
          />
        ) : null}
        <button
          type="button"
          onClick={() => initiate("SIMILARITY")}
          disabled={buttonDisabled("SIMILARITY")}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-secondary text-on-secondary text-[10px] font-label uppercase tracking-wider hover:bg-secondary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <span className="material-symbols-outlined text-sm">travel_explore</span>
          {busy === "SIMILARITY" ? "Creating…" : "Run specialist plagiarism"}
        </button>
        <JobState
          job={specialistSimilarityJob}
          emptyText="No specialist plagiarism job has run."
        />
        {specialistSimilarityJob?.status === "COMPLETED" &&
        specialistSimilarityJob.result ? (
          <SimilarityResult result={specialistSimilarityJob.result} local={false} />
        ) : null}
      </div>

      {/* Specialist AI writing */}
      <div className="rounded-lg border border-outline-variant/30 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-headline font-semibold text-on-surface">
              Specialist AI-writing detection
            </h3>
            <p className="text-[10px] font-body text-on-surface-variant">
              Separate probabilistic provider; never proof of misconduct.
            </p>
          </div>
          <span className="text-[9px] font-label uppercase tracking-wider px-2 py-0.5 rounded border border-outline-variant/40 text-on-surface-variant">
            {specialistAiAvailable
              ? "Configured"
              : overview.availability.aiWriting.state === "NOT_CONFIGURED"
                ? "Not configured"
                : "Unavailable"}
          </span>
        </div>
        {!specialistAiAvailable ? (
          <UnavailableNotice
            title="Specialist AI-writing detection is unavailable"
            message="No specialist AI detector is configured. No likelihood, percentage, or finding is shown."
          />
        ) : null}
        <button
          type="button"
          onClick={() => initiate("AI_WRITING")}
          disabled={buttonDisabled("AI_WRITING")}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-secondary text-on-secondary text-[10px] font-label uppercase tracking-wider hover:bg-secondary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <span className="material-symbols-outlined text-sm">psychology</span>
          {busy === "AI_WRITING" ? "Creating…" : "Run specialist AI detection"}
        </button>
        <JobState job={specialistAiJob} emptyText="No specialist AI-writing job has run." />
        {specialistAiJob?.status === "COMPLETED" && specialistAiJob.result ? (
          <div className="space-y-3">
            <div>
              <div className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
                Provider AI likelihood
              </div>
              <div className="font-headline font-bold text-3xl text-primary">
                {specialistAiJob.result.aiLikelihood === null
                  ? "Not reported"
                  : `${specialistAiJob.result.aiLikelihood.toFixed(2)}%`}
              </div>
            </div>
            <p className="text-[10px] font-body text-on-surface-variant">
              {AI_DETECTION_DISCLAIMER}
            </p>
            {specialistAiJob.result.segments.length > 0 ? (
              <div className="space-y-1">
                <div className="text-[10px] font-label uppercase tracking-widest text-on-surface-variant">
                  Provider-flagged segments
                </div>
                <ul className="space-y-1">
                  {specialistAiJob.result.segments.slice(0, 20).map((segment) => (
                    <li
                      key={`${segment.offset}-${segment.length}`}
                      className="text-[10px] font-mono text-on-surface-variant"
                    >
                      chars {segment.offset}–{segment.offset + segment.length}:{" "}
                      {segment.aiLikelihood === null
                        ? "likelihood not reported"
                        : `${segment.aiLikelihood.toFixed(2)}%`}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
