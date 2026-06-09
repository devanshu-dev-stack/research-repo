// Shared HTTP client for the Gemini provider: client-side rate limiting,
// bounded concurrency, and retry on 429/503. Auth is a single API key
// (GEMINI_API_KEY) injected here as the x-goog-api-key header, so providers must
// NOT set it themselves.
//
// Tunables (env, all optional):
//   GEMINI_API_KEY=...         the API key
//   GEMINI_LLM_RPM=60          requests/min for generateContent
//   GEMINI_EMBED_RPM=200       requests/min for (batch)embedContent
//   GEMINI_MAX_CONCURRENCY=8   max simultaneous in-flight requests (global)
//   GEMINI_MAX_RETRIES=5       retries on 429/503 (with backoff) before giving up

const LLM_RPM = Number(process.env.GEMINI_LLM_RPM ?? 60);
const EMBED_RPM = Number(process.env.GEMINI_EMBED_RPM ?? 200);
const MAX_CONCURRENCY = Number(process.env.GEMINI_MAX_CONCURRENCY ?? 8);
const MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES ?? 5);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Lane = "llm" | "embed";

/** Token bucket. Refills at rpm/60 tokens per second; acquire() resolves once a
 *  token is available, pacing throughput to the configured RPM. */
class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private rpm: number) {
    this.tokens = rpm;
    this.last = Date.now();
  }
  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.rpm, this.tokens + ((now - this.last) / 1000) * (this.rpm / 60));
    this.last = now;
  }
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = ((1 - this.tokens) / (this.rpm / 60)) * 1000;
    await sleep(Math.max(waitMs, 50));
    return this.acquire();
  }
}

/** Counting semaphore — hands a freed slot directly to the next waiter. */
class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}

// ── Single API key ──────────────────────────────────────────
const API_KEY = (process.env.GEMINI_API_KEY || "").trim();

const buckets: Record<Lane, TokenBucket> = {
  llm: new TokenBucket(LLM_RPM),
  embed: new TokenBucket(EMBED_RPM),
};
const gate = new Semaphore(MAX_CONCURRENCY);

export function hasGeminiKey(): boolean {
  return API_KEY.length > 0;
}

/** The configured key, for callers that manage their own fetch (e.g. the
 *  transcriber's File-API flow). Null if unset. */
export function geminiKey(): string | null {
  return API_KEY || null;
}

function injectKey(init: RequestInit, key: string): RequestInit {
  const headers = new Headers(init.headers as Record<string, string> | undefined);
  headers.set("x-goog-api-key", key);
  return { ...init, headers };
}

/** How long to wait before retrying: server RetryInfo / Retry-After, else
 *  exponential backoff (1s,2s,4s…) with jitter, capped at 60s. */
function backoffMs(res: Response, body: string, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header && !Number.isNaN(Number(header))) return Number(header) * 1000;
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return Math.ceil(Number(m[1]) * 1000);
  const base = Math.min(60_000, 1000 * 2 ** attempt);
  return base + Math.floor(base * 0.25 * Math.random());
}

/**
 * fetch() with concurrency + rate limiting + retry. The api key is injected here,
 * so providers must NOT set x-goog-api-key. On 429/503 we back off and retry the
 * same key up to GEMINI_MAX_RETRIES times; the final response is returned for the
 * caller to handle on !ok.
 */
export async function geminiFetch(url: string, init: RequestInit, lane: Lane): Promise<Response> {
  if (!API_KEY) throw new Error("No GEMINI_API_KEY configured");
  await gate.acquire();
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await buckets[lane].acquire();
      const res = await fetch(url, injectKey(init, API_KEY));
      if (res.ok) return res;
      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
        const body = await res.text().catch(() => "");
        await sleep(backoffMs(res, body, attempt));
        continue; // retry after backoff
      }
      return res; // non-retryable, or out of retries: caller handles !ok
    }
    // Unreachable: the loop returns on the final attempt.
    return new Response('{"error":{"message":"Gemini request failed"}}', { status: 429 });
  } finally {
    gate.release();
  }
}
