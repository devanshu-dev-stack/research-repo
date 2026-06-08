import type {
  BatchInsightResult,
  ClassifyInput,
  EmbedProvider,
  InsightDraft,
  LLMProvider,
  StageMatch,
} from "../types";
import { geminiFetch, hasGeminiKey } from "../gemini-client";

// Google Gemini provider — covers BOTH capabilities from a single key:
//   • embeddings via gemini-embedding-001 (Matryoshka; outputs up to 3072 dims,
//     which is exactly this system's EMBED_DIM, so vectors come back already
//     L2-normalized and need no post-processing)
//   • LLM (classify / extractInsights / summarize) via gemini-2.5-*
// Endpoints are the Generative Language API (v1beta); auth is the
// x-goog-api-key header.

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBED_DIM = Number(process.env.EMBED_DIM ?? 3072);
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
// Default to flash-lite: gemini-2.5-flash's free tier is only ~20 requests/day,
// while flash-lite's free daily quota is far higher — so big files complete
// without hitting the daily wall. Override with LLM_MODEL for paid tiers.
const LLM_MODEL = process.env.LLM_MODEL || "gemini-2.5-flash-lite";
const EMBED_BATCH = 96; // batchEmbedContents accepts up to 100 requests
// gemini-2.5-* models think by default, and thinking tokens are billed against
// maxOutputTokens — left on, a 1024-token budget gets spent on reasoning and the
// JSON answer is truncated mid-string (→ parse fails → zero insights). These are
// bounded structured-extraction calls, so we disable thinking. gemini-2.5-flash
// accepts 0; gemini-2.5-pro requires a minimum (≥128), so it's env-overridable.
const THINKING_BUDGET = Number(process.env.GEMINI_THINKING_BUDGET ?? 0);

