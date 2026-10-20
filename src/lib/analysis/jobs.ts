// Analysis job orchestration.
//
// The database is the work queue: a job is created in PENDING, and a worker
// (cron/server-side scheduler) claims due jobs and calls processAnalysisJob.
// There is intentionally NO in-memory queue — losing a process must never lose
// work or leave a job "running" forever.
//
// Invariants enforced here:
//   * only the assigned, approved/active instructor may initiate analysis;
//   * only a verified-paid (PAID/ACCEPTED) request is eligible;
//   * the document must be AVAILABLE (never quarantined), owned by the
//     request's student, and attached to that request — re-checked on every
//     provider attempt;
//   * bytes are read only through the private StorageAdapter; storage keys and
//     raw provider payloads never reach a client;
//   * one active job per document+type via `activeKey`, and a provider
//     idempotency key so crash retries cannot create duplicate billable work;
//   * COMPLETED is written only in the same transaction as a normalized result
//     returned by a configured provider. Unconfigured adapters fail closed.
//   * transient failures are retried with a bounded budget and backoff;
//     permanent/configuration/invalid-result failures are terminal.

import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import {
  ConflictError,
  ConfigurationError,
  ForbiddenError,
  IneligibleError,
  NotFoundError,
  ValidationError,
} from "@/lib/app-errors";
import { recordAuditEvent } from "@/lib/audit";
import {
  AUDIT_ACTIONS,
  analysisActiveKey,
  isAnalysisErrorCategory,
  isAnalysisJobStatus,
  isAnalysisJobType,
  isInlineAnalysisType,
  isTerminalAnalysisStatus,
  requiresExternalProcessingConsent,
  type AnalysisJobStatus,
  type AnalysisJobType,
} from "@/lib/domain";
import {
  canAccessDocument,
  canInitiateAnalysis,
  isPaidRequestStatusForAnalysis,
  type AuthUser,
} from "@/lib/authorization";
import { loadInstructorActorState } from "@/lib/instructor-requests";
import {
  currentStorageDriver,
  getStorage,
  MAX_UPLOAD_BYTES,
  type StorageAdapter,
} from "@/lib/storage/index";
import {
  AI_DETECTION_DISCLAIMER,
  AnalysisProviderError,
  LLM_LIMITS,
  LLM_OBSERVATION_DISCLAIMER,
  LOCAL_CORPUS_DISCLAIMER,
  findLocalMatches,
  getAiWritingProvider,
  getLlmProvider,
  getLocalSimilarityProvider,
  getSimilarityProvider,
  normalizeAiWritingResult,
  normalizeLlmAnalysisResult,
  normalizeProviderJobId,
  normalizeProviderMetadata,
  normalizeProviderQueuedState,
  normalizeSimilarityResult,
  type AiWritingAnalysisProvider,
  type AiWritingAnalysisResult,
  type AiWritingSegment,
  type AnalysisProviderFailure,
  type AnalysisProviderInput,
  type AnalysisProviderStatus,
  type LlmAnalysisProvider,
  type LlmAnalysisResult,
  type LlmObservations,
  type LocalSimilarityProvider,
  type NormalizedProviderMetadata,
  type ProviderPollOutcome,
  type ProviderQueuedState,
  type ProviderSubmission,
  type SimilarityAnalysisProvider,
  type SimilarityAnalysisResult,
  type SimilaritySourceMatch,
} from "@/lib/analysis/index";
import { extractDocumentText, DocumentExtractionError } from "@/lib/analysis/extract-text";
import { hasLlmConsent } from "@/lib/analysis/consent";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export const ANALYSIS_PROCESSING_LIMITS = {
  /** Maximum actual analysis attempts (provider submission or inline call). */
  maxAttempts: 3,
  /** Maximum transient failures (submit or poll) before the job is terminal. */
  maxTransientFailures: 3,
  /** Claim lease for a submission/poll; a crashed worker is retried after it. */
  leaseMs: 5 * 60_000,
  /** Normal poll cadence while a provider works. */
  pollIntervalMs: 60_000,
  retryBaseMs: 60_000,
  retryMaxMs: 15 * 60_000,
  maxDueJobs: 25,
} as const;

export function retryDelayMs(failureCount: number): number {
  const exponent = Math.max(0, failureCount - 1);
  return Math.min(
    ANALYSIS_PROCESSING_LIMITS.retryBaseMs * 2 ** exponent,
    ANALYSIS_PROCESSING_LIMITS.retryMaxMs,
  );
}

// ---------------------------------------------------------------------------
// Context (injectable for tests; production resolves configured adapters)
// ---------------------------------------------------------------------------

export interface AnalysisContext {
  /** Future specialist plagiarism provider. */
  similarity: SimilarityAnalysisProvider;
  /** Future specialist AI-writing detector. */
  aiWriting: AiWritingAnalysisProvider;
  localSimilarity: LocalSimilarityProvider;
  llm: LlmAnalysisProvider;
  storage: StorageAdapter;
}

export function defaultAnalysisContext(): AnalysisContext {
  let storage: StorageAdapter;
  try {
    storage = getStorage();
  } catch {
    throw new ConfigurationError("Document storage is not configured on the server.");
  }
  return {
    similarity: getSimilarityProvider(),
    aiWriting: getAiWritingProvider(),
    localSimilarity: getLocalSimilarityProvider(),
    llm: getLlmProvider(),
    storage,
  };
}

type Provider = SimilarityAnalysisProvider | AiWritingAnalysisProvider;

function specialistProviderFor(type: AnalysisJobType, context: AnalysisContext): Provider {
  if (type === "SIMILARITY") return context.similarity;
  if (type === "AI_WRITING") return context.aiWriting;
  throw new Error(`No asynchronous specialist provider for job type ${type}.`);
}

function providerStatusFor(
  type: AnalysisJobType,
  context: AnalysisContext,
): AnalysisProviderStatus {
  if (type === "LOCAL_SIMILARITY") return context.localSimilarity.status();
  if (type === "LLM_REVIEW") return context.llm.status();
  if (type === "SIMILARITY") return context.similarity.status();
  return context.aiWriting.status();
}

// ---------------------------------------------------------------------------
// Safe errors
// ---------------------------------------------------------------------------

const SAFE_ERROR_MESSAGES: Record<AnalysisProviderFailure["category"], string> = {
  CONFIGURATION: "Document analysis is not configured on the server. No analysis was run.",
  TRANSIENT:
    "The analysis provider is temporarily unavailable. The analysis was not completed.",
  RATE_LIMITED:
    "The analysis provider is temporarily rate-limited. The analysis was not completed.",
  PERMANENT: "The analysis provider could not process this document.",
  INVALID_RESULT:
    "The analysis provider returned an invalid result. No result was stored.",
  CONTENT_REJECTED: "The document was rejected by the analysis provider.",
};

function safeCode(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().slice(0, 64);
  return /^[A-Za-z0-9_.:-]+$/.test(cleaned) ? cleaned : null;
}

/** Convert any thrown error into safe, persistable metadata. Never raw text. */
function failureFrom(error: unknown): AnalysisProviderFailure {
  if (error instanceof AnalysisProviderError) {
    const category = isAnalysisErrorCategory(error.category) ? error.category : "PERMANENT";
    return {
      category,
      code: safeCode(error.code),
      message: SAFE_ERROR_MESSAGES[category],
      retryable: error.retryable,
    };
  }
  return {
    category: "TRANSIENT",
    code: "internal_error",
    message: SAFE_ERROR_MESSAGES.TRANSIENT,
    retryable: true,
  };
}

function configurationFailure(code: string, retryable = false): AnalysisProviderFailure {
  return {
    category: "CONFIGURATION",
    code,
    message: SAFE_ERROR_MESSAGES.CONFIGURATION,
    retryable,
  };
}

