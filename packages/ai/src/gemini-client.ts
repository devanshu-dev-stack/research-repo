// Shared HTTP client for the Gemini provider: client-side rate limiting,
// bounded concurrency, and automatic retry on 429/503. The free tier caps
// requests-per-minute, so on big files (many per-chunk LLM calls) we'd otherwise
// hit 429s and fail a stage. This makes a rate limit a *delay*, not a failure,
// while still using the full per-minute budget in parallel.
//
// Tunables (all env-overridable; defaults target gemini-2.5-flash free tier):
//   GEMINI_LLM_RPM=10          requests/min for generateContent
//   GEMINI_EMBED_RPM=100       requests/min for (batch)embedContent
//   GEMINI_MAX_CONCURRENCY=4   max simultaneous in-flight requests
//   GEMINI_MAX_RETRIES=5       retries on 429/503 before giving up
// The 429 RetryInfo.retryDelay from the server is always honored regardless.

const LLM_RPM = Number(process.env.GEMINI_LLM_RPM ?? 10);
const EMBED_RPM = Number(process.env.GEMINI_EMBED_RPM ?? 100);
const MAX_CONCURRENCY = Number(process.env.GEMINI_MAX_CONCURRENCY ?? 4);
const MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES ?? 5);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Token bucket. Refills at rpm/60 tokens per second; acquire() resolves once a
 *  token is available, pacing total throughput to the configured RPM. */
class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private rpm: number) {
    this.tokens = rpm; // allow an initial burst up to one minute's budget
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
    if (next) next(); // slot stays "active", handed to the waiter
    else this.active -= 1;
  }
}

const buckets = { llm: new TokenBucket(LLM_RPM), embed: new TokenBucket(EMBED_RPM) };
const gate = new Semaphore(MAX_CONCURRENCY);

export type Lane = "llm" | "embed";

/** How long to wait before retry: prefer the server's RetryInfo / Retry-After,
 *  else exponential backoff (1s,2s,4s,…) with jitter, capped at 60s. */
function backoffMs(res: Response, body: string, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    if (!Number.isNaN(secs)) return secs * 1000;
  }
  // Gemini returns RetryInfo in the error body: {"retryDelay":"5s"} / "5.2s".
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return Math.ceil(Number(m[1]) * 1000);
  const base = Math.min(60_000, 1000 * 2 ** attempt);
  return base + Math.floor(base * 0.25 * Math.random()); // +0–25% jitter
}

/**
 * fetch() with concurrency + rate limiting + retry on 429/503. Non-retryable
 * errors (4xx other than 429) return the response unread so the caller can
 * surface the body. Throws only if every retry is exhausted (returns the last
 * response) or fetch itself rejects.
 */
export async function geminiFetch(
  url: string,
  init: RequestInit,
  lane: Lane,
): Promise<Response> {
  await gate.acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      await buckets[lane].acquire();
      const res = await fetch(url, init);
      if (res.ok) return res;
      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
        // Read the body to extract retry hints; this response is discarded.
        const body = await res.text().catch(() => "");
        // A per-DAY free-tier quota won't clear on a short retry (resets at
        // midnight PT). Don't waste the whole backoff budget on it — return now
        // so the caller surfaces the error (source → partial, re-runnable later).
        if (/PerDay/i.test(body)) {
          return new Response(body, { status: res.status, headers: res.headers });
        }
        await sleep(backoffMs(res, body, attempt));
        continue;
      }
      return res; // success-or-final: caller handles !ok
    }
  } finally {
    gate.release();
  }
}
