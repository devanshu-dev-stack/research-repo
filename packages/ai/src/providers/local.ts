import type { AIProvider, ClassifyInput, InsightDraft, StageMatch, TranscriptResult } from "../types";

const EMBED_DIM = Number(process.env.EMBED_DIM ?? 3072);

/**
 * Deterministic, dependency-free stand-in. NOT for production retrieval — the
 * vectors are hashed bag-of-words, so cosine similarity is only loosely
 * meaningful. Its purpose is to let the full pipeline run end-to-end (and tests
 * pass) with no network or keys. Swap to OpenAI/local-model providers via env.
 */
export class LocalStubProvider implements AIProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashEmbed(t, EMBED_DIM));
  }

  async classify(input: ClassifyInput): Promise<StageMatch[]> {
    // crude keyword overlap against candidate descriptions
    const words = new Set(tokenize(input.text));
    return input.candidates
      .map((c) => {
        const cand = new Set(tokenize(`${c.name} ${c.description}`));
        const overlap = [...words].filter((w) => cand.has(w)).length;
        return { id: c.id, confidence: Math.min(1, overlap / 8) };
      })
      .filter((m) => m.confidence > 0)
      .sort((a, b) => b.confidence - a.confidence);
  }

  async extractInsights(chunk: string): Promise<InsightDraft[]> {
    // Heuristic placeholder; real extraction is the LLM provider's job.
    const lower = chunk.toLowerCase();
    const drafts: InsightDraft[] = [];
    if (/(can't|cannot|couldn't|confusing|error|frustrat|gave up)/.test(lower)) {
      drafts.push({ kind: "pain_point", title: chunk.slice(0, 80), quote: chunk.slice(0, 160), severity: 3, sentiment: "negative" });
    }
    if (/(wish|want|would be nice|please add|feature)/.test(lower)) {
      drafts.push({ kind: "feature_request", title: chunk.slice(0, 80), quote: chunk.slice(0, 160), sentiment: "neutral" });
    }
    return drafts;
  }

  async summarize(texts: string[]): Promise<string> {
    return texts.join(" ").slice(0, 280);
  }

  async transcribe(): Promise<TranscriptResult> {
    return { text: "", words: [] };
  }
}

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// FNV-1a hashed bag-of-words → unit-normalized vector (deterministic).
function hashEmbed(text: string, dim: number): number[] {
  const v = new Float64Array(dim);
  for (const tok of tokenize(text)) {
    let h = 0x811c9dc5;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    v[h % dim] += 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, (x) => x / norm);
}
