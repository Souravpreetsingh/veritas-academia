// Analysis-provider interface.
//
// The platform performs document similarity analysis and AI-writing analysis
// only through an explicitly configured, authorized provider. No results are
// ever fabricated: when the provider is unconfigured, callers receive an
// "unavailable" state and must surface that to the user.

export type AnalysisJobStatus =
  | "UNCONFIGURED"
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED";

export interface AnalysisAvailability {
  configured: boolean;
  providerId: string;
  status: AnalysisJobStatus;
  /** Human-readable explanation shown in the UI. */
  message: string;
}

export interface SimilarityMatch {
  matchedText: string;
  offset: number;
  length: number;
  sourceTitle: string | null;
  sourceUrl: string | null;
  similarityPercent: number | null;
}

export interface SimilarityReport {
  jobId: string;
  documentId: string;
  status: AnalysisJobStatus;
  overallSimilarityPercent: number | null;
  matches: SimilarityMatch[];
  completedAt: Date | null;
}

export interface AiWritingSegment {
  offset: number;
  length: number;
  aiLikelihood: number | null;
}

export interface AiWritingReport {
  jobId: string;
  documentId: string;
  status: AnalysisJobStatus;
  aiLikelihood: number | null;
  segments: AiWritingSegment[];
  completedAt: Date | null;
}

export interface SimilarityAnalysisInput {
  documentId: string;
  storageKey: string;
  contentType: string;
}

export interface AiWritingAnalysisInput {
  documentId: string;
  storageKey: string;
  contentType: string;
}

export interface SimilarityAnalysisProvider {
  readonly id: string;
  readonly configured: boolean;
  availability(): AnalysisAvailability;
  analyze(input: SimilarityAnalysisInput): Promise<SimilarityReport>;
}

export interface AiWritingAnalysisProvider {
  readonly id: string;
  readonly configured: boolean;
  availability(): AnalysisAvailability;
  analyze(input: AiWritingAnalysisInput): Promise<AiWritingReport>;
}

/** Thrown whenever a real analysis cannot be produced. Never invent results. */
export class AnalysisUnavailableError extends Error {
  readonly providerId: string;
  constructor(providerId: string, message: string) {
    super(message);
    this.name = "AnalysisUnavailableError";
    this.providerId = providerId;
  }
}
