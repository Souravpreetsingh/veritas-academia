import { readEnv } from "@/lib/env";
import {
  AnalysisUnavailableError,
  type AiWritingAnalysisProvider,
  type AnalysisAvailability,
  type SimilarityAnalysisProvider,
} from "./types";

export * from "./types";

// The initial provider state is explicitly unconfigured. A provider is only
// considered configured when a real, authorized integration is wired up in a
// later phase. Until then every analysis call fails loudly.

const UNAVAILABLE_MESSAGE =
  "Document analysis is not configured yet. No similarity or AI-writing results can be produced.";

function unconfiguredAvailability(providerId: string): AnalysisAvailability {
  return {
    configured: false,
    providerId,
    status: "UNCONFIGURED",
    message: UNAVAILABLE_MESSAGE,
  };
}

const unconfiguredSimilarity: SimilarityAnalysisProvider = {
  id: "unconfigured",
  configured: false,
  availability: () => unconfiguredAvailability("unconfigured"),
  async analyze() {
    throw new AnalysisUnavailableError("unconfigured", UNAVAILABLE_MESSAGE);
  },
};

const unconfiguredAiWriting: AiWritingAnalysisProvider = {
  id: "unconfigured",
  configured: false,
  availability: () => unconfiguredAvailability("unconfigured"),
  async analyze() {
    throw new AnalysisUnavailableError("unconfigured", UNAVAILABLE_MESSAGE);
  },
};

export function getSimilarityProvider(): SimilarityAnalysisProvider {
  const id = readEnv("SIMILARITY_PROVIDER") ?? "unconfigured";
  if (id === "unconfigured") return unconfiguredSimilarity;
  throw new AnalysisUnavailableError(id, `Similarity provider "${id}" is not implemented.`);
}

export function getAiWritingProvider(): AiWritingAnalysisProvider {
  const id = readEnv("AI_WRITING_PROVIDER") ?? "unconfigured";
  if (id === "unconfigured") return unconfiguredAiWriting;
  throw new AnalysisUnavailableError(id, `AI-writing provider "${id}" is not implemented.`);
}

/** Availability snapshot for rendering explicit unconfigured/pending states. */
export function analysisAvailability() {
  return {
    similarity: getSimilarityProvider().availability(),
    aiWriting: getAiWritingProvider().availability(),
  };
}
