// Chunking — splits normalized content into retrieval units while preserving
// the traceability fields the schema needs (page / response_ref / timing).
// Token counting is approximate (chars/4) to stay dependency-free; swap in a
// real tokenizer later without changing the interface.

export interface ChunkInput {
  text: string;
  page?: number | null;
  responseRef?: string | null;
  startMs?: number | null;
  endMs?: number | null;
}

export interface ChunkOptions {
  maxTokens?: number; // target chunk size
  overlapTokens?: number; // sliding-window overlap
}

export interface ProducedChunk {
  ordinal: number;
  text: string;
  page: number | null;
  responseRef: string | null;
  startMs: number | null;
  endMs: number | null;
}

const APPROX_CHARS_PER_TOKEN = 4;

export function approxTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

/** Split a string into ~maxTokens windows with overlap, on sentence-ish bounds. */
function splitText(text: string, maxTokens: number, overlapTokens: number): string[] {
  const maxChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * APPROX_CHARS_PER_TOKEN;
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];

  // Prefer breaking at sentence boundaries within the window.
  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      const slice = clean.slice(start, end);
      const lastStop = Math.max(
        slice.lastIndexOf(". "),
        slice.lastIndexOf("? "),
        slice.lastIndexOf("! "),
      );
      if (lastStop > maxChars * 0.5) end = start + lastStop + 1;
    }
    out.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return out.filter(Boolean);
}

/**
 * Turn one or more ChunkInputs into ordered ProducedChunks. Each input keeps
 * its own page/responseRef/timing so a survey row, a PDF page, or a transcript
 * segment all chunk independently and stay traceable.
 */
export function chunkContent(
  inputs: ChunkInput[],
  opts: ChunkOptions = {},
): ProducedChunk[] {
  const maxTokens = opts.maxTokens ?? Number(process.env.CHUNK_TOKENS ?? 400);
  const overlap = opts.overlapTokens ?? Number(process.env.CHUNK_OVERLAP ?? 60);

  const produced: ProducedChunk[] = [];
  let ordinal = 0;
  for (const input of inputs) {
    const parts = splitText(input.text ?? "", maxTokens, overlap);
    for (const part of parts) {
      produced.push({
        ordinal: ordinal++,
        text: part,
        page: input.page ?? null,
        responseRef: input.responseRef ?? null,
        startMs: input.startMs ?? null,
        endMs: input.endMs ?? null,
      });
    }
  }
  return produced;
}
