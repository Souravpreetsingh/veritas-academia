// Strict normalization for provider output.
//
// Provider adapters are the only place that knows a provider's raw response
// shape. Before results reach the database, they pass through these validators:
//   * scores are numbers in [0, 100], or null when unavailable — never a
//     fabricated 0 and never silently clamped;
//   * offsets/lengths are safe integers pointing into the original document;
//   * source URLs are http(s) only (no javascript:/data: links);
//   * only an explicit allow-list of metadata fields is retained;
//   * raw provider payloads, arbitrary provider keys, and model-supplied source
//     records are dropped. Only bounded evidence excerpts and document-derived
//     citation slices are retained.

import {
  AnalysisResultValidationError,
  LLM_OBSERVATION_DISCLAIMER,
  LLM_WRITING_PATTERN_DISCLAIMER,
  type AiWritingAnalysisResult,
  type AiWritingSegment,
  type LlmAnalysisResult,
  type LlmCitationReviewPassage,
  type LlmMatchExplanation,
  type LlmObservations,
  type LlmWritingPatternObservation,
  type NormalizedProviderMetadata,
  type ProviderQueuedState,
  type SimilarityAnalysisResult,
  type SimilaritySourceMatch,
} from "./types";

export const ANALYSIS_RESULT_LIMITS = {
  maxMatches: 500,
  maxSegments: 1_000,
  maxSourceIdLength: 200,
  maxSourceTitleLength: 300,
  maxSourceUrlLength: 2_048,
  maxVersionLength: 100,
  maxProviderJobIdLength: 200,
  maxMatchIdLength: 100,
  maxExcerptLength: 400,
  maxCitationPassages: 20,
  maxCitationPassageLength: 1_000,
  maxCitationReasonLength: 600,
  maxMatchExplanations: 50,
  maxMatchExplanationLength: 1_200,
  maxWritingPatternObservations: 8,
  maxWritingPatternLength: 300,
  maxWritingPatternExplanationLength: 600,
  maxQuestions: 12,
  maxQuestionLength: 300,
  maxLimitations: 8,
  maxLimitationLength: 300,
  maxOverviewLength: 4_000,
  maxQualityLength: 4_000,
  maxReportSummaryLength: 6_000,
} as const;

const LLM_LIMITATION_FALLBACK =
  "Observations cover only the extracted document text and the supplied local-corpus matches. The model cannot verify authorship, originality, or sources outside that material.";

function invalid(message: string): never {
  throw new AnalysisResultValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") invalid(`${field} must be a string or null.`);
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \u00a0]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned === "") return null;
  if (cleaned.length > maxLength) invalid(`${field} is too long.`);
  return cleaned;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const cleaned = cleanText(value, field, maxLength);
  if (!cleaned) invalid(`${field} is required.`);
  return cleaned;
}

/** Display-safe excerpt: control characters removed and whitespace collapsed. */
function cleanExcerpt(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ANALYSIS_RESULT_LIMITS.maxExcerptLength);
}

function cleanIdentifier(value: unknown, field: string): string | null {
  const cleaned = cleanText(value, field, ANALYSIS_RESULT_LIMITS.maxMatchIdLength);
  if (!cleaned) return null;
  return /^[A-Za-z0-9_.:-]+$/.test(cleaned) ? cleaned : null;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  return cleanText(value, field, maxLength);
}

function optionalCount(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${field} must be a non-negative integer or null.`);
  }
  return value;
}

/** Accept only http(s) URLs; anything else is unusable and normalized to null. */
function safeSourceUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") invalid("sourceUrl must be a string or null.");
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > ANALYSIS_RESULT_LIMITS.maxSourceUrlLength) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** null means "not produced"; an explicit 0 is preserved. */
export function normalizePercent(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    invalid(`${field} must be a number between 0 and 100, or null when unavailable.`);
  }
  return Math.round(value * 100) / 100;
}

function normalizeOffset(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${field} must be a non-negative integer.`);
  }
  return value;
}

function normalizeLength(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    invalid(`${field} must be a positive integer.`);
  }
  return value;
}