export class GeminiEmbedProvider implements EmbedProvider {
  constructor() {
    if (!hasGeminiKey()) throw new Error("GEMINI_API_KEY(S) not set");
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const res = await geminiFetch(
        `${BASE}/models/${EMBED_MODEL}:batchEmbedContents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: batch.map((text) => ({
              model: `models/${EMBED_MODEL}`,
              content: { parts: [{ text }] },
              outputDimensionality: EMBED_DIM,
            })),
          }),
        },
        "embed",
      );
      if (!res.ok) {
        throw new Error(`Gemini embeddings ${res.status}: ${await res.text()}`);
      }
      const json = (await res.json()) as { embeddings: { values: number[] }[] };
      // batchEmbedContents preserves request order.
      json.embeddings.forEach((e) => out.push(e.values));
    }
    return out;
  }
}

// Gemini LLM provider. Mirrors the Anthropic adapter's contract: Pass B
// classification (ambiguous chunks only), strict-JSON insight extraction, and
// cross-evidence summaries. JSON-shaped calls request responseMimeType
// application/json so the model returns parseable JSON without fences.
export class GeminiLLMProvider implements LLMProvider {
  constructor() {
    if (!hasGeminiKey()) throw new Error("GEMINI_API_KEY(S) not set");
  }

  private async call(
    system: string,
    user: string,
    maxTokens = 1024,
    json = false,
  ): Promise<string> {
    const res = await geminiFetch(
      `${BASE}/models/${LLM_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            thinkingConfig: { thinkingBudget: THINKING_BUDGET },
            ...(json ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
      "llm",
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return (
      data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join("") ?? ""
    );
  }

  /** Pass B: adjudicate which candidate stages fit, with confidence. */
  async classify(input: ClassifyInput): Promise<StageMatch[]> {
    const system =
      "You map a piece of user-research text to product user-flow stages. " +
      "Choose only stages that clearly fit. Respond ONLY with JSON: " +
      `{"matches":[{"id":"<stage id>","confidence":0..1}]}. No prose.`;
    const candidates = input.candidates
      .map((c) => `- ${c.id} | ${c.name}: ${c.description}`)
      .join("\n");
    const user = `Candidate stages:\n${candidates}\n\nText:\n"""${input.text}"""`;
    const raw = await this.call(system, user, 512, true);
    const parsed = safeJson<{ matches: StageMatch[] }>(raw);
    return parsed?.matches?.filter((m) => m.id && typeof m.confidence === "number") ?? [];
  }

  /** Insight extraction — strict JSON contract (validated again by Zod upstream). */
  async extractInsights(chunk: string): Promise<InsightDraft[]> {
    const system =
      "Extract product-research insights from the text. For each, give kind " +
      "(pain_point|feature_request|ux_friction|positive|theme|job_to_be_done|goal), " +
      "a short title, the exact supporting quote, severity 1-5, sentiment, and " +
      "any flow_stage_hints. Respond ONLY with JSON: " +
      `{"insights":[{"kind","title","quote","severity","sentiment","flow_stage_hints":[]}]}. ` +
      "Return an empty list if there is nothing substantive.";
    const raw = await this.call(system, `"""${chunk}"""`, 1024, true);
    const parsed = safeJson<{ insights: InsightDraft[] }>(raw);
    return parsed?.insights ?? [];
  }

  /** Batched insight extraction — many chunks in ONE request. Each chunk is
   *  indexed in the prompt; the model returns insights grouped by that index,
   *  which we map back to chunkId so the insight stage keeps exact per-chunk
   *  evidence/quote traceability. Output budget scales with the batch. */
  async extractInsightsBatch(
    chunks: { id: string; text: string }[],
  ): Promise<BatchInsightResult[]> {
    if (chunks.length === 0) return [];
    const system =
      "Extract product-research insights from EACH numbered chunk independently. " +
      "For each insight give kind " +
      "(pain_point|feature_request|ux_friction|positive|theme|job_to_be_done|goal), " +
      "a short title, the exact supporting quote (verbatim from THAT chunk), " +
      "severity 1-5, sentiment, and any flow_stage_hints. Respond ONLY with JSON: " +
      `{"results":[{"chunk":<index>,"insights":[{"kind","title","quote","severity","sentiment","flow_stage_hints":[]}]}]}. ` +
      "Include a result entry for every chunk index (empty insights array if nothing substantive). No prose.";
    const user = chunks.map((c, i) => `[chunk ${i}]\n"""${c.text}"""`).join("\n\n");
    // Budget ~1200 output tokens/chunk (dense chunks yield many insights each);
    // thinking is disabled so it's all answer. Cap well under the flash ceiling.
    const maxTokens = Math.min(16384, 1024 + 1200 * chunks.length);
    const raw = await this.call(system, user, maxTokens, true);
    const parsed = safeJson<{ results: { chunk: number; insights: InsightDraft[] }[] }>(raw);
    // If the combined JSON didn't parse (e.g. the response still truncated),
    // fall back to per-chunk extraction so a batch never silently drops insights.
    if (!parsed?.results) {
      return Promise.all(
        chunks.map(async (c) => ({ chunkId: c.id, drafts: await this.extractInsights(c.text) })),
      );
    }
    const byIndex = new Map<number, InsightDraft[]>();
    for (const r of parsed.results) {
      if (typeof r.chunk === "number") byIndex.set(r.chunk, Array.isArray(r.insights) ? r.insights : []);
    }
    return chunks.map((c, i) => ({ chunkId: c.id, drafts: byIndex.get(i) ?? [] }));
  }

  async summarize(texts: string[]): Promise<string> {
    const system = "Summarize the shared theme across these research snippets in 1-2 sentences.";
    const raw = await this.call(system, texts.map((t, i) => `${i + 1}. ${t}`).join("\n"), 256);
    return raw.trim();
  }
}

function safeJson<T>(s: string): T | null {
  // tolerate ```json fences / leading prose
  const cleaned = s.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
