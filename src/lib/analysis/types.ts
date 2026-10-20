// Provider-independent analysis contracts.
//
// Plagiarism/similarity analysis and AI-writing detection are separate
// capabilities with separate adapters. Provider-specific request/response
// shapes, credentials and raw payloads MUST stay inside an adapter; the core
// only ever sees the normalized types in this file.
//
// No result is ever fabricated. An unconfigured adapter reports
// NOT_CONFIGURED and throws on submit/poll; callers must surface that state
// instead of inventing scores.

import type {
  AnalysisErrorCategory,
  AnalysisJobStatus,
  AnalysisJobType,
} from "@/lib/domain";

export type { AnalysisErrorCategory, AnalysisJobStatus, AnalysisJobType };

// ---------------------------------------------------------------------------
// Provider availability
// ---------------------------------------------------------------------------

export const ANALYSIS_PROVIDER_STATES = [
  "NOT_CONFIGURED",
  "AVAILABLE",
  "UNAVAILABLE",
] as const;
export type AnalysisProviderState = (typeof ANALYSIS_PROVIDER_STATES)[number];

export interface AnalysisProviderStatus {
  providerId: string;
  kind: AnalysisJobType;
  state: AnalysisProviderState;
  /** True only when a real adapter is configured and implemented. */
  configured: boolean;
  /** Safe operator/user-facing message. Never contains credentials. */
  message: string;
}

// ---------------------------------------------------------------------------
// Provider input
// ---------------------------------------------------------------------------

/**
 * Exact input an adapter may receive. `bytes` is obtained by the job service
 * through the private StorageAdapter immediately before submission; storage
 * keys are deliberately NOT part of this contract, so a provider can never
 * reach back into platform storage.
 */
