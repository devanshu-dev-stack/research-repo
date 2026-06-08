import type {
  ClassifyInput,
  EmbedProvider,
  InsightDraft,
  LLMProvider,
  StageMatch,
} from "../types";

// Google Gemini provider — covers BOTH capabilities from a single key:
//   • embeddings via gemini-embedding-001 (Matryoshka; outputs up to 3072 dims,
//     which is exactly this system's EMBED_DIM, so vectors come back already
//     L2-normalized and need no post-processing)
//   • LLM (classify / extractInsights / summarize) via gemini-2.5-*
// Endpoints are the Generative Language API (v1beta); auth is the
// x-goog-api-key header.

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBED_DIM = Number(process.env.EMBED_DIM ?? 3072);
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001";
const LLM_MODEL = process.env.LLM_MODEL ?? "gemini-2.5-flash";
const EMBED_BATCH = 96; // batchEmbedContents accepts up to 100 requests
// gemini-2.5-* models think by default, and thinking tokens are billed against
// maxOutputTokens — left on, a 1024-token budget gets spent on reasoning and the
// JSON answer is truncated mid-string (→ parse fails → zero insights). These are
// bounded structured-extraction calls, so we disable thinking. gemini-2.5-flash
// accepts 0; gemini-2.5-pro requires a minimum (≥128), so it's env-overridable.
const THINKING_BUDGET = Number(process.env.GEMINI_THINKING_BUDGET ?? 0);

export class GeminiEmbedProvider implements EmbedProvider {
  constructor(private apiKey = process.env.GEMINI_API_KEY) {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY not set");
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const res = await fetch(
        `${BASE}/models/${EMBED_MODEL}:batchEmbedContents`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey!,
          },
          body: JSON.stringify({
            requests: batch.map((text) => ({
              model: `models/${EMBED_MODEL}`,
              content: { parts: [{ text }] },
              outputDimensionality: EMBED_DIM,
            })),
          }),
        },
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
  constructor(private apiKey = process.env.GEMINI_API_KEY) {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY not set");
  }

  private async call(
    system: string,
    user: string,
    maxTokens = 1024,
    json = false,
  ): Promise<string> {
    const res = await fetch(`${BASE}/models/${LLM_MODEL}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey!,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          thinkingConfig: { thinkingBudget: THINKING_BUDGET },
          ...(json ? { responseMimeType: "application/json" } : {}),
        },
      }),
    });
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
