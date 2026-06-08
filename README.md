# Research Repository

Turn raw product-research artifacts — interviews, usability sessions, surveys,
notes, PDFs, **audio and video** — into a searchable, traceable knowledge base.
Everything you upload is normalized, chunked, embedded, auto-tagged against a
Student/Faculty user-flow taxonomy, and mined for insights, with every insight
linked back to the exact quote and source it came from.

Monorepo: **Next.js + tRPC** (web) · **PostgreSQL 16 + pgvector** · **Redis/BullMQ**
(job queue) · **S3-compatible object storage** (MinIO locally) · pluggable AI
providers (**Gemini**, OpenAI, Anthropic, or a no-key local stub).

---

## What happens to a file you upload (the overview)

```
  Browser
    │  1. asks the app for a presigned URL, then PUTs the file straight to storage
    ▼                                        (bytes are never proxied through the app)
  MinIO / S3 ──────► sources row created (status: pending) ──────► job queued in Redis
                                                                          │
                                                                          ▼
                                              A background worker runs the pipeline:

   extract ──►  normalize ──►  chunk ──►  embed ──►  classify ──►  insight ──► status: ready
   ───────      ─────────      ─────      ─────      ────────      ───────
   PDF/doc →    unify into     split into  3072-dim   tag to       LLM extracts
   text;        one schema     overlapping vector     flow stages  pain points,
   image →      (transcript,   token       per chunk  (semantic    requests, JTBD…
   OCR;         participant,   windows                 match, then  each linked to its
   audio/video  timing, page…)                         LLM on the   source chunk +
   → transcript                                        ambiguous    exact quote
                                                        ones)
```

Each stage is **idempotent** and audited in a `processing_jobs` table, so a failed
or rate-limited run can be safely re-run and it resumes where it left off. A source
ends as `ready`, or `partial` (usable but a later stage failed) / `failed`.

Once `ready`, the content is available through **hybrid search** (keyword + semantic
vectors, fused with Reciprocal Rank Fusion) and the four UI views below.

### The interface

Open **http://localhost:3000**. Four views, one nav:

- **Repository** — every source with status, type, flow-stage tags, and a snippet.
  Click a row to open the detail drawer (full metadata, tags, all chunks, and a
  "Re-run pipeline" button for failed/partial sources).
- **Insights** — extracted insights as cards (kind, severity, frequency, the
  supporting quote), filterable by kind, each with clickable links back to its
  source(s).
- **Flow Map** — the 33-stage Student/Faculty taxonomy, grouped by persona, with
  live counts of tagged sources and insights per stage. Tap a stage to see its
  insights.
- **Source detail drawer** — slides in from any view; the full traceability chain.

---

## How the AI works (providers & the Gemini API)

All model calls go through provider adapters in `packages/ai`, selected per
capability by env var. Each capability **falls back to a local stub** if no key is
set, so the whole thing runs offline (rough relevance, but the full flow works).

| Capability | Env | Options | What it does |
|---|---|---|---|
| Embeddings | `EMBED_PROVIDER` | `gemini` · `openai` · `local` | Turns chunk text into 3072-dim vectors for semantic search + flow-stage matching |
| LLM | `LLM_PROVIDER` | `gemini` · `anthropic` · `local` | Classify (Pass B) + insight extraction + summaries |
| Transcription | `TRANSCRIBE_PROVIDER` | `gemini` · `deepgram` · `noop` | Audio/video → text |

### Using Gemini (one key does everything)