export interface AnalysisProviderInput {
  documentId: string;
  contentType: string;
  bytes: Uint8Array;
  sizeBytes: number;
  checksumSha256: string | null;
  /**
   * Stable key for this job, e.g. "analysis-job:<internal id>". Providers that
   * bill per submission MUST de-duplicate on this value so a retry after a
   * crash cannot create a second billable provider job.
   */
  idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// Normalized output
//
// `null` means "unavailable/not produced". It must never be replaced with 0.
// Offsets and lengths reference the normalized extracted-text coordinate space.
// Reports may retain bounded matched/source excerpts for context, but never the
// full document text.
// ---------------------------------------------------------------------------

export interface NormalizedProviderMetadata {
  providerId: string;
  providerVersion: string | null;
  modelVersion: string | null;
  thresholdPercent: number | null;
  // Optional, allow-listed descriptive metadata. These are deliberately flat
  // scalars/strings so an adapter cannot smuggle a raw payload into the DB.
  corpusId?: string | null;
  corpusSize?: number | null;
  algorithm?: string | null;
  shingleSize?: number | null;
  matchedTokens?: number | null;
  totalTokens?: number | null;
  limitations?: string | null;
  llmDisclaimer?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface SimilaritySourceMatch {
  /** Stable reference used by the LLM review to explain an actual match. */
  matchId?: string | null;
  offset: number;
  length: number;
  /** Per-match similarity, or null when the provider did not score it. */
  similarityPercent: number | null;
  sourceId: string | null;
  sourceTitle: string | null;
  /** Only http(s) URLs are accepted; anything else is normalized to null. */
  sourceUrl: string | null;
  /**
   * Short, bounded excerpts retained for authorized report display. They are
   * never written to logs or audit metadata. `sourceExcerpt` comes from the
   * permitted corpus; `matchedExcerpt` is a short excerpt of the analysed
   * document.
   */
  sourceExcerpt?: string | null;
  matchedExcerpt?: string | null;
}

export interface SimilarityAnalysisResult {
  providerJobId: string;
  /** Overall similarity, or null when unavailable — never a fabricated zero. */
  overallSimilarityPercent: number | null;
  matches: SimilaritySourceMatch[];
  metadata: NormalizedProviderMetadata;
}

export interface AiWritingSegment {
  offset: number;
  length: number;
  /** Per-segment AI likelihood, or null when unavailable. */
  aiLikelihood: number | null;
}

export interface AiWritingAnalysisResult {
  providerJobId: string;
  /** AI likelihood, or null when unavailable — never a fabricated zero. */
  aiLikelihood: number | null;
  segments: AiWritingSegment[];
  metadata: NormalizedProviderMetadata;
}

// ---------------------------------------------------------------------------
// Local corpus similarity
//
// This is deliberately NOT internet-wide or academic-database plagiarism
// detection. It compares normalized word shingles against an explicitly
// configured, legally usable corpus (the bundled public-domain corpus in the
// MVP) and excludes the document itself.
// ---------------------------------------------------------------------------

export interface LocalSimilarityInput {
  documentId: string;
  text: string;
  /** Stable per-job value; also used as the synthetic provider job id. */
  idempotencyKey: string;
}

export interface LocalSimilarityProvider {
  readonly id: string;
  readonly kind: "LOCAL_SIMILARITY";
  status(): AnalysisProviderStatus;
  analyze(input: LocalSimilarityInput): Promise<SimilarityAnalysisResult>;
}

// ---------------------------------------------------------------------------
// LLM-assisted observations
//
// The model provides two clearly separated assistance outputs:
//   * similarity assistance — quote/browse passages for citation review and
//     explanations of actual supplied local matches; it may never claim a
//     source, URL, or similarity score it did not receive from the matcher;
//   * AI-writing assistance — cautious, qualitative writing-pattern
//     observations; never an authorship verdict or a detection score.
// It may also summarise the document, suggest instructor questions and draft a
// grounded report summary. It may NOT produce a plagiarism score, an
// AI-detection score, a source URL, or a quotation that is not derived from the
// supplied document/source records.
// ---------------------------------------------------------------------------

export interface LlmCitationReviewPassage {
  offset: number;
  length: number;
  /** Derived server-side from the extracted text; never trusted from the model. */
  excerpt: string;
  reason: string;
}

export interface LlmMatchExplanation {
  /** Must reference a matchId supplied by the local matching engine. */
  matchId: string;
  explanation: string;
}

/**
 * AI-writing *assistance* output: a cautious observation about a surface
 * writing pattern plus why it may occur. It is deliberately qualitative — there
 * is no calibrated likelihood, score, or confidence field, because no validated
 * method exists to produce one, and a pattern is never proof of AI authorship.
 */
export interface LlmWritingPatternObservation {
  /** Neutral description of an observable pattern in the text. */
  pattern: string;
  /** Cautious explanation, including benign alternative explanations. */
  explanation: string;
}

export interface LlmObservations {
  /** One or two paragraph overview of what the document appears to contain. */
  documentOverview: string;
  structureAndQuality: string;
  citationReview: LlmCitationReviewPassage[];
  matchExplanations: LlmMatchExplanation[];
  /**
   * AI-writing assistance observations. Never an authorship verdict and never
   * a detection score; displayed under their own disclaimer and limitations.
   */
  writingPatternObservations: LlmWritingPatternObservation[];
  instructorQuestions: string[];
  reportSummary: string;
  limitations: string[];
}

export interface LlmAnalysisResult {
  providerJobId: string;
  observations: LlmObservations;
  metadata: NormalizedProviderMetadata;
}

export interface LlmAnalysisInput {
  documentId: string;
  contentType: string;
  /** Extracted plain text. Never a storage key or raw file bytes. */
  text: string;
  /** Actual matches produced by the local matcher. */
  matches: SimilaritySourceMatch[];
  /** Stable per-job value sent to the provider as an idempotency key. */
  idempotencyKey: string;
}

export interface LlmAnalysisProvider {
  readonly id: string;
  readonly kind: "LLM_REVIEW";
  status(): AnalysisProviderStatus;
  /** One in-process model call. The job is only COMPLETED after normalization. */
  analyze(input: LlmAnalysisInput): Promise<LlmAnalysisResult>;
}

// ---------------------------------------------------------------------------
// Async submission/polling contract
//
// Real providers commonly accept a document and finish asynchronously, so the
// adapter contract supports that shape from the start. A synchronous provider
// can still be wrapped: submit returns a provider job id, and poll may return
// COMPLETED on the first call.
// ---------------------------------------------------------------------------

export type ProviderQueuedState = "QUEUED" | "PROCESSING";

export interface ProviderSubmission {
  /** Opaque provider-side identifier; never trusted as proof of completion. */
  providerJobId: string;
  status: ProviderQueuedState;
  metadata: NormalizedProviderMetadata;
}

export type ProviderProgress = {
  state: "QUEUED" | "PROCESSING";
};

export interface AnalysisProviderFailure {
  category: AnalysisErrorCategory;
  /** Safe machine code (e.g. "rate_limited"); never a raw provider payload. */
  code: string | null;
  /** Fixed, user-safe sentence. Never contains provider internals or content. */
  message: string;
  retryable: boolean;
}

export type ProviderPollOutcome<T> =
  | ProviderProgress
  | { state: "COMPLETED"; result: T }
  | { state: "FAILED"; error: AnalysisProviderFailure };

export class AnalysisProviderError extends Error {
  readonly category: AnalysisErrorCategory;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(args: {
    category: AnalysisErrorCategory;
    code?: string | null;
    message: string;
    retryable?: boolean;
  }) {
    super(args.message);
    this.name = "AnalysisProviderError";
    this.category = args.category;
    this.code = args.code ?? null;
    this.retryable =
      args.retryable ?? (args.category === "TRANSIENT" || args.category === "RATE_LIMITED");
  }
}

/** Raised by an explicitly unconfigured adapter — never a simulated result. */
export class AnalysisUnavailableError extends AnalysisProviderError {
  readonly providerId: string;

