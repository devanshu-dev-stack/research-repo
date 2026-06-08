import type { ClassifyInput, InsightDraft, LLMProvider, StageMatch } from "../types";

const MODEL = process.env.LLM_MODEL || "claude-sonnet-4-6";
const API = "https://api.anthropic.com/v1/messages";

// Anthropic LLM provider. Used for Pass B classification (only on ambiguous
// chunks), insight extraction (strict JSON), and cross-evidence summaries.
export class AnthropicLLMProvider implements LLMProvider {
  constructor(private apiKey = process.env.ANTHROPIC_API_KEY) {
    if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  }

  private async call(system: string, user: string, maxTokens = 1024): Promise<string> {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { content: { type: string; text?: string }[] };
    return json.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
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
    const raw = await this.call(system, user, 512);
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
    const raw = await this.call(system, `"""${chunk}"""`, 1024);
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
