/**
 * Lightweight Semantic Scoring for Vault Search
 *
 * Adds TF-IDF cosine similarity scoring on top of FTS5 keyword matching
 * to improve vault search quality without requiring external embedding
 * services or GPU-accelerated vector search.
 *
 * This is a pure-JS implementation that:
 * 1. Tokenizes query and document text
 * 2. Computes TF-IDF vectors
 * 3. Ranks by cosine similarity
 * 4. Blends with FTS5 BM25 scores for final ranking
 *
 * For full vector embeddings (transformers/API-based), see the optional
 * EmbeddingProvider interface below.
 */

// ── Tokenizer ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for',
  'from', 'had', 'has', 'have', 'he', 'her', 'him', 'his', 'how', 'i',
  'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'my', 'no',
  'nor', 'not', 'of', 'on', 'or', 'our', 'out', 'own', 'say', 'she',
  'so', 'some', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'to', 'too', 'up', 'us', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'will', 'with',
  'would', 'you', 'your',
]);

/**
 * Tokenize and normalize text for similarity comparison.
 * Returns unique lowercase terms with stopwords removed.
 */
export function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  return [...new Set(tokens)];
}

// ── TF-IDF ───────────────────────────────────────────────────────────────

export interface TfIdfDocument {
  id: string;
  text: string;
  tokens?: string[];
}

/**
 * Compute TF (term frequency) for a token array.
 */
function computeTf(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  // Normalize by total tokens
  const total = tokens.length || 1;
  for (const [k, v] of tf) {
    tf.set(k, v / total);
  }
  return tf;
}

/**
 * Compute IDF (inverse document frequency) across a corpus.
 */
function computeIdf(corpus: string[][]): Map<string, number> {
  const docCount = corpus.length || 1;
  const df = new Map<string, number>();

  for (const tokens of corpus) {
    const unique = new Set(tokens);
    for (const t of unique) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log(docCount / (count + 1)) + 1);
  }
  return idf;
}

/**
 * Compute TF-IDF vector for a token array given precomputed IDF values.
 */
function tfidfVector(tokens: string[], idf: Map<string, number>): Map<string, number> {
  const tf = computeTf(tokens);
  const vec = new Map<string, number>();
  for (const [term, tfVal] of tf) {
    const idfVal = idf.get(term) ?? 1;
    vec.set(term, tfVal * idfVal);
  }
  return vec;
}

/**
 * Cosine similarity between two sparse vectors.
 */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [k, v] of a) {
    normA += v * v;
    const bv = b.get(k);
    if (bv !== undefined) dot += v * bv;
  }
  for (const [, v] of b) {
    normB += v * v;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Semantic Ranker ──────────────────────────────────────────────────────

export interface ScoredResult<T> {
  item: T;
  /** Combined score (higher = more relevant). */
  score: number;
  /** TF-IDF cosine similarity component (0-1). */
  semanticScore: number;
}

/**
 * Re-rank search results using TF-IDF cosine similarity.
 *
 * Blends the original score (e.g., BM25 from FTS5) with a semantic
 * similarity score computed via TF-IDF cosine distance.
 *
 * @param query - Search query text
 * @param results - Results with their original scores and text content
 * @param options - Tuning parameters
 */
export function semanticRerank<T>(
  query: string,
  results: Array<{ item: T; text: string; originalScore?: number }>,
  options: { semanticWeight?: number; limit?: number } = {}
): ScoredResult<T>[] {
  const { semanticWeight = 0.4, limit = results.length } = options;
  const originalWeight = 1 - semanticWeight;

  if (results.length === 0) return [];

  const queryTokens = tokenize(query);
  const docTokens = results.map((r) => tokenize(r.text));

  // Include query in corpus for IDF computation
  const corpus = [queryTokens, ...docTokens];
  const idf = computeIdf(corpus);

  const queryVec = tfidfVector(queryTokens, idf);

  const scored: ScoredResult<T>[] = results.map((r, i) => {
    const docVec = tfidfVector(docTokens[i], idf);
    const semanticScore = cosineSimilarity(queryVec, docVec);

    // Normalize original score to 0-1 range (BM25 scores are typically negative, lower = better)
    const origScore = r.originalScore ?? 0;
    const normalizedOrig = origScore <= 0 ? 1 / (1 + Math.abs(origScore)) : origScore;

    const combinedScore = originalWeight * normalizedOrig + semanticWeight * semanticScore;

    return { item: r.item, score: combinedScore, semanticScore };
  });

  // Sort by combined score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}

// ── Optional Embedding Provider Interface ────────────────────────────────

/**
 * Interface for external embedding providers (e.g., OpenAI embeddings,
 * local transformer models via ONNX, etc.)
 *
 * Can be plugged into the vault for true vector similarity search
 * when available.
 */
export interface EmbeddingProvider {
  /** Model name for display/logging. */
  readonly modelName: string;
  /** Embedding dimensions. */
  readonly dimensions: number;
  /** Embed a single text. */
  embed(text: string): Promise<Float32Array>;
  /** Batch embed multiple texts. */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}