export function normalizeSimilarityMatches(value: unknown): SimilaritySourceMatch[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) invalid("matches must be an array.");
  if (value.length > ANALYSIS_RESULT_LIMITS.maxMatches) invalid("Too many source matches.");

  return value.map((item, index) => {
    if (!isRecord(item)) invalid(`matches[${index}] must be an object.`);
    const sourceExcerpt =
      typeof item.sourceExcerpt === "string" ? cleanExcerpt(item.sourceExcerpt) : null;
    const matchedExcerpt =
      typeof item.matchedExcerpt === "string" ? cleanExcerpt(item.matchedExcerpt) : null;
    return {
      matchId: cleanIdentifier(item.matchId, `matches[${index}].matchId`),
      offset: normalizeOffset(item.offset, `matches[${index}].offset`),
      length: normalizeLength(item.length, `matches[${index}].length`),
      similarityPercent: normalizePercent(
        item.similarityPercent,
        `matches[${index}].similarityPercent`,
      ),
      sourceId: cleanText(
        item.sourceId,
        `matches[${index}].sourceId`,
        ANALYSIS_RESULT_LIMITS.maxSourceIdLength,
      ),
      sourceTitle: cleanText(
        item.sourceTitle,
        `matches[${index}].sourceTitle`,
        ANALYSIS_RESULT_LIMITS.maxSourceTitleLength,
      ),
      sourceUrl: safeSourceUrl(item.sourceUrl),
      sourceExcerpt: sourceExcerpt || null,
      matchedExcerpt: matchedExcerpt || null,
    };
  });
}

export function normalizeAiSegments(value: unknown): AiWritingSegment[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) invalid("segments must be an array.");
  if (value.length > ANALYSIS_RESULT_LIMITS.maxSegments) invalid("Too many AI segments.");

  return value.map((item, index) => {
    if (!isRecord(item)) invalid(`segments[${index}] must be an object.`);
    return {
      offset: normalizeOffset(item.offset, `segments[${index}].offset`),
      length: normalizeLength(item.length, `segments[${index}].length`),
      aiLikelihood: normalizePercent(item.aiLikelihood, `segments[${index}].aiLikelihood`),
    };
  });
}

function normalizeVersion(value: unknown, field: string): string | null {
  return cleanText(value, field, ANALYSIS_RESULT_LIMITS.maxVersionLength);
}

/**
 * Retain only the documented metadata fields. Arbitrary provider keys are
 * intentionally dropped so a raw response can never leak into the database.
 */
export function normalizeProviderMetadata(
  value: unknown,
  providerId: string,
): NormalizedProviderMetadata {
  if (value === null || value === undefined) {
    return { providerId, providerVersion: null, modelVersion: null, thresholdPercent: null };
  }
  if (!isRecord(value)) invalid("metadata must be an object or null.");

  const reportedProviderId = value.providerId;
  if (
    reportedProviderId !== null &&
    reportedProviderId !== undefined &&
    reportedProviderId !== providerId
  ) {
    invalid("Provider metadata belongs to a different provider.");
  }

  const metadata: NormalizedProviderMetadata = {
    providerId,
    providerVersion: normalizeVersion(value.providerVersion, "metadata.providerVersion"),
    modelVersion: normalizeVersion(value.modelVersion, "metadata.modelVersion"),
    thresholdPercent: normalizePercent(value.thresholdPercent, "metadata.thresholdPercent"),
  };

  // Only these documented optional fields survive; unknown keys are dropped.
  // Fields are omitted when the adapter did not provide them so existing
  // provider metadata shapes (and tests) stay stable.
  const corpusId = optionalText(value.corpusId, "metadata.corpusId", 100);
  if (corpusId !== undefined) metadata.corpusId = corpusId;
  const corpusSize = optionalCount(value.corpusSize, "metadata.corpusSize");
  if (corpusSize !== undefined) metadata.corpusSize = corpusSize;
  const algorithm = optionalText(value.algorithm, "metadata.algorithm", 100);
  if (algorithm !== undefined) metadata.algorithm = algorithm;
  const shingleSize = optionalCount(value.shingleSize, "metadata.shingleSize");
  if (shingleSize !== undefined) metadata.shingleSize = shingleSize;
  const matchedTokens = optionalCount(value.matchedTokens, "metadata.matchedTokens");
  if (matchedTokens !== undefined) metadata.matchedTokens = matchedTokens;
  const totalTokens = optionalCount(value.totalTokens, "metadata.totalTokens");
  if (totalTokens !== undefined) metadata.totalTokens = totalTokens;
  const limitations = optionalText(value.limitations, "metadata.limitations", 500);
  if (limitations !== undefined) metadata.limitations = limitations;
  const llmDisclaimer = optionalText(value.llmDisclaimer, "metadata.llmDisclaimer", 500);
  if (llmDisclaimer !== undefined) metadata.llmDisclaimer = llmDisclaimer;
  const inputTokens = optionalCount(value.inputTokens, "metadata.inputTokens");
  if (inputTokens !== undefined) metadata.inputTokens = inputTokens;
  const outputTokens = optionalCount(value.outputTokens, "metadata.outputTokens");
  if (outputTokens !== undefined) metadata.outputTokens = outputTokens;

  return metadata;
}