Set `EMBED_PROVIDER=gemini`, `LLM_PROVIDER=gemini`, and one `GEMINI_API_KEY`
([get one here](https://aistudio.google.com/apikey)). That single key powers all
three capabilities:

- **Embeddings** — `gemini-embedding-001` at 3072 dims (exactly this system's
  `EMBED_DIM`, so vectors come back already normalized).
- **LLM** — defaults to **`gemini-2.5-flash-lite`** (see the rate-limit note below).
  Insight extraction is **batched** (`INSIGHT_BATCH` chunks per request, each
  insight tagged with its chunk so per-chunk traceability survives), and "thinking"
  is disabled on these structured-extraction calls so the full token budget goes to
  the answer.
- **Transcription** — audio/video is multimodal-native to Gemini. The worker uses
  **ffmpeg** to stream just the **audio track** out of the file (so a 600 MB video
  isn't loaded into memory), uploads that audio to the **Gemini File API**, and asks
  the model for a verbatim, speaker-labeled transcript with `[MM:SS]` timestamps —
  which become clip-level timing on each chunk.

**Rate limiting & resilience.** The Gemini client (`packages/ai/src/gemini-client.ts`)
paces requests with a token-bucket limiter (separate request-per-minute budgets for
LLM and embeddings), runs them concurrently up to a cap, and **auto-retries on 429/503**
honoring the server's `retryDelay`. So large files slow down instead of failing.

> **Free-tier daily cap.** Google's free tier limits `gemini-2.5-flash` to ~20
> requests **per day**, which is why the default model is **`gemini-2.5-flash-lite`**
> (much higher daily quota). If a day's quota is still exhausted, the client fails
> fast (rather than hanging on retries), the source is marked `partial` with the
> reason, and you can re-run it later from the source drawer — stages are idempotent.
> Embeddings have a separate, larger quota.

**Multiple keys (raise the daily ceiling).** Free-tier quota is **per GCP project**,
so set `GEMINI_API_KEYS=key1,key2,key3` with keys from *different* projects. Each key
gets its own per-minute budget and the client rotates to the next on a 429 (benching
a per-day-exhausted key for ~30 min), so you're only blocked once *all* keys are
spent. Keys in the same project share quota and don't help.

Tunables (all optional, env-overridable): `GEMINI_LLM_RPM` (10), `GEMINI_EMBED_RPM`
(100), `GEMINI_MAX_CONCURRENCY` (4), `GEMINI_MAX_RETRIES` (5), `INSIGHT_BATCH` (8),
`GEMINI_KEY_COOLDOWN_MS` (30 min), `LLM_MODEL`, `GEMINI_TRANSCRIBE_MODEL`.

---

## Where your data lives (and what leaves your machine)

| Layer | Stores | Persistence | Location |
|---|---|---|---|
| **MinIO** (object storage) | The **raw uploaded files** (video, audio, PDF, …) | Persistent | Docker volume `infra_miniodata` · console at :9001 |
| **PostgreSQL + pgvector** | All **derived data**: `sources` (metadata, transcript, storage pointer), `chunks` (+ embeddings), `insights` + `insight_evidence` + tags, `flow_stages`, `processing_jobs`, `projects`, `saved_views` | Persistent | Docker volume `infra_pgdata` |
| **Redis** | The BullMQ job queue (which source to process next) | Ephemeral by design | In-memory, no volume |

- **Files** land in storage via a presigned `PUT` straight from the browser
  (`uploads/staging/…` → moved to `projects/{projectId}/sources/{sourceId}/original/…`).
  The byte stream never passes through the app server.
- Both Docker volumes survive `docker compose down` and restarts. They are wiped
  only by `docker compose down -v`. There are **no automatic backups** — for
  production, point storage at S3/R2 and the DB at a managed Postgres (see Deploying).

### ⚠️ Data that leaves your machine

When you use real AI providers, content is sent to that provider's API:

- **Gemini** receives: chunk **text** (for embeddings + insight extraction) and the
  **extracted audio** of audio/video files (for transcription). Transcription audio
  is uploaded to Google's **File API, where it is stored temporarily (~48 h) and then
  auto-deleted**. The raw video itself stays local — only its audio track is sent.
- With `*_PROVIDER=local` (the stub), **nothing leaves the machine** — but quality is
  rough (hashed embeddings, heuristic insights, no transcription).

Everything else — the original files, transcripts, embeddings, insights — stays in
your local MinIO + Postgres.

---

## Quick start (Docker — the easy path)

Requires Docker Desktop only. From the repo root:

```bash
cp .env.example .env                 # add GEMINI_API_KEY for real AI (optional)
docker compose --env-file .env -f infra/docker-compose.yml up --build
```

> **`--env-file .env` matters:** the compose file lives in `infra/`, so Compose
> otherwise looks for `.env` *there*, not at the repo root, and silently falls back
> to the local stub. Pass `--env-file .env` so your root `.env` is actually applied.

This brings up Postgres+pgvector, Redis, MinIO, the web app, and the worker. On boot
the web container runs migrations and seeds the 33-stage taxonomy. Then open:

- App: **http://localhost:3000**
- MinIO console: **http://localhost:9001** (`minioadmin` / `minioadmin`)

Upload a `.txt`, `.csv`, `.pdf`, image, or **audio/video** file and watch it move
`pending → processing → ready`, then appear in Insights and the Flow Map.

### Configuration cheat-sheet (`.env`)

```bash
EMBED_PROVIDER=gemini            # gemini | openai | local
LLM_PROVIDER=gemini              # gemini | anthropic | local
LLM_MODEL=gemini-2.5-flash-lite  # gemini default (high free-tier quota)
GEMINI_API_KEY=...               # one key: embeddings + LLM + transcription
# TRANSCRIBE_PROVIDER defaults to gemini whenever GEMINI_API_KEY is set
```

---

## What runs where

| Service / package | Role |
|---|---|
| `apps/web` | Next.js UI (4 views) + tRPC API + presigned uploads |
| `workers` | BullMQ consumer that runs the pipeline (has `ffmpeg` for transcription) |
| `packages/pipeline` | The stages: extract → normalize → chunk → embed → classify → insight |
| `packages/ai` | Provider adapters (Gemini / OpenAI / Anthropic / local) + the rate-limited Gemini client |
| `packages/db` | Prisma schema, migrations, pgvector + hybrid-search SQL |
| `packages/core` | Pure logic: naming, chunking, zod schemas, RRF fusion |

---

## Local dev (without Docker)

Needs Node 20+, pnpm, and a Postgres 16 with pgvector + Redis + S3/MinIO. For
transcription you also need `ffmpeg` on your `PATH`.

```bash
pnpm install
cp apps/web/.env.example apps/web/.env   # point at your services
pnpm db:generate && pnpm db:migrate && pnpm db:seed
pnpm dev            # web on :3000
pnpm worker         # in a second terminal
```

---

## Deploying for real

GitHub Pages can't host this (it needs a Node server + Postgres + Redis + S3).
Two realistic targets:

1. **Single VM (simplest):** any Linux box with Docker. `git clone`, set `.env`,
   `docker compose --env-file .env -f infra/docker-compose.yml up -d --build`, put a
   reverse proxy (Caddy/nginx) in front for TLS. Swap MinIO for S3/R2 in prod.
2. **Managed (scales better):** web on Vercel/Railway, Postgres on Neon/Supabase
   (enable pgvector), Redis on Upstash, storage on S3/R2. Set the same env vars and
   run `pnpm db:migrate` once against the managed DB.

See `ARCHITECTURE.md`, `SPINE.md`, and `SEARCH.md` for the full design.

---

## Status / known caveats

**Verified end-to-end on the Docker stack** with Gemini. Text and PDF sources flow
through the whole pipeline to `status: ready` with real 3072-dim embeddings,
flow-stage tags, and insights linked to their exact source quote; all four UI views
render live data. **Video transcription** is verified too: a ~1-hour recording →
~43k-char speaker-labeled transcript (ffmpeg audio → Gemini File API), coalesced into
~chunk-sized timed segments before chunking.

Caveats:
- **Free-tier embedding quota is also daily.** Processing a large transcript makes
  many embedding calls; on the free tier this can exhaust the day's embedding quota
  mid-run, leaving the source `partial`. It resumes cleanly on re-run once quota
  resets (stages are idempotent) or with a paid key.
- **No automated test suite is committed yet.** Verification is the live end-to-end
  boot above, not unit tests.
- **AI quality needs keys.** With the local stub the pipeline completes but flow-stage
  tagging is empty (stage embeddings need a real embeddings provider) and insight
  titles are heuristic; transcription is skipped. Use Gemini/OpenAI/Anthropic for
  real results.
- **Flow-Map insight counts** are sparse: an insight only links to a stage when the
  model's `flow_stage_hints` match a stage slug. Source counts are well-populated.
- The pgvector index uses `halfvec` because embeddings are 3072-dim (HNSW caps at
  2000 on `vector`); see `packages/db/README.md`.
