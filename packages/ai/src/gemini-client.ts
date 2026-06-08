// Shared HTTP client for the Gemini provider: multi-key rotation, client-side
// rate limiting, bounded concurrency, and retry on 429/503.
//
// WHY ROTATION: Gemini's free tier caps requests PER PROJECT (e.g. ~20
// generateContent/day for gemini-2.5-flash). Keys from *different* GCP projects
// each get their own quota, so we keep a pool and rotate to the next key when one
// 429s — only failing once every key is exhausted. (Keys from the SAME project
// share quota and won't help.)
//
// Tunables (env, all optional; defaults target the flash-lite free tier):
//   GEMINI_API_KEYS=k1,k2,k3   pool (falls back to single GEMINI_API_KEY)
//   GEMINI_LLM_RPM=10          per-key requests/min for generateContent
//   GEMINI_EMBED_RPM=100       per-key requests/min for (batch)embedContent
//   GEMINI_MAX_CONCURRENCY=4   max simultaneous in-flight requests (global)
//   GEMINI_MAX_RETRIES=5       retries per key before rotating on
//   GEMINI_KEY_COOLDOWN_MS     how long a per-day-exhausted key is benched (30m)

const LLM_RPM = Number(process.env.GEMINI_LLM_RPM ?? 10);
const EMBED_RPM = Number(process.env.GEMINI_EMBED_RPM ?? 100);
const MAX_CONCURRENCY = Number(process.env.GEMINI_MAX_CONCURRENCY ?? 4);
const MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES ?? 5);
const PER_DAY_COOLDOWN_MS = Number(process.env.GEMINI_KEY_COOLDOWN_MS ?? 30 * 60_000);

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
  peek(): number {
    this.refill();
    return this.tokens;
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

// ── Key pool ────────────────────────────────────────────────
function parseKeys(): string[] {
  const multi = (process.env.GEMINI_API_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const single = (process.env.GEMINI_API_KEY || "").trim();
  return [...new Set([...(single ? [single] : []), ...multi])];
}

interface KeyState {
  key: string;
  buckets: Record<Lane, TokenBucket>;
  cooldownUntil: number; // epoch ms; key is unusable until then
}

const keyStates: KeyState[] = parseKeys().map((key) => ({
  key,
  buckets: { llm: new TokenBucket(LLM_RPM), embed: new TokenBucket(EMBED_RPM) },
  cooldownUntil: 0,
}));

const gate = new Semaphore(MAX_CONCURRENCY);

export function hasGeminiKey(): boolean {
  return keyStates.length > 0;
}
export function geminiKeyCount(): number {
  return keyStates.length;
}

/** Mark a key unusable: long bench for a per-day quota, short for per-minute. */
export function coolDownKey(key: string, perDay: boolean, ms?: number): void {
  const ks = keyStates.find((k) => k.key === key);
  if (ks) ks.cooldownUntil = Date.now() + (ms ?? (perDay ? PER_DAY_COOLDOWN_MS : 5000));
}

/** An available key (cooldown-aware) for callers that manage their own fetch
 *  (e.g. the transcriber's File-API flow). Null if every key is benched. */
export function pickGeminiKey(): string | null {
  return (pickAvailable("llm") ?? pickAvailable("embed"))?.key ?? null;
}

function pickAvailable(lane: Lane): KeyState | null {
  const now = Date.now();
  const avail = keyStates.filter((k) => k.cooldownUntil <= now);
  if (avail.length === 0) return null;
  // Spread load: prefer the key with the most tokens left in this lane.
  return avail.reduce((best, k) => (k.buckets[lane].peek() > best.buckets[lane].peek() ? k : best));
}

function soonestCooldown(): number {
  return Math.min(...keyStates.map((k) => k.cooldownUntil));
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
 * fetch() with key rotation + concurrency + rate limiting + retry. The api key is
 * injected here from the pool, so providers must NOT set x-goog-api-key. On 429/503
 * the offending key is cooled down and the request rotates to the next available
 * key; only when all keys are benched do we return the last error response.
 */
export async function geminiFetch(url: string, init: RequestInit, lane: Lane): Promise<Response> {
  if (keyStates.length === 0) throw new Error("No GEMINI_API_KEY / GEMINI_API_KEYS configured");
  await gate.acquire();
  try {
    const maxAttempts = (MAX_RETRIES + 1) * keyStates.length;
    let last: Response | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let ks = pickAvailable(lane);
      if (!ks) {
        const wait = soonestCooldown() - Date.now();
        if (wait > 30_000) break; // all on a long (per-day) bench → give up
        await sleep(Math.max(wait, 0) + 50); // brief wait for a per-minute key to free
        continue;
      }
      await ks.buckets[lane].acquire();
      const res = await fetch(url, injectKey(init, ks.key));
      if (res.ok) return res;
      if (res.status === 429 || res.status === 503) {
        const body = await res.text().catch(() => "");
        const perDay = /PerDay/i.test(body);
        coolDownKey(ks.key, perDay, perDay ? undefined : backoffMs(res, body, attempt));
        last = new Response(body, { status: res.status, headers: res.headers });
        continue; // rotate to the next available key
      }
      return res; // non-retryable: caller handles !ok
    }
    return last ?? new Response('{"error":{"message":"all Gemini keys exhausted"}}', { status: 429 });
  } finally {
    gate.release();
  }
}