export function normalizeProviderJobId(value: unknown): string {
  if (typeof value !== "string") invalid("The provider did not return a job identifier.");
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > ANALYSIS_RESULT_LIMITS.maxProviderJobIdLength) {
    invalid("The provider returned an invalid job identifier.");
  }
  return trimmed;
}

export function normalizeProviderQueuedState(value: unknown): ProviderQueuedState {
  if (value === "QUEUED" || value === "PROCESSING") return value;
  invalid("The provider returned an invalid job status.");
}

export function normalizeSimilarityResult(
  value: unknown,
  context: { providerId: string; providerJobId: string },
): SimilarityAnalysisResult {
  if (!isRecord(value)) invalid("The similarity result must be an object.");
  if (
    value.providerJobId !== null &&
    value.providerJobId !== undefined &&
    value.providerJobId !== context.providerJobId
  ) {
    invalid("The provider result does not match the submitted job.");
  }

  return {
    providerJobId: context.providerJobId,
    overallSimilarityPercent: normalizePercent(
      value.overallSimilarityPercent,
      "overallSimilarityPercent",
    ),
    matches: normalizeSimilarityMatches(value.matches),
    metadata: normalizeProviderMetadata(value.metadata, context.providerId),
  };
}

export function normalizeAiWritingResult(
  value: unknown,
  context: { providerId: string; providerJobId: string },
): AiWritingAnalysisResult {
  if (!isRecord(value)) invalid("The AI-writing result must be an object.");
  if (
    value.providerJobId !== null &&
    value.providerJobId !== undefined &&
    value.providerJobId !== context.providerJobId
  ) {
    invalid("The provider result does not match the submitted job.");
  }

  return {
    providerJobId: context.providerJobId,
    aiLikelihood: normalizePercent(value.aiLikelihood, "aiLikelihood"),
    segments: normalizeAiSegments(value.segments),
    metadata: normalizeProviderMetadata(value.metadata, context.providerId),
  };
}

// ---------------------------------------------------------------------------
// LLM-assisted observations
// ---------------------------------------------------------------------------

function normalizeCitationReview(
  value: unknown,
  text: string,
): LlmCitationReviewPassage[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) invalid("observations.citationReview must be an array.");

  // Valid items beyond the display bound are discarded rather than failing an
  // otherwise usable (and already billable) model response.
  return value.slice(0, ANALYSIS_RESULT_LIMITS.maxCitationPassages).map((item, index) => {
    if (!isRecord(item)) invalid(`observations.citationReview[${index}] must be an object.`);
    const offset = normalizeOffset(
      item.offset,
      `observations.citationReview[${index}].offset`,
    );
    const length = normalizeLength(
      item.length,
      `observations.citationReview[${index}].length`,
    );
    if (length > ANALYSIS_RESULT_LIMITS.maxCitationPassageLength) {
      invalid(`observations.citationReview[${index}].length is too long.`);
    }
    if (offset + length > text.length) {
      invalid(`observations.citationReview[${index}] points outside the document.`);
    }
    const excerpt = cleanExcerpt(text.slice(offset, offset + length));
    if (!excerpt) invalid(`observations.citationReview[${index}] is empty.`);
    return {
      offset,
      length,
      excerpt,
      reason: requiredText(
        item.reason,
        `observations.citationReview[${index}].reason`,
        ANALYSIS_RESULT_LIMITS.maxCitationReasonLength,
      ),
    };
  });
}

function normalizeMatchExplanations(
  value: unknown,
  allowedMatchIds: Set<string>,
): LlmMatchExplanation[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) invalid("observations.matchExplanations must be an array.");

  const seen = new Set<string>();
  const explanations: LlmMatchExplanation[] = [];
  for (const [index, item] of value
    .slice(0, ANALYSIS_RESULT_LIMITS.maxMatchExplanations)
    .entries()) {
    if (!isRecord(item)) {
      invalid(`observations.matchExplanations[${index}] must be an object.`);
    }
    const matchId = cleanIdentifier(
      item.matchId,
      `observations.matchExplanations[${index}].matchId`,
    );
    // Unsupported/invented match ids are dropped rather than stored as
    // evidence. Only matches produced by the local engine may be explained.
    if (!matchId || !allowedMatchIds.has(matchId) || seen.has(matchId)) continue;
    seen.add(matchId);
    explanations.push({
      matchId,
      explanation: requiredText(
        item.explanation,
        `observations.matchExplanations[${index}].explanation`,
        ANALYSIS_RESULT_LIMITS.maxMatchExplanationLength,
      ),
    });
  }
  return explanations;
}

