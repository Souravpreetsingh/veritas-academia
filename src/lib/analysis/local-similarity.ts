// Deterministic local-corpus similarity.
//
// Algorithm (word-shingle-v1):
//   1. Tokenize the document and each permitted source into Unicode word tokens.
//   2. NFKC-normalize + lowercase token values.
//   3. Build a map of every 8-token source shingle.
//   4. Slide 8-token windows over the document; mark tokens whose normalized
//      shingle occurs in a source (plus the corresponding source tokens).
//   5. Group consecutive matched document tokens into passages. A passage is
//      reported only when it spans at least one full shingle (8 tokens).
//
// The reported percentage is the fraction of the document's extracted word
// tokens covered by at least one exact normalized 8-token match. It is a real,
// reproducible corpus-overlap metric, not a plagiarism probability. No source
// is fetched at runtime; the corpus is explicit static data.
//
// `documentId` on a source is a hard self-exclusion guard. Runtime code passes
// only the bundled public-domain corpus. Private submissions must never be
// added to a shared corpus.

import { createHash } from "node:crypto";
import {
  LOCAL_CORPUS_DISCLAIMER,
  type AnalysisProviderStatus,
  type LocalSimilarityInput,
  type LocalSimilarityProvider,
  type SimilarityAnalysisResult,
  type SimilaritySourceMatch,
} from "./types";
import {
  LOCAL_CORPUS_ID,
  LOCAL_CORPUS_SOURCES,
  type LocalCorpusSource,
} from "./local-corpus";

export const LOCAL_CORPUS_PROVIDER_ID = "local-corpus";
export const LOCAL_SIMILARITY_VERSION = "word-shingle-v1";
export const LOCAL_SHINGLE_SIZE = 8;
const MAX_LOCAL_MATCHES = 100;
const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

interface Token {
  value: string;
  start: number;
  end: number;
}

export interface LocalMatchSet {
  matches: SimilaritySourceMatch[];
  matchedTokens: number;
  totalTokens: number;
  overallSimilarityPercent: number | null;
  algorithm: typeof LOCAL_SIMILARITY_VERSION;
  shingleSize: number;
}

interface SourceMatchState {
  source: LocalCorpusSource;
  matchedDocumentTokens: Set<number>;
  /** doc token index → corresponding source token index (first observed). */
  sourceTokenForDocumentToken: Map<number, number>;
}