function permanentFailure(code: string, message?: string): AnalysisProviderFailure {
  return {
    category: "PERMANENT",
    code,
    message: message ?? SAFE_ERROR_MESSAGES.PERMANENT,
    retryable: false,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

// ---------------------------------------------------------------------------
// Summary types (what may cross the server/client boundary)
// ---------------------------------------------------------------------------

export interface AnalysisResultMetadataSummary {
  providerId: string | null;
  providerVersion: string | null;
  modelVersion: string | null;
  thresholdPercent: number | null;
  disclaimer: string | null;
  llmDisclaimer: string | null;
  corpusId: string | null;
  corpusSize: number | null;
  algorithm: string | null;
  shingleSize: number | null;
  matchedTokens: number | null;
  totalTokens: number | null;
  limitations: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AnalysisResultSummary {
  status: string;
  similarityPercent: number | null;
  aiLikelihood: number | null;
  matches: SimilaritySourceMatch[];
  segments: AiWritingSegment[];
  /** Model-generated observations; never a specialist similarity/AI result. */
  observations: LlmObservations | null;
  providerVersion: string | null;
  metadata: AnalysisResultMetadataSummary | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnalysisJobSummary {
  id: string;
  documentId: string;
  requestId: string | null;
  type: AnalysisJobType;
  status: AnalysisJobStatus;
  provider: string;
  providerStatus: string | null;
  providerVersion: string | null;
  attempts: number;
  failureCount: number;
  submittedAt: Date | null;
  startedAt: Date | null;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  error: { category: string; code: string | null; message: string } | null;
  result: AnalysisResultSummary | null;
  /** Present for AI-writing jobs; the result is probabilistic, not proof. */
  disclaimer: string | null;
}

interface StoredResult {
  status: string;
  similarityPercent: number | null;
  aiLikelihood: number | null;
  matches: string | null;
  segments: string | null;
  observations: string | null;
  providerVersion: string | null;
  metadata: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface StoredJob {
  id: string;
  documentId: string;
  requestId: string | null;
  requestedById: string;
  type: string;
  status: string;
  provider: string;
  providerJobId: string | null;
  providerStatus: string | null;
  providerVersion: string | null;
  attempts: number;
  failureCount: number;
  submittedAt: Date | null;
  startedAt: Date | null;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  errorCategory: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  result: StoredResult | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Only http(s) links may cross into the report UI. This repeats the write-time
 * validation for old rows so a stored legacy value cannot become a script link.
 */
function safeSourceUrl(value: unknown): string | null {
  const text = stringOrNull(value)?.trim();
  if (!text || text.length > 2_048) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseMatches(value: string | null): SimilaritySourceMatch[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  const matches: SimilaritySourceMatch[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (
      !Number.isSafeInteger(item.offset) ||
      !Number.isSafeInteger(item.length) ||
      (item.offset as number) < 0 ||
      (item.length as number) <= 0
    ) {
      continue;
    }
    const excerpt = (value: unknown) => {
      const text = stringOrNull(value);
      return text ? text.slice(0, 400) : null;
    };
    matches.push({
      matchId: stringOrNull(item.matchId)?.slice(0, 100) ?? null,
      offset: item.offset as number,
      length: item.length as number,
      similarityPercent: percentOrNull(item.similarityPercent),
      sourceId: stringOrNull(item.sourceId)?.slice(0, 200) ?? null,
      sourceTitle: stringOrNull(item.sourceTitle)?.slice(0, 300) ?? null,
      sourceUrl: safeSourceUrl(item.sourceUrl),
      sourceExcerpt: excerpt(item.sourceExcerpt),
      matchedExcerpt: excerpt(item.matchedExcerpt),
    });
  }
  return matches;
}

function parseSegments(value: string | null): AiWritingSegment[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  const segments: AiWritingSegment[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (
      !Number.isSafeInteger(item.offset) ||
      !Number.isSafeInteger(item.length) ||
      (item.offset as number) < 0 ||
      (item.length as number) <= 0
    ) {
      continue;
    }
    segments.push({
      offset: item.offset as number,
      length: item.length as number,
      aiLikelihood: percentOrNull(item.aiLikelihood),
    });
  }
  return segments;
}

function parseResultMetadata(value: string | null): AnalysisResultMetadataSummary | null {
  const parsed = parseJson(value);
  if (!isRecord(parsed)) return null;
  return {
    providerId: stringOrNull(parsed.providerId),
    providerVersion: stringOrNull(parsed.providerVersion),
    modelVersion: stringOrNull(parsed.modelVersion),
    thresholdPercent: percentOrNull(parsed.thresholdPercent),
    disclaimer: stringOrNull(parsed.disclaimer),
    llmDisclaimer: stringOrNull(parsed.llmDisclaimer),
    corpusId: stringOrNull(parsed.corpusId),
    corpusSize: numberOrNull(parsed.corpusSize),
    algorithm: stringOrNull(parsed.algorithm),
    shingleSize: numberOrNull(parsed.shingleSize),
    matchedTokens: numberOrNull(parsed.matchedTokens),
    totalTokens: numberOrNull(parsed.totalTokens),
    limitations: stringOrNull(parsed.limitations),
    inputTokens: numberOrNull(parsed.inputTokens),
    outputTokens: numberOrNull(parsed.outputTokens),
  };
}

function safeStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function parseObservations(value: string | null): LlmObservations | null {
  const parsed = parseJson(value);
  if (!isRecord(parsed)) return null;

  const documentOverview = stringOrNull(parsed.documentOverview);
  const structureAndQuality = stringOrNull(parsed.structureAndQuality);
  const reportSummary = stringOrNull(parsed.reportSummary);
  if (!documentOverview || !structureAndQuality || !reportSummary) return null;

  const citationReview = Array.isArray(parsed.citationReview)
    ? parsed.citationReview
        .filter(isRecord)
        .map((item) => ({
          offset: Number.isSafeInteger(item.offset) ? (item.offset as number) : -1,
          length: Number.isSafeInteger(item.length) ? (item.length as number) : -1,
          excerpt: stringOrNull(item.excerpt)?.slice(0, 1_000) ?? "",
          reason: stringOrNull(item.reason)?.slice(0, 600) ?? "",
        }))
        .filter(
          (item) =>
            item.offset >= 0 && item.length > 0 && item.excerpt.length > 0 && item.reason.length > 0,
        )
        .slice(0, 20)
    : [];

  const matchExplanations = Array.isArray(parsed.matchExplanations)
    ? parsed.matchExplanations
        .filter(isRecord)
        .map((item) => ({
          matchId: stringOrNull(item.matchId)?.slice(0, 100) ?? "",
          explanation: stringOrNull(item.explanation)?.slice(0, 1200) ?? "",
        }))
        .filter((item) => item.matchId.length > 0 && item.explanation.length > 0)
        .slice(0, 50)
    : [];

  // Rows written before writing-pattern observations existed simply produce [].
  const writingPatternObservations = Array.isArray(parsed.writingPatternObservations)
    ? parsed.writingPatternObservations
        .filter(isRecord)
        .map((item) => ({
          pattern: stringOrNull(item.pattern)?.slice(0, 300) ?? "",
          explanation: stringOrNull(item.explanation)?.slice(0, 600) ?? "",
        }))
        .filter((item) => item.pattern.length > 0 && item.explanation.length > 0)
        .slice(0, 8)
    : [];

  const limitations = safeStringList(parsed.limitations, 8, 300);
  if (limitations.length === 0) {
    limitations.push(
      "Observations cover only the supplied document text and local matches and are not verified facts.",
    );
  }

  return {
    documentOverview: documentOverview.slice(0, 4000),
    structureAndQuality: structureAndQuality.slice(0, 4000),
    citationReview,
    matchExplanations,
    writingPatternObservations,
    instructorQuestions: safeStringList(parsed.instructorQuestions, 12, 300),
    reportSummary: reportSummary.slice(0, 6000),
    limitations,
  };
}

/** Whitelisted projection — never storage keys, raw payloads, or providerMeta. */
export function toAnalysisJobSummary(job: StoredJob): AnalysisJobSummary {
  const type: AnalysisJobType = isAnalysisJobType(job.type) ? job.type : "SIMILARITY";
  const status: AnalysisJobStatus = isAnalysisJobStatus(job.status)
    ? job.status
    : "FAILED";
  const errorCategory =
    job.errorCategory && isAnalysisErrorCategory(job.errorCategory)
      ? job.errorCategory
      : null;
  return {
    id: job.id,
    documentId: job.documentId,
    requestId: job.requestId,
    type,
    status,
    provider: job.provider,
    providerStatus: job.providerStatus,
    providerVersion: job.providerVersion,
    attempts: job.attempts,
    failureCount: job.failureCount,
    submittedAt: job.submittedAt,
    startedAt: job.startedAt,
    lastAttemptAt: job.lastAttemptAt,
    nextAttemptAt: job.nextAttemptAt,
    completedAt: job.completedAt,
    failedAt: job.failedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: errorCategory
      ? {
          category: errorCategory,
          code: safeCode(job.errorCode),
          // Never echo legacy/raw persisted text; use the fixed safe message.
          message: SAFE_ERROR_MESSAGES[errorCategory],
        }
      : null,
    result: job.result
      ? {
          status: job.result.status,
          similarityPercent: percentOrNull(job.result.similarityPercent),
          aiLikelihood: percentOrNull(job.result.aiLikelihood),
          matches: parseMatches(job.result.matches),
          segments: parseSegments(job.result.segments),
          observations: parseObservations(job.result.observations),
          providerVersion: job.result.providerVersion,
          metadata: parseResultMetadata(job.result.metadata),
          createdAt: job.result.createdAt,
          updatedAt: job.result.updatedAt,
        }
      : null,
    disclaimer:
      type === "AI_WRITING"
        ? AI_DETECTION_DISCLAIMER
        : type === "LLM_REVIEW"
          ? LLM_OBSERVATION_DISCLAIMER
          : type === "LOCAL_SIMILARITY"
            ? LOCAL_CORPUS_DISCLAIMER
            : null,
  };
}

const JOB_WITH_RESULT = { result: true } as const;

/** Authorized request-scoped read: owner, assigned instructor, or admin. */
export async function getAnalysisJobSummary(
  actor: AuthUser,
  jobId: unknown,
): Promise<AnalysisJobSummary | null> {
  const id = cleanId(jobId);
  if (!id) return null;

  const job = await prisma.analysisJob.findUnique({
    where: { id },
    include: {
      ...JOB_WITH_RESULT,
      document: { select: { ownerId: true } },
      request: { select: { instructor: { select: { userId: true } } } },
    },
  });
  if (!job) return null;

  const allowed = canAccessDocument(actor, {
    ownerId: job.document.ownerId,
    request: job.request,
  });
  if (!allowed) return null;

  return toAnalysisJobSummary(job);
}

// ---------------------------------------------------------------------------
// Initiation
// ---------------------------------------------------------------------------

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null;
}

export interface InitiateAnalysisResult {
  created: boolean;
  job: AnalysisJobSummary;
}

export interface InitiateAnalysisArgs {
  actor: AuthUser;
  requestId: unknown;
  documentId: unknown;
  type: unknown;
  request?: Request;
  context?: AnalysisContext;
}

/**
 * Create (or idempotently return) the analysis job for a document.
 *
 * This does NOT call the provider synchronously. The job is PENDING in the
 * database; a worker claims it via processAnalysisJob. That avoids holding an
 * HTTP request open across a slow external provider and gives retries a
 * durable home.
 */
export async function initiateAnalysis(
  args: InitiateAnalysisArgs,
): Promise<InitiateAnalysisResult> {
  const { actor, request } = args;

  const requestId = cleanId(args.requestId);
  if (!requestId) throw new NotFoundError("Request not found.");

  const documentId = cleanId(args.documentId);
  if (!documentId) {
    throw new ValidationError("A valid document is required.", {
      documentId: "Select a document to analyse.",
    });
  }
  if (!isAnalysisJobType(args.type)) {
    throw new ValidationError("Choose a valid analysis type.", {
      type: "Analysis type must be LOCAL_SIMILARITY, LLM_REVIEW, SIMILARITY, or AI_WRITING.",
    });
  }
  const type = args.type;

  // Authoritative actor state — never the session copy.
  if (actor.role !== "INSTRUCTOR") {
    await auditDenied(actor.id, "not_instructor", request, { requestId, documentId, type });
    throw new ForbiddenError("Only the assigned instructor can initiate document analysis.");
  }

  const state = await loadInstructorActorState(actor);
  if (!state) {
    await auditDenied(null, "actor_not_found", request, { requestId, documentId, type });
    throw new ForbiddenError("You do not have permission to perform this action.");
  }
  if (!state.eligibility.eligible || !state.profile) {
    await auditDenied(state.userId, "ineligible_instructor", request, {
      requestId,
      documentId,
      type,
      reasons: state.eligibility.reasons,
    });
    throw new IneligibleError(
      "Your instructor account is not eligible to initiate analysis.",
      state.eligibility.reasons,
    );
  }

  const serviceRequest = await prisma.serviceRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      studentId: true,
      status: true,
      llmProcessingConsentAt: true,
      llmProcessingConsentVersion: true,
      instructor: { select: { userId: true } },
    },
  });

  // Never confirm another instructor's request exists.
  if (!serviceRequest || serviceRequest.instructor.userId !== state.userId) {
    await auditDenied(state.userId, "not_assigned_instructor", request, {
      requestId,
      documentId,
      type,
    });
    throw new NotFoundError("Request not found.");
  }

  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      ownerId: true,
      requestId: true,
      status: true,
      scanStatus: true,
      storageDriver: true,
      sizeBytes: true,
      checksumSha256: true,
    },
  });
  if (!document) throw new NotFoundError("Document not found.");

  const authorized = canInitiateAnalysis(
    { id: state.userId, role: actor.role },
    {
      instructorUserId: serviceRequest.instructor.userId,
      requestId: serviceRequest.id,
      studentId: serviceRequest.studentId,
      requestStatus: serviceRequest.status,
      documentOwnerId: document.ownerId,
      documentRequestId: document.requestId,
      documentStatus: document.status,
      documentScanStatus: document.scanStatus,
    },
  );

  if (!authorized) {
    if (!isPaidRequestStatusForAnalysis(serviceRequest.status)) {
      await auditDenied(state.userId, "request_not_paid", request, {
        requestId,
        documentId,
        type,
      });
      throw new ConflictError(
        "Analysis can only be initiated after payment has been verified and the request has not been declined.",
      );
    }
    if (
      document.requestId !== serviceRequest.id ||
      document.ownerId !== serviceRequest.studentId
    ) {
      await auditDenied(state.userId, "document_not_associated", request, {
        requestId,
        documentId,
        type,
      });
      throw new NotFoundError("Document not found.");
    }
    if (document.status !== "AVAILABLE" || document.scanStatus !== "CLEAN") {
      await auditDenied(state.userId, "document_not_available", request, {
        requestId,
        documentId,
        type,
      });
      throw new ConflictError(
        "This document has not passed a clean security scan and cannot be sent to an analysis provider.",
      );
    }
    await auditDenied(state.userId, "analysis_not_permitted", request, {
      requestId,
      documentId,
      type,
    });
    throw new ForbiddenError("You do not have permission to analyse this document.");
  }

  if (document.storageDriver !== currentStorageDriver()) {
    await auditDenied(state.userId, "storage_driver_unavailable", request, {
      requestId,
      documentId,
      type,
    });
    throw new ConfigurationError(
      "The document's storage driver is not available on this server.",
    );
  }
  if (!document.checksumSha256) {
    await auditDenied(state.userId, "document_checksum_missing", request, {
      requestId,
      documentId,
      type,
    });
    throw new ConflictError(
      "This document has no recorded integrity checksum. Re-upload it before requesting analysis.",
    );
  }
  if (document.sizeBytes <= 0 || document.sizeBytes > MAX_UPLOAD_BYTES) {
    await auditDenied(state.userId, "document_size_invalid", request, {
      requestId,
      documentId,
      type,
    });
    throw new ConflictError(
      "The document size is outside the analysable upload limit. Re-upload a valid file.",
    );
  }

  // Idempotency before provider checks: if work already exists (or already
  // completed), return it rather than creating a second billable job.
  const key = analysisActiveKey(document.id, type);
  const existingActive = await prisma.analysisJob.findUnique({
    where: { activeKey: key },
    include: JOB_WITH_RESULT,
  });
  if (existingActive) {
    return { created: false, job: toAnalysisJobSummary(existingActive) };
  }

  const completed = await prisma.analysisJob.findFirst({
    where: {
      documentId: document.id,
      requestId: serviceRequest.id,
      type,
      status: "COMPLETED",
    },
    orderBy: { completedAt: "desc" },
    include: JOB_WITH_RESULT,
  });
  if (completed) {
    return { created: false, job: toAnalysisJobSummary(completed) };
  }

  // External processing needs an explicit, current student consent. Local
  // matching never leaves the server and does not require this.
  if (requiresExternalProcessingConsent(type) && !hasLlmConsent(serviceRequest)) {
    await auditDenied(state.userId, "llm_consent_missing", request, {
      requestId,
      documentId,
      type,
    });
    throw new ConflictError(
      "The student has not consented to external LLM processing for this request. Ask the student to review and allow it from their request page.",
    );
  }

  const context = args.context ?? defaultAnalysisContext();
  const availability = providerStatusFor(type, context);
  if (!availability.configured || availability.state !== "AVAILABLE") {
    await auditDenied(state.userId, "provider_not_configured", request, {
      requestId,
      documentId,
      type,
      provider: availability.providerId,
    });
    throw new ConfigurationError(availability.message);
  }
  const providerId = availability.providerId;

  try {
    const created = await prisma.analysisJob.create({
      data: {
        documentId: document.id,
        requestId: serviceRequest.id,
        requestedById: state.userId,
        type,
        status: "PENDING",
        provider: providerId,
        activeKey: key,
      },
      include: JOB_WITH_RESULT,
    });

    await recordAuditEvent({
      actorId: state.userId,
      action: AUDIT_ACTIONS.ANALYSIS_JOB_CREATED,
      targetType: "AnalysisJob",
      targetId: created.id,
      metadata: {
        requestId: serviceRequest.id,
        documentId: document.id,
        type,
        provider: providerId,
      },
      request,
    });

    return { created: true, job: toAnalysisJobSummary(created) };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // Concurrent initiation: the unique activeKey decided the winner.
      const existing = await prisma.analysisJob.findUnique({
        where: { activeKey: key },
        include: JOB_WITH_RESULT,
      });
      if (existing) return { created: false, job: toAnalysisJobSummary(existing) };
    }
    throw error;
  }
}

