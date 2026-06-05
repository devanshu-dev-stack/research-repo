import type { EmbedProvider } from "../types";

const EMBED_DIM = Number(process.env.EMBED_DIM ?? 3072);
const MODEL = process.env.EMBED_MODEL ?? "text-embedding-3-large";
const BATCH = 96; // OpenAI accepts arrays; keep batches modest

export class OpenAIEmbedProvider implements EmbedProvider {
  constructor(private apiKey = process.env.OPENAI_API_KEY) {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY not set");
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: MODEL, input: batch, dimensions: EMBED_DIM }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI embeddings ${res.status}: ${await res.text()}`);
      }
      const json = (await res.json()) as {
        data: { embedding: number[]; index: number }[];
      };
      // Preserve order: OpenAI returns an `index` per item.
      json.data
        .sort((a, b) => a.index - b.index)
        .forEach((d) => out.push(d.embedding));
    }
    return out;
  }
}