/**
 * Writing-pattern observations are qualitative only: there is no likelihood,
 * score, or confidence field, so the model cannot return an invented number
 * here. Malformed/incomplete individual entries are dropped; strings that are
 * present but unusable (wrong type is impossible — non-strings are dropped —
 * or over the length bound) reject the whole response, matching the other
 * strict text fields.
 */
function normalizeWritingPatternObservations(
  value: unknown,
): LlmWritingPatternObservation[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    invalid("observations.writingPatternObservations must be an array.");
  }

  const observations: LlmWritingPatternObservation[] = [];
  for (const [index, item] of value
    .slice(0, ANALYSIS_RESULT_LIMITS.maxWritingPatternObservations)
    .entries()) {
    if (!isRecord(item)) continue;
    if (typeof item.pattern !== "string" || typeof item.explanation !== "string") continue;
    const pattern = cleanText(
      item.pattern,
      `observations.writingPatternObservations[${index}].pattern`,
      ANALYSIS_RESULT_LIMITS.maxWritingPatternLength,
    );
    const explanation = cleanText(
      item.explanation,
      `observations.writingPatternObservations[${index}].explanation`,
      ANALYSIS_RESULT_LIMITS.maxWritingPatternExplanationLength,
    );
    if (!pattern || !explanation) continue;
    observations.push({ pattern, explanation });
  }
  return observations;
}

function normalizeStringList(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) invalid(`${field} must be an array.`);
  const result: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    if (typeof item !== "string" || item.trim() === "") continue;
    result.push(requiredText(item, field, maxLength));
  }
  return result;
}

/**
 * Validate the model's structured observations. Excerpts are derived from the
 * supplied document text by offset; the model's own excerpt/URL/citation text
 * is ignored. Explanations may only reference real local-match ids.
 */
export function normalizeLlmAnalysisResult(
  value: unknown,
  context: {
    providerId: string;
    providerJobId: string;
    text: string;
    allowedMatchIds: string[];
  },
): LlmAnalysisResult {
  if (!isRecord(value)) invalid("The LLM result must be an object.");
  if (
    value.providerJobId !== null &&
    value.providerJobId !== undefined &&
    value.providerJobId !== context.providerJobId
  ) {
    invalid("The provider result does not match the submitted job.");
  }
  const observations = value.observations;
  if (!isRecord(observations)) invalid("observations must be an object.");

  const limitations = normalizeStringList(
    observations.limitations,
    "observations.limitations",
    ANALYSIS_RESULT_LIMITS.maxLimitations,
    ANALYSIS_RESULT_LIMITS.maxLimitationLength,
  );
  if (limitations.length === 0) limitations.push(LLM_LIMITATION_FALLBACK);

  // Writing-pattern observations always carry their false-positive disclaimer,
  // whether or not the model itself listed one. It is placed first so it
  // survives the list bound.
  const writingPatternObservations = normalizeWritingPatternObservations(
    observations.writingPatternObservations,
  );
  if (
    writingPatternObservations.length > 0 &&
    !limitations.includes(LLM_WRITING_PATTERN_DISCLAIMER)
  ) {
    limitations.unshift(LLM_WRITING_PATTERN_DISCLAIMER);
    limitations.length = Math.min(limitations.length, ANALYSIS_RESULT_LIMITS.maxLimitations);
  }

  const normalized: LlmObservations = {
    documentOverview: requiredText(
      observations.documentOverview,
      "observations.documentOverview",
      ANALYSIS_RESULT_LIMITS.maxOverviewLength,
    ),
    structureAndQuality: requiredText(
      observations.structureAndQuality,
      "observations.structureAndQuality",
      ANALYSIS_RESULT_LIMITS.maxQualityLength,
    ),
    citationReview: normalizeCitationReview(observations.citationReview, context.text),
    matchExplanations: normalizeMatchExplanations(
      observations.matchExplanations,
      new Set(context.allowedMatchIds),
    ),
    writingPatternObservations,
    instructorQuestions: normalizeStringList(
      observations.instructorQuestions,
      "observations.instructorQuestions",
      ANALYSIS_RESULT_LIMITS.maxQuestions,
      ANALYSIS_RESULT_LIMITS.maxQuestionLength,
    ),
    reportSummary: requiredText(
      observations.reportSummary,
      "observations.reportSummary",
      ANALYSIS_RESULT_LIMITS.maxReportSummaryLength,
    ),
    limitations,
  };

  const metadata = normalizeProviderMetadata(value.metadata, context.providerId);
  // Persist the disclaimer with the result regardless of model output.
  metadata.llmDisclaimer = LLM_OBSERVATION_DISCLAIMER;

  return {
    providerJobId: context.providerJobId,
    observations: normalized,
    metadata,
  };
}