export function tokenizeForMatching(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    if (match.index === undefined) continue;
    const value = match[0].normalize("NFKC").toLowerCase();
    if (!value) continue;
    tokens.push({ value, start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function shingleKey(tokens: Token[], start: number, size: number): string {
  let key = tokens[start]!.value;
  for (let i = 1; i < size; i += 1) key += " " + tokens[start + i]!.value;
  return key;
}

function sourceIdFor(source: LocalCorpusSource): string {
  // A stable, short identifier. The full source id is retained as sourceId so
  // reports can link back to the exact corpus entry.
  return source.id;
}

function excerpt(text: string, start: number, end: number, max = 400): string {
  return text
    .slice(start, end)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Compare `text` against explicitly supplied, already-authorized sources.
 * Callers must never pass another account's private document.
 */
export function findLocalMatches(
  text: string,
  options?: {
    documentId?: string;
    sources?: readonly LocalCorpusSource[];
    shingleSize?: number;
  },
): LocalMatchSet {
  const documentId = options?.documentId ?? null;
  const shingleSize = Math.max(4, options?.shingleSize ?? LOCAL_SHINGLE_SIZE);
  const sources = (options?.sources ?? LOCAL_CORPUS_SOURCES).filter(
    (source) => !documentId || source.documentId !== documentId,
  );
  const documentTokens = tokenizeForMatching(text);
  const states: SourceMatchState[] = [];

  if (documentTokens.length >= shingleSize) {
    for (const source of sources) {
      const sourceTokens = tokenizeForMatching(source.text);
      if (sourceTokens.length < shingleSize) continue;

      const sourceShingles = new Map<string, number[]>();
      for (let i = 0; i <= sourceTokens.length - shingleSize; i += 1) {
        const key = shingleKey(sourceTokens, i, shingleSize);
        const positions = sourceShingles.get(key);
        if (positions) positions.push(i);
        else sourceShingles.set(key, [i]);
      }
      if (sourceShingles.size === 0) continue;

      const state: SourceMatchState = {
        source,
        matchedDocumentTokens: new Set<number>(),
        sourceTokenForDocumentToken: new Map<number, number>(),
      };

      for (let i = 0; i <= documentTokens.length - shingleSize; i += 1) {
        const positions = sourceShingles.get(shingleKey(documentTokens, i, shingleSize));
        if (!positions) continue;
        for (const sourceStart of positions) {
          for (let offset = 0; offset < shingleSize; offset += 1) {
            const documentToken = i + offset;
            state.matchedDocumentTokens.add(documentToken);
            if (!state.sourceTokenForDocumentToken.has(documentToken)) {
              state.sourceTokenForDocumentToken.set(documentToken, sourceStart + offset);
            }
          }
        }
      }

      if (state.matchedDocumentTokens.size >= shingleSize) states.push(state);
    }
  }

  const matches: SimilaritySourceMatch[] = [];
  for (const state of states) {
    const sourceTokens = tokenizeForMatching(state.source.text);
    const indices = Array.from(state.matchedDocumentTokens).sort((a, b) => a - b);
    let runStart = indices[0]!;
    let runEnd = runStart;

    const flush = () => {
      if (runEnd - runStart + 1 < shingleSize) return;
      const start = documentTokens[runStart]!.start;
      const end = documentTokens[runEnd]!.end;
      const sourceIndices = indices
        .filter((index) => index >= runStart && index <= runEnd)
        .map((index) => state.sourceTokenForDocumentToken.get(index))
        .filter((value): value is number => typeof value === "number");
      const sourceStart = sourceIndices.length > 0 ? Math.min(...sourceIndices) : 0;
      const sourceEnd =
        sourceIndices.length > 0
          ? Math.min(sourceTokens.length, Math.max(...sourceIndices) + 1)
          : 0;
      const sourceStartOffset = sourceTokens[sourceStart]?.start ?? 0;
      const sourceEndOffset = sourceTokens[Math.max(0, sourceEnd - 1)]?.end ?? 0;

      matches.push({
        matchId: null,
        offset: start,
        length: end - start,
        // This metric reports exact normalized token runs. It deliberately does
        // not manufacture a per-passage "similarity score".
        similarityPercent: null,
        sourceId: sourceIdFor(state.source),
        sourceTitle: state.source.title,
        sourceUrl: state.source.url,
        sourceExcerpt: excerpt(state.source.text, sourceStartOffset, sourceEndOffset) || null,
        matchedExcerpt: excerpt(text, start, end) || null,
      });
    };

    for (let i = 1; i < indices.length; i += 1) {
      const current = indices[i]!;
      if (current === runEnd + 1) {
        runEnd = current;
      } else {
        flush();
        runStart = current;
        runEnd = current;
      }
    }
    flush();
  }

  // Stable ordering and bounded result size. matchId is derived from the final
  // order so the same input always produces the same ids.
  matches.sort((a, b) => a.offset - b.offset || String(a.sourceId).localeCompare(String(b.sourceId)));
  const limited = matches.slice(0, MAX_LOCAL_MATCHES).map((match, index) => ({
    ...match,
    matchId: `local-${index + 1}`,
  }));

  const uniqueMatched = new Set<number>();
  for (const state of states) {
    for (const index of state.matchedDocumentTokens) uniqueMatched.add(index);
  }
  const totalTokens = documentTokens.length;
  const matchedTokens = uniqueMatched.size;
  const overallSimilarityPercent =
    totalTokens === 0
      ? null
      : Math.round((matchedTokens / totalTokens) * 100 * 100) / 100;

  return {
    matches: limited,
    matchedTokens,
    totalTokens,
    overallSimilarityPercent,
    algorithm: LOCAL_SIMILARITY_VERSION,
    shingleSize,
  };
}

export function localCorpusId(): string {
  return LOCAL_CORPUS_ID;
}

export function localCorpusFingerprint(): string {
  const hash = createHash("sha256");
  for (const source of LOCAL_CORPUS_SOURCES) {
    hash.update(source.id);
    hash.update("\0");
    hash.update(source.text);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export function createLocalSimilarityProvider(): LocalSimilarityProvider {
  const message = `Local corpus similarity is available (${LOCAL_CORPUS_ID}).`;
  return {
    id: LOCAL_CORPUS_PROVIDER_ID,
    kind: "LOCAL_SIMILARITY",
    status(): AnalysisProviderStatus {
      return {
        providerId: LOCAL_CORPUS_PROVIDER_ID,
        kind: "LOCAL_SIMILARITY",
        state: "AVAILABLE",
        configured: true,
        message,
      };
    },
    async analyze(input: LocalSimilarityInput): Promise<SimilarityAnalysisResult> {
      const result = findLocalMatches(input.text, { documentId: input.documentId });
      return {
        providerJobId: input.idempotencyKey,
        overallSimilarityPercent: result.overallSimilarityPercent,
        matches: result.matches,
        metadata: {
          providerId: LOCAL_CORPUS_PROVIDER_ID,
          providerVersion: LOCAL_SIMILARITY_VERSION,
          modelVersion: null,
          thresholdPercent: null,
          corpusId: LOCAL_CORPUS_ID,
          corpusSize: LOCAL_CORPUS_SOURCES.length,
          algorithm: LOCAL_SIMILARITY_VERSION,
          shingleSize: result.shingleSize,
          matchedTokens: result.matchedTokens,
          totalTokens: result.totalTokens,
          limitations: LOCAL_CORPUS_DISCLAIMER,
        },
      };
    },
  };
}