async function auditDenied(
  actorId: string | null,
  reason: string,
  request: Request | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordAuditEvent({
    actorId,
    action: AUDIT_ACTIONS.ANALYSIS_JOB_CREATE_DENIED,
    targetType: "ServiceRequest",
    targetId: typeof metadata.requestId === "string" ? metadata.requestId : undefined,
    metadata: { reason, ...metadata },
    request,
  });
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export type AnalysisProcessingOutcome =
  | { outcome: "SUBMITTED"; jobId: string; status: ProviderQueuedState }
  | { outcome: "PROGRESSING"; jobId: string; status: ProviderQueuedState }
  | { outcome: "COMPLETED"; jobId: string }
  | { outcome: "RETRY_SCHEDULED"; jobId: string; retryAt: Date }
  | { outcome: "FAILED"; jobId: string }
  | { outcome: "NOOP"; jobId: string; status: AnalysisJobStatus | null; reason: string };

interface DocumentForProcessing {
  id: string;
  ownerId: string;
  requestId: string | null;
  status: string;
  scanStatus: string;
  storageDriver: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string | null;
}

interface RequestForProcessing {
  id: string;
  studentId: string;
  status: string;
  llmProcessingConsentAt: Date | null;
  llmProcessingConsentVersion: string | null;
  instructorId: string;
  instructor: {
    userId: string;
    isApproved: boolean;
    isActive: boolean;
    user: { role: string; suspended: boolean };
  };
}

type JobForProcessing = Omit<StoredJob, "result"> & {
  document: DocumentForProcessing;
  request: RequestForProcessing | null;
};

export interface ProcessAnalysisJobArgs {
  jobId: unknown;
  context?: AnalysisContext;
  now?: Date;
}

/**
 * Perform ONE provider step for a job: submit if not yet submitted, otherwise
 * poll. Returns quickly; callers may loop or schedule the next attempt.
 */
export async function processAnalysisJob(
  args: ProcessAnalysisJobArgs,
): Promise<AnalysisProcessingOutcome> {
  const jobId = cleanId(args.jobId);
  if (!jobId) throw new NotFoundError("Analysis job not found.");

  const context = args.context ?? defaultAnalysisContext();
  const now = args.now ?? new Date();

  const job = (await prisma.analysisJob.findUnique({
    where: { id: jobId },
    include: {
      document: {
        select: {
          id: true,
          ownerId: true,
          requestId: true,
          status: true,
          scanStatus: true,
          storageDriver: true,
          storageKey: true,
          contentType: true,
          sizeBytes: true,
          checksumSha256: true,
        },
      },
      request: {
        select: {
          id: true,
          studentId: true,
          status: true,
          llmProcessingConsentAt: true,
          llmProcessingConsentVersion: true,
          instructorId: true,
          instructor: {
            select: {
              userId: true,
              isApproved: true,
              isActive: true,
              user: { select: { role: true, suspended: true } },
            },
          },
        },
      },
    },
  })) as JobForProcessing | null;

  if (!job) throw new NotFoundError("Analysis job not found.");
  if (!isAnalysisJobStatus(job.status)) {
    throw new Error("Analysis job has an invalid persisted status.");
  }
  if (job.status === "COMPLETED") {
    return { outcome: "NOOP", jobId, status: "COMPLETED", reason: "already_completed" };
  }
  if (job.status === "FAILED") {
    return { outcome: "NOOP", jobId, status: "FAILED", reason: "already_failed" };
  }
  if (job.status === "UNCONFIGURED") {
    // A legacy job created before a provider existed. Never invent a result;
    // a fresh, authorized job is required once a provider is configured.
    return { outcome: "NOOP", jobId, status: "UNCONFIGURED", reason: "not_configured" };
  }
  if (!isAnalysisJobType(job.type)) {
    return failJob(
      job,
      configurationFailure("invalid_job_type"),
      now,
    );
  }

  // Re-check every attempt. A quarantined, unscanned or detached document must
  // never reach an external provider.
  if (
    job.document.status !== "AVAILABLE" ||
    job.document.scanStatus !== "CLEAN" ||
    job.requestId === null ||
    job.document.requestId !== job.requestId ||
    !job.request ||
    job.request.studentId !== job.document.ownerId
  ) {
    return failJob(
      job,
      permanentFailure(
        "document_not_available",
        "The document is quarantined, unscanned, detached, or no longer associated with this request. No analysis was run.",
      ),
      now,
    );
  }

  if (!isPaidRequestStatusForAnalysis(job.request.status)) {
    return failJob(
      job,
      permanentFailure(
        "request_not_eligible",
        "The request is no longer in a paid, analysable state. No analysis was run.",
      ),
      now,
    );
  }

  // The initiating instructor must still be the assigned, approved, active,
  // unsuspended instructor. A job must not outlive their eligibility.
  if (
    job.request.instructor.userId !== job.requestedById ||
    !job.request.instructor.isApproved ||
    !job.request.instructor.isActive ||
    job.request.instructor.user.role !== "INSTRUCTOR" ||
    job.request.instructor.user.suspended
  ) {
    return failJob(
      job,
      permanentFailure(
        "instructor_not_eligible",
        "The assigned instructor is no longer eligible to analyse documents. No analysis was run.",
      ),
      now,
    );
  }

  if (job.document.storageDriver !== currentStorageDriver()) {
    return failJob(job, configurationFailure("storage_driver_mismatch"), now);
  }
  if (job.document.sizeBytes <= 0 || job.document.sizeBytes > MAX_UPLOAD_BYTES) {
    return failJob(
      job,
      permanentFailure(
        "document_size_invalid",
        "The document size is outside the analysable upload limit. No analysis was run.",
      ),
      now,
    );
  }

  // Consent can be withdrawn at any time. Re-check before every attempt; an
  // in-flight call cannot be recalled, but no new external call may start.
  if (requiresExternalProcessingConsent(job.type) && !hasLlmConsent(job.request)) {
    return failJob(
      job,
      permanentFailure(
        "llm_consent_missing",
        "The student has not consented to external LLM processing. No external call was made.",
      ),
      now,
    );
  }

  if (job.nextAttemptAt && job.nextAttemptAt.getTime() > now.getTime()) {
    return { outcome: "NOOP", jobId, status: job.status, reason: "not_due" };
  }

  if (isInlineAnalysisType(job.type)) {
    return runInlineJob(job, job.type, context, now);
  }

  const provider = specialistProviderFor(job.type, context);
  const availability = provider.status();
  if (!availability.configured || availability.state !== "AVAILABLE") {
    // Fail closed: without a real provider there is no result to record.
    return failJob(job, configurationFailure("provider_not_configured"), now);
  }

  if (!job.providerJobId) {
    return submitJob(job, job.type, provider, context, now);
  }

  if (job.type === "SIMILARITY") {
    return pollSimilarityJob(job, context.similarity, now);
  }
  return pollAiWritingJob(job, context.aiWriting, now);
}

/**
 * Local matching and LLM review are one-step, in-process capabilities. The
 * database job is still the durable record: it is claimed atomically, extracted
 * and analysed, then completed only after a validated result exists. The LLM
 * receives a stable Idempotency-Key, so a crash after the provider responds can
 * retry without creating a second billable run.
 */
async function runInlineJob(
  job: JobForProcessing,
  type: "LOCAL_SIMILARITY" | "LLM_REVIEW",
  context: AnalysisContext,
  now: Date,
): Promise<AnalysisProcessingOutcome> {
  const availability = providerStatusFor(type, context);
  if (!availability.configured || availability.state !== "AVAILABLE") {
    return failJob(job, configurationFailure("provider_not_configured"), now);
  }
  if (type === "LLM_REVIEW" && !hasLlmConsent(job.request!)) {
    return failJob(
      job,
      permanentFailure(
        "llm_consent_missing",
        "The student has not consented to external LLM processing. No external call was made.",
      ),
      now,
    );
  }

  const claim = await prisma.analysisJob.updateMany({
    where: {
      id: job.id,
      providerJobId: null,
      // PROCESSING is included so a job whose worker crashed after claiming
      // it can be reclaimed once its lease expires. A live claim has a future
      // nextAttemptAt and therefore fails the due-time condition.
      status: { in: ["PENDING", "QUEUED", "PROCESSING", "RETRYABLE"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    data: {
      status: "PROCESSING",
      startedAt: job.startedAt ?? now,
      lastAttemptAt: now,
      nextAttemptAt: new Date(now.getTime() + ANALYSIS_PROCESSING_LIMITS.leaseMs),
      errorCategory: null,
      errorCode: null,
      errorMessage: null,
    },
  });
  if (claim.count === 0) {
    return {
      outcome: "NOOP",
      jobId: job.id,
      status: isAnalysisJobStatus(job.status) ? job.status : null,
      reason: "concurrent",
    };
  }

  let bytes: Buffer;
  try {
    bytes = await context.storage.get(job.document.storageKey);
  } catch {
    return recordFailure(job, failureFromStorage(), now);
  }

  if (bytes.length !== job.document.sizeBytes) {
    return failJob(
      job,
      permanentFailure(
        "document_size_mismatch",
        "The stored document failed its integrity check. No analysis was run.",
      ),
      now,
    );
  }
  if (!job.document.checksumSha256) {
    return failJob(
      job,
      permanentFailure(
        "document_checksum_missing",
        "The stored document has no integrity checksum. No analysis was run.",
      ),
      now,
    );
  }
  {
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== job.document.checksumSha256) {
      return failJob(
        job,
        permanentFailure(
          "document_checksum_mismatch",
          "The stored document failed its integrity check. No analysis was run.",
        ),
        now,
      );
    }
  }

  let extracted;
  try {
    extracted = await extractDocumentText({
      contentType: job.document.contentType,
      bytes,
    });
  } catch (error) {
    if (error instanceof DocumentExtractionError) {
      return failJob(
        job,
        {
          category: error.category,
          code: error.code,
          message: error.message,
          retryable: false,
        },
        now,
      );
    }
    return failJob(
      job,
      permanentFailure(
        "text_extraction_failed",
        "The document text could not be extracted safely. No analysis was run.",
      ),
      now,
    );
  }

  if (type === "LLM_REVIEW" && extracted.text.length > LLM_LIMITS.maxInputChars) {
    return failJob(
      job,
      permanentFailure(
        "llm_input_too_large",
        "The extracted document text exceeds the LLM review limit. No external call was made.",
      ),
      now,
    );
  }

  // Count an actual analysis attempt only once extraction and all pre-provider
  // integrity checks have passed. This keeps retry budgets meaningful.
  const attempt = await prisma.analysisJob.updateMany({
    where: { id: job.id, status: "PROCESSING", providerJobId: null },
    data: { attempts: { increment: 1 }, lastAttemptAt: now },
  });
  if (attempt.count === 0) {
    return { outcome: "NOOP", jobId: job.id, status: null, reason: "concurrent" };
  }

  await recordAuditEvent({
    actorId: null,
    action: AUDIT_ACTIONS.ANALYSIS_JOB_SUBMITTED,
    targetType: "AnalysisJob",
    targetId: job.id,
    metadata: {
      documentId: job.documentId,
      requestId: job.requestId,
      type,
      provider: availability.providerId,
      attempt: job.attempts + 1,
      mode: type === "LLM_REVIEW" ? "external_llm" : "local_corpus",
    },
  });

  const idempotencyKey = `analysis-job:${job.id}`;

  if (type === "LOCAL_SIMILARITY") {
    let result: SimilarityAnalysisResult;
    try {
      result = await context.localSimilarity.analyze({
        documentId: job.document.id,
        text: extracted.text,
        idempotencyKey,
      });
    } catch (error) {
      return recordFailure(job, failureFrom(error), now);
    }

    let normalized: SimilarityAnalysisResult;
    try {
      normalized = normalizeSimilarityResult(result, {
        providerId: context.localSimilarity.id,
        providerJobId: normalizeProviderJobId(result.providerJobId),
      });
    } catch (error) {
      return recordFailure(job, failureFrom(error), now);
    }
    return completeLocalSimilarityJob(
      job,
      normalized,
      context.localSimilarity.id,
      extracted.extractionVersion,
      extracted.pageCount,
      now,
    );
  }

  // Supply only actual local matches to the LLM. The adapter sends exactly
  // these records, and normalization rejects explanations for any other id.
  // Cap the list here as well as in the prompt so an id that was not supplied
  // to the model can never be accepted back.
  const local = findLocalMatches(extracted.text, { documentId: job.document.id });
  const suppliedMatches = local.matches.slice(0, LLM_LIMITS.maxMatchesInPrompt);
  const allowedMatchIds = suppliedMatches
    .map((match) => match.matchId)
    .filter((matchId): matchId is string => typeof matchId === "string" && matchId.length > 0);

  let result;
  try {
    result = await context.llm.analyze({
      documentId: job.document.id,
      contentType: job.document.contentType,
      text: extracted.text,
      matches: suppliedMatches,
      idempotencyKey,
    });
  } catch (error) {
    return recordFailure(job, failureFrom(error), now);
  }

  let providerJobId: string;
  let normalized;
  try {
    providerJobId = normalizeProviderJobId(result.providerJobId);
    normalized = normalizeLlmAnalysisResult(result, {
      providerId: context.llm.id,
      providerJobId,
      text: extracted.text,
      allowedMatchIds,
    });
  } catch (error) {
    return recordFailure(job, failureFrom(error), now);
  }

  return completeLlmJob(
    job,
    normalized,
    context.llm.id,
    extracted.extractionVersion,
    extracted.pageCount,
    now,
  );
}

async function submitJob(
  job: JobForProcessing,
  type: AnalysisJobType,
  provider: Provider,
  context: AnalysisContext,
  now: Date,
): Promise<AnalysisProcessingOutcome> {
  // Compare-and-set claim. A stale QUEUED row without a provider id is a
  // crashed submission and may be reclaimed after its lease; this is why the
  // provider receives a stable idempotency key.
  const claim = await prisma.analysisJob.updateMany({
    where: {
      id: job.id,
      providerJobId: null,
      status: { in: ["PENDING", "QUEUED", "RETRYABLE"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    data: {
      status: "QUEUED",
      attempts: { increment: 1 },
      startedAt: job.startedAt ?? now,
      lastAttemptAt: now,
      nextAttemptAt: new Date(now.getTime() + ANALYSIS_PROCESSING_LIMITS.leaseMs),
      errorCategory: null,
      errorCode: null,
      errorMessage: null,
    },
  });
  if (claim.count === 0) {
    return { outcome: "NOOP", jobId: job.id, status: isAnalysisJobStatus(job.status) ? job.status : null, reason: "concurrent" };
  }

  // Bytes are read only through the private storage abstraction, and only
  // after the quarantine/association checks above.
  let bytes: Buffer;
  try {
    bytes = await context.storage.get(job.document.storageKey);
  } catch {
    return recordFailure(job, failureFromStorage(), now);
  }

  // Never send a truncated/replaced file. Integrity failure is permanent and
  // happens before any provider call.
  if (bytes.length !== job.document.sizeBytes) {
    return failJob(
      job,
      permanentFailure(
        "document_size_mismatch",
        "The stored document failed its integrity check. No analysis was run.",
      ),
      now,
    );
  }
  if (!job.document.checksumSha256) {
    return failJob(
      job,
      permanentFailure(
        "document_checksum_missing",
        "The stored document has no integrity checksum. No analysis was run.",
      ),
      now,
    );
  }
  {
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== job.document.checksumSha256) {
      return failJob(
        job,
        permanentFailure(
          "document_checksum_mismatch",
          "The stored document failed its integrity check. No analysis was run.",
        ),
        now,
      );
    }
  }

  const input: AnalysisProviderInput = {
    documentId: job.document.id,
    contentType: job.document.contentType,
    bytes: new Uint8Array(bytes),
    sizeBytes: bytes.length,
    checksumSha256: job.document.checksumSha256,
    idempotencyKey: `analysis-job:${job.id}`,
  };

  let submission: ProviderSubmission;
  try {
    submission = await provider.submit(input);
  } catch (error) {
    return recordFailure(job, failureFrom(error), now);
  }

  let providerJobId: string;
  let providerStatus: ProviderQueuedState;
  let metadata: NormalizedProviderMetadata;
  try {
    providerJobId = normalizeProviderJobId(submission.providerJobId);
    providerStatus = normalizeProviderQueuedState(submission.status);
    metadata = normalizeProviderMetadata(submission.metadata, provider.id);
  } catch (error) {
    return recordFailure(job, failureFrom(error), now);
  }

  const updated = await prisma.analysisJob.updateMany({
    where: { id: job.id, status: "QUEUED", providerJobId: null },
    data: {
      status: providerStatus === "PROCESSING" ? "PROCESSING" : "QUEUED",
      providerJobId,
      providerStatus,
      providerVersion: metadata.providerVersion,
      providerMeta: JSON.stringify(metadata),
      submittedAt: now,
      lastAttemptAt: now,
      nextAttemptAt: new Date(now.getTime() + ANALYSIS_PROCESSING_LIMITS.pollIntervalMs),
      errorCategory: null,
      errorCode: null,
      errorMessage: null,
    },
  });
  if (updated.count === 0) {
    // The row moved (e.g. a concurrent terminal transition). The provider job
    // is reused on retry through the same idempotency key.
    return { outcome: "NOOP", jobId: job.id, status: null, reason: "concurrent" };
  }

  await recordAuditEvent({
    actorId: null,
    action: AUDIT_ACTIONS.ANALYSIS_JOB_SUBMITTED,
    targetType: "AnalysisJob",
    targetId: job.id,
    metadata: {
      documentId: job.documentId,
      requestId: job.requestId,
      type,
      provider: provider.id,
      attempt: job.attempts + 1,
    },
  });

  return { outcome: "SUBMITTED", jobId: job.id, status: providerStatus };
}

async function pollSimilarityJob(
  job: JobForProcessing,
  provider: SimilarityAnalysisProvider,
  now: Date,
): Promise<AnalysisProcessingOutcome> {
  const claimed = await claimForPoll(job, now);
  if (!claimed) {
    return { outcome: "NOOP", jobId: job.id, status: isAnalysisJobStatus(job.status) ? job.status : null, reason: "concurrent" };
  }

  let outcome: ProviderPollOutcome<SimilarityAnalysisResult>;
  try {
    outcome = await provider.poll(job.providerJobId!);
  } catch (error) {
    return recordFailure(job, failureFrom(error), now);
  }

  if (outcome.state !== "COMPLETED") {
    if (outcome.state === "FAILED") {
      return recordFailure(job, outcome.error, now);
    }
    return recordProgress(job, outcome.state, now);
  }

  let normalized: SimilarityAnalysisResult;
  try {
    normalized = normalizeSimilarityResult(outcome.result, {
      providerId: provider.id,
      providerJobId: job.providerJobId!,
    });
  } catch (error) {
    return recordFailure(job, failureFrom(error), now);
  }

  return completeSimilarityJob(job, normalized, provider.id, now);
}

async function pollAiWritingJob(
  job: JobForProcessing,
  provider: AiWritingAnalysisProvider,
  now: Date,
): Promise<AnalysisProcessingOutcome> {
  const claimed = await claimForPoll(job, now);
  if (!claimed) {
    return { outcome: "NOOP", jobId: job.id, status: isAnalysisJobStatus(job.status) ? job.status : null, reason: "concurrent" };
  }

  let outcome: ProviderPollOutcome<AiWritingAnalysisResult>;
  try {
    outcome = await provider.poll(job.providerJobId!);
  } catch (error) {
    return recordFailure(job, failureFrom(error), now);
  }

  if (outcome.state !== "COMPLETED") {
    if (outcome.state === "FAILED") {
      return recordFailure(job, outcome.error, now);
    }
    return recordProgress(job, outcome.state, now);
  }

  let normalized: AiWritingAnalysisResult;
  try {
    normalized = normalizeAiWritingResult(outcome.result, {
      providerId: provider.id,
      providerJobId: job.providerJobId!,
    });
  } catch (error) {
    return recordFailure(job, failureFrom(error), now);
  }

  return completeAiWritingJob(job, normalized, provider.id, now);
}

async function claimForPoll(job: JobForProcessing, now: Date): Promise<boolean> {
  const claim = await prisma.analysisJob.updateMany({
    where: {
      id: job.id,
      providerJobId: job.providerJobId,
      status: { in: ["QUEUED", "PROCESSING", "RETRYABLE"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    data: {
      status: "PROCESSING",
      lastAttemptAt: now,
      nextAttemptAt: new Date(now.getTime() + ANALYSIS_PROCESSING_LIMITS.leaseMs),
    },
  });
  return claim.count > 0;
}

async function recordProgress(
  job: JobForProcessing,
  state: ProviderQueuedState,
  now: Date,
): Promise<AnalysisProcessingOutcome> {
  await prisma.analysisJob.updateMany({
    where: { id: job.id, status: "PROCESSING" },
    data: {
      status: state === "QUEUED" ? "QUEUED" : "PROCESSING",
      providerStatus: state,
      failureCount: 0,
      errorCategory: null,
      errorCode: null,
      errorMessage: null,
      nextAttemptAt: new Date(now.getTime() + ANALYSIS_PROCESSING_LIMITS.pollIntervalMs),
    },
  });
  return { outcome: "PROGRESSING", jobId: job.id, status: state };
}

async function recordFailure(
  job: JobForProcessing,
  failure: AnalysisProviderFailure,
  now: Date,
): Promise<AnalysisProcessingOutcome> {
  const current = await prisma.analysisJob.findUnique({
    where: { id: job.id },
    select: { attempts: true, failureCount: true, status: true },
  });
  if (!current || !isAnalysisJobStatus(current.status) || isTerminalAnalysisStatus(current.status)) {
    return { outcome: "NOOP", jobId: job.id, status: null, reason: "already_terminal" };
  }

  // Never persist provider-supplied text or category strings. Only transient
  // and rate-limited failures are retried.
  const category = isAnalysisErrorCategory(failure.category) ? failure.category : "PERMANENT";
  const code = safeCode(failure.code);
  const message = SAFE_ERROR_MESSAGES[category];
  const retryableCategory = category === "TRANSIENT" || category === "RATE_LIMITED";

  const failureCount = current.failureCount + 1;
  // `attempts` counts actual analysis attempts (submissions for asynchronous
  // providers, calls for inline providers); `failureCount` counts transient
  // failures (including polls). Either budget exhausting makes the job FAILED.
  const withinBudget =
    current.attempts < ANALYSIS_PROCESSING_LIMITS.maxAttempts &&
    failureCount < ANALYSIS_PROCESSING_LIMITS.maxTransientFailures;
  const retry = failure.retryable && retryableCategory && withinBudget;
  const nextAttemptAt = retry
    ? new Date(now.getTime() + retryDelayMs(failureCount))
    : null;

  const updated = await prisma.analysisJob.updateMany({
    where: {
      id: job.id,
      status: { in: ["PENDING", "QUEUED", "PROCESSING", "RETRYABLE"] },
    },
    data: {
      status: retry ? "RETRYABLE" : "FAILED",
      failureCount,
      errorCategory: category,
      errorCode: code,
      errorMessage: message,
      nextAttemptAt,
      failedAt: retry ? null : now,
      activeKey: retry ? undefined : null,
    },
  });
  if (updated.count === 0) {
    return { outcome: "NOOP", jobId: job.id, status: null, reason: "concurrent" };
  }

  await recordAuditEvent({
    actorId: null,
    action: retry
      ? AUDIT_ACTIONS.ANALYSIS_JOB_RETRY_SCHEDULED
      : AUDIT_ACTIONS.ANALYSIS_JOB_FAILED,
    targetType: "AnalysisJob",
    targetId: job.id,
    metadata: {
      documentId: job.documentId,
      requestId: job.requestId,
      type: job.type,
      category,
      code,
      attempts: current.attempts,
      failureCount,
      ...(retry && nextAttemptAt ? { nextAttemptAt: nextAttemptAt.toISOString() } : {}),
    },
  });

  if (retry && nextAttemptAt) {
    return { outcome: "RETRY_SCHEDULED", jobId: job.id, retryAt: nextAttemptAt };
  }
  return { outcome: "FAILED", jobId: job.id };
}

/** Terminal, fail-closed transition for pre-flight policy failures. */
async function failJob(
  job: JobForProcessing,
  failure: AnalysisProviderFailure,
  now: Date,
): Promise<AnalysisProcessingOutcome> {
  const updated = await prisma.analysisJob.updateMany({
    where: {
      id: job.id,
      status: { in: ["PENDING", "QUEUED", "PROCESSING", "RETRYABLE"] },
    },
    data: {
      status: "FAILED",
      errorCategory: failure.category,
      errorCode: failure.code,
      errorMessage: failure.message,
      failedAt: now,
      nextAttemptAt: null,
      activeKey: null,
    },
  });
  if (updated.count === 0) {
    return { outcome: "NOOP", jobId: job.id, status: null, reason: "concurrent" };
  }

  await recordAuditEvent({
    actorId: null,
    action: AUDIT_ACTIONS.ANALYSIS_JOB_FAILED,
    targetType: "AnalysisJob",
    targetId: job.id,
    metadata: {
      documentId: job.documentId,
      requestId: job.requestId,
      type: job.type,
      category: failure.category,
      code: failure.code,
    },
  });

  return { outcome: "FAILED", jobId: job.id };
}

function failureFromStorage(): AnalysisProviderFailure {
  return {
    category: "TRANSIENT",
    code: "storage_unavailable",
    message: "The stored document could not be read. The analysis was not completed.",
    retryable: true,
  };
}

// ---------------------------------------------------------------------------
// Completion (result + job state in one transaction)
// ---------------------------------------------------------------------------

function resultMetadataJson(
  metadata: NormalizedProviderMetadata,
  type: AnalysisJobType,
  now: Date,
  extraction?: { version: string; pageCount: number | null },
): string {
  const disclaimer =
    type === "AI_WRITING"
      ? AI_DETECTION_DISCLAIMER
      : type === "LLM_REVIEW"
        ? LLM_OBSERVATION_DISCLAIMER
        : type === "LOCAL_SIMILARITY"
          ? LOCAL_CORPUS_DISCLAIMER
          : null;
  return JSON.stringify({
    providerId: metadata.providerId,
    providerVersion: metadata.providerVersion,
    modelVersion: metadata.modelVersion,
    thresholdPercent: metadata.thresholdPercent,
    ...(metadata.corpusId !== undefined ? { corpusId: metadata.corpusId } : {}),
    ...(metadata.corpusSize !== undefined ? { corpusSize: metadata.corpusSize } : {}),
    ...(metadata.algorithm !== undefined ? { algorithm: metadata.algorithm } : {}),
    ...(metadata.shingleSize !== undefined ? { shingleSize: metadata.shingleSize } : {}),
    ...(metadata.matchedTokens !== undefined ? { matchedTokens: metadata.matchedTokens } : {}),
    ...(metadata.totalTokens !== undefined ? { totalTokens: metadata.totalTokens } : {}),
    ...(metadata.limitations !== undefined ? { limitations: metadata.limitations } : {}),
    ...(metadata.llmDisclaimer !== undefined || type === "LLM_REVIEW"
      ? {
          llmDisclaimer:
            metadata.llmDisclaimer ?? LLM_OBSERVATION_DISCLAIMER,
        }
      : {}),
    ...(metadata.inputTokens !== undefined ? { inputTokens: metadata.inputTokens } : {}),
    ...(metadata.outputTokens !== undefined ? { outputTokens: metadata.outputTokens } : {}),
    ...(extraction ? { extractionVersion: extraction.version, pageCount: extraction.pageCount } : {}),
    normalizedAt: now.toISOString(),
    ...(disclaimer ? { disclaimer } : {}),
  });
}

async function completeLocalSimilarityJob(
  job: JobForProcessing,
  result: SimilarityAnalysisResult,
  providerId: string,
  extractionVersion: string,
  pageCount: number | null,
  now: Date,
): Promise<AnalysisProcessingOutcome> {
  const metadata = normalizeProviderMetadata(result.metadata, providerId);
  const metadataJson = resultMetadataJson(metadata, "LOCAL_SIMILARITY", now, {
    version: extractionVersion,
    pageCount,
  });
  const providerJobId = normalizeProviderJobId(result.providerJobId);

  try {
    const completed = await prisma.$transaction(async (tx) => {
      const cas = await tx.analysisJob.updateMany({
        where: { id: job.id, status: "PROCESSING", providerJobId: job.providerJobId },
        data: {
          status: "COMPLETED",
          providerJobId,
          providerStatus: "COMPLETED",
          providerVersion: metadata.providerVersion,
          providerMeta: JSON.stringify(metadata),
          completedAt: now,
          failedAt: null,
          nextAttemptAt: null,
          failureCount: 0,
          errorCategory: null,
          errorCode: null,
          errorMessage: null,
          activeKey: null,
        },
      });
      if (cas.count === 0) return false;

      await tx.analysisResult.create({
        data: {
          jobId: job.id,
          status: "COMPLETED",
          similarityPercent: result.overallSimilarityPercent,
          // Deliberately null: local matching never writes AI or LLM output.
          aiLikelihood: null,
          matches: JSON.stringify(result.matches),
          segments: null,
          observations: null,
          providerVersion: metadata.providerVersion,
          metadata: metadataJson,
          providerPayload: null,
        },
      });
      return true;
    });

    if (!completed) {
      return { outcome: "NOOP", jobId: job.id, status: "COMPLETED", reason: "concurrent" };
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return reconcileExistingResult(job, metadata, now);
    }
    throw error;
  }

  await auditCompleted(job, "LOCAL_SIMILARITY", providerId, result.matches.length);
  return { outcome: "COMPLETED", jobId: job.id };
}

async function completeLlmJob(
  job: JobForProcessing,
  result: LlmAnalysisResult,
  providerId: string,
  extractionVersion: string,
  pageCount: number | null,
  now: Date,
): Promise<AnalysisProcessingOutcome> {
  const metadata = normalizeProviderMetadata(result.metadata, providerId);
  metadata.llmDisclaimer = metadata.llmDisclaimer ?? LLM_OBSERVATION_DISCLAIMER;
  const metadataJson = resultMetadataJson(metadata, "LLM_REVIEW", now, {
    version: extractionVersion,
    pageCount,
  });
  const providerJobId = normalizeProviderJobId(result.providerJobId);

  try {
    const completed = await prisma.$transaction(async (tx) => {
      const cas = await tx.analysisJob.updateMany({
        where: { id: job.id, status: "PROCESSING", providerJobId: job.providerJobId },
        data: {
          status: "COMPLETED",
          providerJobId,
          providerStatus: "COMPLETED",
          providerVersion: metadata.providerVersion,
          providerMeta: JSON.stringify(metadata),
          completedAt: now,
          failedAt: null,
          nextAttemptAt: null,
          failureCount: 0,
          errorCategory: null,
          errorCode: null,
          errorMessage: null,
          activeKey: null,
        },
      });
      if (cas.count === 0) return false;

      await tx.analysisResult.create({
        data: {
          jobId: job.id,
          status: "COMPLETED",
          // Model observations are not a similarity score or AI-detection score.
          similarityPercent: null,
          aiLikelihood: null,
          matches: null,
          segments: null,
          observations: JSON.stringify(result.observations),
          providerVersion: metadata.providerVersion,
          metadata: metadataJson,
          providerPayload: null,
        },
      });
      return true;
    });

    if (!completed) {
      return { outcome: "NOOP", jobId: job.id, status: "COMPLETED", reason: "concurrent" };
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return reconcileExistingResult(job, metadata, now);
    }
    throw error;
  }

  await auditCompleted(
    job,
    "LLM_REVIEW",
    providerId,
    result.observations.citationReview.length + result.observations.matchExplanations.length,
  );
  return { outcome: "COMPLETED", jobId: job.id };
}

async function completeSimilarityJob(
  job: JobForProcessing,
  result: SimilarityAnalysisResult,
  providerId: string,
  now: Date,
): Promise<AnalysisProcessingOutcome> {
  const metadata = normalizeProviderMetadata(result.metadata, providerId);
  const metadataJson = resultMetadataJson(metadata, "SIMILARITY", now);

  try {
    const completed = await prisma.$transaction(async (tx) => {
      const cas = await tx.analysisJob.updateMany({
        where: {
          id: job.id,
          status: { in: ["QUEUED", "PROCESSING"] },
          providerJobId: job.providerJobId,
        },
        data: {
          status: "COMPLETED",
          providerStatus: "COMPLETED",
          providerVersion: metadata.providerVersion,
          providerMeta: JSON.stringify(metadata),
          completedAt: now,
          failedAt: null,
          nextAttemptAt: null,
          failureCount: 0,
          errorCategory: null,
          errorCode: null,
          errorMessage: null,
          activeKey: null,
        },
      });
      if (cas.count === 0) return false;

      await tx.analysisResult.create({
        data: {
          jobId: job.id,
          status: "COMPLETED",
          similarityPercent: result.overallSimilarityPercent,
          // Deliberately null: a similarity job can never write AI output.
          aiLikelihood: null,
          matches: JSON.stringify(result.matches),
          segments: null,
          providerVersion: metadata.providerVersion,
          metadata: metadataJson,
          // Never populated with a raw provider payload.
          providerPayload: null,
        },
      });
      return true;
    });

    if (!completed) {
      return { outcome: "NOOP", jobId: job.id, status: "COMPLETED", reason: "concurrent" };
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return reconcileExistingResult(job, metadata, now);
    }
    throw error;
  }

  await auditCompleted(job, "SIMILARITY", providerId, result.matches.length);
  return { outcome: "COMPLETED", jobId: job.id };
}

async function completeAiWritingJob(
  job: JobForProcessing,
  result: AiWritingAnalysisResult,
  providerId: string,
  now: Date,
): Promise<AnalysisProcessingOutcome> {
  const metadata = normalizeProviderMetadata(result.metadata, providerId);
  const metadataJson = resultMetadataJson(metadata, "AI_WRITING", now);

  try {
    const completed = await prisma.$transaction(async (tx) => {
      const cas = await tx.analysisJob.updateMany({
        where: {
          id: job.id,
          status: { in: ["QUEUED", "PROCESSING"] },
          providerJobId: job.providerJobId,
        },
        data: {
          status: "COMPLETED",
          providerStatus: "COMPLETED",
          providerVersion: metadata.providerVersion,
          providerMeta: JSON.stringify(metadata),
          completedAt: now,
          failedAt: null,
          nextAttemptAt: null,
          failureCount: 0,
          errorCategory: null,
          errorCode: null,
          errorMessage: null,
          activeKey: null,
        },
      });
      if (cas.count === 0) return false;

      await tx.analysisResult.create({
        data: {
          jobId: job.id,
          status: "COMPLETED",
          // Deliberately null: an AI-writing job can never write similarity.
          similarityPercent: null,
          aiLikelihood: result.aiLikelihood,
          matches: null,
          segments: JSON.stringify(result.segments),
          providerVersion: metadata.providerVersion,
          metadata: metadataJson,
          providerPayload: null,
        },
      });
      return true;
    });

    if (!completed) {
      return { outcome: "NOOP", jobId: job.id, status: "COMPLETED", reason: "concurrent" };
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return reconcileExistingResult(job, metadata, now);
    }
    throw error;
  }

  await auditCompleted(job, "AI_WRITING", providerId, result.segments.length);
  return { outcome: "COMPLETED", jobId: job.id };
}

/**
 * A concurrent worker won the result insert. The transaction rolled back, so
 * reconcile the job to the result that already exists instead of retrying a
 * billable completion path or overwriting evidence.
 */
async function reconcileExistingResult(
  job: JobForProcessing,
  metadata: NormalizedProviderMetadata,
  now: Date,
): Promise<AnalysisProcessingOutcome> {
  const existing = await prisma.analysisResult.findUnique({ where: { jobId: job.id } });
  if (!existing) {
    return { outcome: "NOOP", jobId: job.id, status: null, reason: "result_conflict" };
  }
  await prisma.analysisJob.updateMany({
    where: { id: job.id, status: { in: ["QUEUED", "PROCESSING"] } },
    data: {
      status: "COMPLETED",
      providerStatus: "COMPLETED",
      providerVersion: metadata.providerVersion,
      providerMeta: JSON.stringify(metadata),
      completedAt: existing.createdAt ?? now,
      failedAt: null,
      nextAttemptAt: null,
      failureCount: 0,
      errorCategory: null,
      errorCode: null,
      errorMessage: null,
      activeKey: null,
    },
  });
  // The existing result is the authoritative evidence and is never overwritten.
  return { outcome: "NOOP", jobId: job.id, status: "COMPLETED", reason: "already_completed" };
}

async function auditCompleted(
  job: JobForProcessing,
  type: AnalysisJobType,
  providerId: string,
  matchCount: number,
): Promise<void> {
  await recordAuditEvent({
    actorId: null,
    action: AUDIT_ACTIONS.ANALYSIS_JOB_COMPLETED,
    targetType: "AnalysisJob",
    targetId: job.id,
    metadata: {
      documentId: job.documentId,
      requestId: job.requestId,
      type,
      provider: providerId,
      // Safe aggregate only; no document text or score content.
      itemCount: matchCount,
    },
  });
}

// ---------------------------------------------------------------------------
// Worker discovery (DB-backed; no in-memory queue)
// ---------------------------------------------------------------------------

/**
 * Ids of jobs due for a provider step, ordered by due time. A scheduler or
 * cron worker should iterate these and call processAnalysisJob sequentially or
 * with bounded concurrency. Conditional claims make concurrent workers safe.
 */
export async function findDueAnalysisJobIds(args?: {
  limit?: number;
  now?: Date;
}): Promise<string[]> {
  const now = args?.now ?? new Date();
  const limit = Math.min(
    Math.max(args?.limit ?? ANALYSIS_PROCESSING_LIMITS.maxDueJobs, 1),
    100,
  );
  const rows = await prisma.analysisJob.findMany({
    where: {
      status: { in: ["PENDING", "QUEUED", "PROCESSING", "RETRYABLE"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
