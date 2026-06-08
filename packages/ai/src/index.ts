import type { AIProvider, EmbedProvider, LLMProvider } from "./types";
import { LocalStubProvider } from "./providers/local";
import { OpenAIEmbedProvider } from "./providers/openai";
import { AnthropicLLMProvider } from "./providers/anthropic";
import { GeminiEmbedProvider, GeminiLLMProvider } from "./providers/gemini";

let _embed: EmbedProvider | null = null;
let _llm: LLMProvider | null = null;
let _stub: LocalStubProvider | null = null;

function stub(): LocalStubProvider {
  return (_stub ??= new LocalStubProvider());
}

/** Embeddings provider chosen by EMBED_PROVIDER (openai | gemini | local). */
export function getEmbedProvider(): EmbedProvider {
  if (_embed) return _embed;
  const choice = (process.env.EMBED_PROVIDER ?? "local").toLowerCase();
  if (choice === "openai" && process.env.OPENAI_API_KEY) {
    _embed = new OpenAIEmbedProvider();
  } else if (choice === "gemini" && process.env.GEMINI_API_KEY) {
    _embed = new GeminiEmbedProvider();
  } else {
    if (choice === "openai") {
      console.warn("EMBED_PROVIDER=openai but OPENAI_API_KEY missing; using local stub");
    } else if (choice === "gemini") {
      console.warn("EMBED_PROVIDER=gemini but GEMINI_API_KEY missing; using local stub");
    }
    _embed = stub();
  }
  return _embed;
}

/** LLM provider chosen by LLM_PROVIDER (anthropic | gemini | local). Used for
 *  Pass B classification, insight extraction, and summaries. Falls back to the
 *  local stub when no key is configured so the pipeline runs offline. */
export function getLLMProvider(): LLMProvider {
  if (_llm) return _llm;
  const choice = (process.env.LLM_PROVIDER ?? "local").toLowerCase();
  if (choice === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    _llm = new AnthropicLLMProvider();
  } else if (choice === "gemini" && process.env.GEMINI_API_KEY) {
    _llm = new GeminiLLMProvider();
  } else {
    if (choice === "anthropic") {
      console.warn("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY missing; using local stub");
    } else if (choice === "gemini") {
      console.warn("LLM_PROVIDER=gemini but GEMINI_API_KEY missing; using local stub");
    }
    _llm = stub();
  }
  return _llm;
}

/** Full provider (embed + llm + transcribe). Only `local` is wired end-to-end
 *  here; openai/anthropic LLM + transcription land with the media stages. */
export function getAIProvider(): AIProvider {
  // For the ingestion spine, the stub satisfies the full interface. Capability
  // selection is layered in as each provider is implemented.
  return stub();
}

export * from "./types";
