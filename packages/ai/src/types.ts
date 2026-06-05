// Provider adapter — decouples the pipeline from vendors. Each capability is
// selected per-env (EMBED_PROVIDER, LLM_PROVIDER, …) so any one can swap to
// self-hosted without touching pipeline code.

export interface Word {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptResult {
  text: string;
  words: Word[];
}

export interface ClassifyInput {
  text: string;
  candidates: { id: string; name: string; description: string }[];
}

export interface StageMatch {
  id: string;
  confidence: number;
}

export interface InsightDraft {
  kind: string;
  title: string;
  quote?: string;
  severity?: number;
  sentiment?: string;
  flow_stage_hints?: string[];
}

export interface EmbedProvider {
  /** Returns one vector per input text, each of length EMBED_DIM. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface LLMProvider {
  classify(input: ClassifyInput): Promise<StageMatch[]>;
  extractInsights(chunk: string): Promise<InsightDraft[]>;
  summarize(texts: string[]): Promise<string>;
}

export interface TranscribeProvider {
  transcribe(fileUrl: string): Promise<TranscriptResult>;
}

export interface AIProvider extends EmbedProvider, LLMProvider, TranscribeProvider {}
