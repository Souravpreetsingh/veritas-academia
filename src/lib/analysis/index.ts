// Provider registry for document analysis.
//
// Local matching and the consent-gated LLM adapter (OpenAI Chat Completions or
// Google Gemini Interactions API, selected by LLM_PROVIDER) are implemented.
// Specialist similarity/AI-writing providers remain unconfigured: the registry
// returns an explicit unconfigured/unavailable adapter that reports
// NOT_CONFIGURED and throws on use. It never returns mock scores, fake matches,
// or a successful result.
//
// To integrate a specialist provider later:
//   1. implement the adapter contract in ./types.ts (submit/poll/status);
//   2. map the provider's errors to AnalysisProviderError categories;
//   3. normalize output with ./normalize.ts;
//   4. register the adapter here behind SIMILARITY_PROVIDER / AI_WRITING_PROVIDER.
// Adapter-specific credentials stay server-side and are never sent to clients.

import { readEnv } from "@/lib/env";
import { createLocalSimilarityProvider } from "./local-similarity";
import { getLlmProvider, llmProviderStatus } from "./llm";
import {
  AnalysisProviderError,
  AnalysisUnavailableError,
  type AiWritingAnalysisProvider,
  type AnalysisProviderStatus,
  type LocalSimilarityProvider,
  type ProviderPollOutcome,
  type SimilarityAnalysisProvider,
} from "./types";

export const UNCONFIGURED_PROVIDER_ID = "unconfigured";

function configuredId(envName: "SIMILARITY_PROVIDER" | "AI_WRITING_PROVIDER"): string {
  return readEnv(envName)?.trim() || UNCONFIGURED_PROVIDER_ID;
}

function statusFor(
  providerId: string,
  kind: "SIMILARITY" | "AI_WRITING",
  state: AnalysisProviderStatus["state"],
  configured: boolean,
  message: string,
): AnalysisProviderStatus {
  return { providerId, kind, state, configured, message };
}

function unconfiguredSimilarityProvider(
  providerId = UNCONFIGURED_PROVIDER_ID,
): SimilarityAnalysisProvider {
  const message =
    "Similarity analysis is not configured on the server. No analysis has been run.";
  const fail = (): never => {
    throw new AnalysisUnavailableError(providerId, message);
  };
  return {
    id: providerId,
    kind: "SIMILARITY",
    status: () => statusFor(providerId, "SIMILARITY", "NOT_CONFIGURED", false, message),
    async submit() {
      return fail();
    },
    async poll(): Promise<ProviderPollOutcome<never>> {
      return fail();
    },
  };
}

function unconfiguredAiWritingProvider(
  providerId = UNCONFIGURED_PROVIDER_ID,
): AiWritingAnalysisProvider {
  const message =
    "AI-writing analysis is not configured on the server. No analysis has been run.";
  const fail = (): never => {
    throw new AnalysisUnavailableError(providerId, message);
  };
  return {
    id: providerId,
    kind: "AI_WRITING",
    status: () => statusFor(providerId, "AI_WRITING", "NOT_CONFIGURED", false, message),
    async submit() {
      return fail();
    },
    async poll(): Promise<ProviderPollOutcome<never>> {
      return fail();
    },
  };
}

function unimplementedSimilarityProvider(providerId: string): SimilarityAnalysisProvider {
  const message =
    "The configured similarity provider is not implemented on this server. No analysis has been run.";
  const fail = (): never => {
    throw new AnalysisProviderError({
      category: "CONFIGURATION",
      code: "provider_not_implemented",
      message,
      retryable: false,
    });
  };
  return {
    id: providerId,
    kind: "SIMILARITY",
    status: () => statusFor(providerId, "SIMILARITY", "UNAVAILABLE", false, message),
    async submit() {
      return fail();
    },
    async poll(): Promise<ProviderPollOutcome<never>> {
      return fail();
    },
  };
}

function unimplementedAiWritingProvider(providerId: string): AiWritingAnalysisProvider {
  const message =
    "The configured AI-writing provider is not implemented on this server. No analysis has been run.";
  const fail = (): never => {
    throw new AnalysisProviderError({
      category: "CONFIGURATION",
      code: "provider_not_implemented",
      message,
      retryable: false,
    });
  };
  return {
    id: providerId,
    kind: "AI_WRITING",
    status: () => statusFor(providerId, "AI_WRITING", "UNAVAILABLE", false, message),
    async submit() {
      return fail();
    },
    async poll(): Promise<ProviderPollOutcome<never>> {
      return fail();
    },
  };
}

export function getSimilarityProvider(): SimilarityAnalysisProvider {
  const id = configuredId("SIMILARITY_PROVIDER").toLowerCase();
  if (id === UNCONFIGURED_PROVIDER_ID) return unconfiguredSimilarityProvider();
  return unimplementedSimilarityProvider(id);
}

export function getAiWritingProvider(): AiWritingAnalysisProvider {
  const id = configuredId("AI_WRITING_PROVIDER").toLowerCase();
  if (id === UNCONFIGURED_PROVIDER_ID) return unconfiguredAiWritingProvider();
  return unimplementedAiWritingProvider(id);
}

/** Local corpus matching always runs in-process and needs no credentials. */
export function getLocalSimilarityProvider(): LocalSimilarityProvider {
  return createLocalSimilarityProvider();
}

export interface AnalysisAvailability {
  /** Specialist plagiarism provider (future integration). */
  similarity: AnalysisProviderStatus;
  /** Specialist AI-writing detector (future integration). */
  aiWriting: AnalysisProviderStatus;
  localSimilarity: AnalysisProviderStatus;
  llmReview: AnalysisProviderStatus;
}

/** Safe availability snapshot for server-rendered UI / diagnostics. */
export function analysisAvailability(): AnalysisAvailability {
  return {
    similarity: getSimilarityProvider().status(),
    aiWriting: getAiWritingProvider().status(),
    localSimilarity: getLocalSimilarityProvider().status(),
    llmReview: llmProviderStatus(),
  };
}

// Exported for tests and future adapter registration.
export {
  unconfiguredAiWritingProvider,
  unconfiguredSimilarityProvider,
  getLlmProvider,
  llmProviderStatus,
};

export * from "./types";
export * from "./normalize";
export * from "./local-corpus";
export * from "./local-similarity";
export * from "./llm";