  constructor(providerId: string, message = "Document analysis is not configured on the server.") {
    super({ category: "CONFIGURATION", code: "provider_not_configured", message, retryable: false });
    this.name = "AnalysisUnavailableError";
    this.providerId = providerId;
  }
}

/** Raised when normalized provider output fails validation. */
export class AnalysisResultValidationError extends AnalysisProviderError {
  constructor(message = "The analysis provider returned an invalid result.") {
    super({ category: "INVALID_RESULT", code: "invalid_result", message, retryable: false });
    this.name = "AnalysisResultValidationError";
  }
}

export interface SimilarityAnalysisProvider {
  readonly id: string;
  readonly kind: "SIMILARITY";
  status(): AnalysisProviderStatus;
  submit(input: AnalysisProviderInput): Promise<ProviderSubmission>;
  poll(providerJobId: string): Promise<ProviderPollOutcome<SimilarityAnalysisResult>>;
}

export interface AiWritingAnalysisProvider {
  readonly id: string;
  readonly kind: "AI_WRITING";
  status(): AnalysisProviderStatus;
  submit(input: AnalysisProviderInput): Promise<ProviderSubmission>;
  poll(providerJobId: string): Promise<ProviderPollOutcome<AiWritingAnalysisResult>>;
}

// An AI detector result is probabilistic evidence, never proof of misconduct.
// This wording is persisted with AI results and must be shown wherever a score
// is presented to a user.
export const AI_DETECTION_DISCLAIMER =
  "AI-writing detection is probabilistic. A result indicates the likelihood that patterns in the text are machine-generated; it is not proof of misconduct and must be reviewed by a qualified human.";

// These are model-generated observations, not verified facts. They must never
// be presented as plagiarism findings, AI-authorship proof, or a completed
// specialist report.
export const LLM_OBSERVATION_DISCLAIMER =
  "LLM-assisted observations are model-generated, grounded only in the supplied document text and supplied local matches. They are not verified facts, plagiarism findings, or proof of AI authorship, and must be reviewed by a qualified instructor.";

// Persisted with any result that contains writing-pattern observations and
// shown next to the section. False positives are the central risk: short text,
// edited/translated text, formulaic academic conventions, and non-native
// English writing can all look "machine-like" without being machine-generated.
export const LLM_WRITING_PATTERN_DISCLAIMER =
  "Writing-pattern observations describe surface features of the text only. They are not evidence that the document was AI-generated; short, edited, translated, formulaic, or non-native English writing can show similar patterns. Human review is required.";

/** Bump whenever the student-facing privacy notice materially changes. */
export const LLM_CONSENT_VERSION = "llm-review-2026-10-18";

export const LOCAL_CORPUS_DISCLAIMER =
  "Local corpus similarity compares normalized word sequences with only the configured local corpus. It is not internet-wide or academic-database plagiarism detection, and a low score does not establish originality.";

export function analysisJobTypeLabel(type: AnalysisJobType): string {
  switch (type) {
    case "LOCAL_SIMILARITY":
      return "Local corpus similarity";
    case "LLM_REVIEW":
      return "LLM-assisted observations";
    case "SIMILARITY":
      return "Specialist plagiarism analysis";
    case "AI_WRITING":
      return "Specialist AI-writing analysis";
  }
}
