# Research Repository

Product-research ingestion, auto-tagging against a Student/Faculty user-flow
taxonomy, insight extraction with full source traceability, and hybrid search.

Monorepo: Next.js + TypeScript + PostgreSQL/pgvector + Redis/BullMQ + S3.

## Quick start (Docker — the easy path)

Requires Docker Desktop only. From the repo root:

```bash
cp .env.example .env                 # optional: add API keys for real AI
docker compose --env-file .env -f infra/docker-compose.yml up --build
```

> **`--env-file .env` matters:** because the compose file lives in `infra/`,
> Compose otherwise looks for `.env` *there*, not at the repo root, and silently
> falls back to the local stub. Pass `--env-file .env` so your root `.env`
> (provider choices + API keys) is actually applied.

This brings up Postgres+pgvector, Redis, MinIO (object storage), the web app,
and the worker. On boot the web container runs migrations + seeds the taxonomy.

Then open:
- App: http://localhost:3000
- MinIO console: http://localhost:9001 (minioadmin / minioadmin)

Upload a `.txt`, `.csv`, `.pdf`, or audio/video file from the Repository page and
watch it move `pending → processing → ready`, get chunked, embedded, tagged to
flow stages, and mined for insights. Search is hybrid keyword + semantic.

**With no API keys** the pipeline uses a local stub (deterministic embeddings,
heuristic insights) so everything runs end-to-end offline — relevance is rough
but the full flow works. Set `EMBED_PROVIDER=openai` + `LLM_PROVIDER=anthropic`
with keys in `.env` for production quality.

**Gemini** (`EMBED_PROVIDER=gemini` + `LLM_PROVIDER=gemini`, one `GEMINI_API_KEY`)
covers embeddings *and* the LLM. The provider paces requests to the free-tier
per-minute budget (`GEMINI_LLM_RPM` / `GEMINI_EMBED_RPM`), runs them concurrently
up to `GEMINI_MAX_CONCURRENCY`, batches insight extraction (`INSIGHT_BATCH` chunks
per call), and auto-retries on 429 — so large files slow down rather than fail.

> **Free-tier daily cap:** `gemini-2.5-flash` allows only ~20 LLM requests/day,
> so the default `LLM_MODEL` is **`gemini-2.5-flash-lite`** (far higher daily
> quota). If a day's quota is exhausted the insight stage marks the source
> `partial` and records the reason; re-run it later (stages are idempotent) or
> use a paid key. Embeddings have a separate, larger quota.

## Local dev (without Docker)

Needs Node 20+, pnpm, and a Postgres 16 with pgvector + a Redis + an S3/MinIO.

```bash
pnpm install
cp apps/web/.env.example apps/web/.env   # point at your services
pnpm db:generate && pnpm db:migrate && pnpm db:seed
pnpm dev            # web on :3000
pnpm worker         # in a second terminal
```

## What runs where

| Service | Role |
|---|---|
| `apps/web` | Next.js UI + tRPC API + presigned uploads |
| `workers` | BullMQ consumer running the pipeline |
| `packages/db` | Prisma schema, migrations, vector + search SQL |
| `packages/pipeline` | extract → normalize → chunk → embed → classify → insight |
| `packages/ai` | provider adapters (OpenAI / Anthropic / local stub) |
| `packages/core` | pure logic: naming, chunking, schemas, RRF |

## Deploying for real

GitHub Pages can't host this (it needs a Node server + Postgres + Redis + S3).
Two realistic targets:

1. **Single VM (simplest):** any Linux box with Docker. `git clone`, set `.env`,
   `docker compose -f infra/docker-compose.yml up -d --build`, put a reverse
   proxy (Caddy/nginx) in front for TLS. Swap MinIO for S3/R2 in prod.
2. **Managed (scales better):** web on Vercel/Railway, Postgres on
   Neon/Supabase (enable pgvector), Redis on Upstash, storage on S3/R2. Set the
   same env vars; run `pnpm db:migrate` once against the managed DB.

See `ARCHITECTURE.md`, `SPINE.md`, and `SEARCH.md` for the full design.

## Status / known caveats

**Booted and verified end-to-end** (2026-06-05) on the Docker stack: all 6
packages typecheck clean, `docker compose up` brings up the full stack, the boot
migration+seed runs (33 Student/Faculty flow stages), and a real upload
(presign → PUT to MinIO → `sources.create`) flows through the whole pipeline
(`extract → normalize → chunk → embed → classify → insight`) to `status: ready`
with chunks embedded, sentiment detected, and insights linked back to their
source chunk + exact quote.

Integration fixes applied during that first boot (in the working tree): Prisma 7
transaction-callback + bare-`PrismaClient()` (seed) typing, `ioredis` dedupe via
a pnpm override, a `pdf-parse` type shim, web↔package wiring (`@research-repo/ai`
dep + pipeline `./storage` export), a **dual S3 endpoint** so presigned upload
URLs are browser-reachable (`S3_PUBLIC_ENDPOINT`) while the app keeps the
internal one, and **superjson** as the tRPC transformer so `BigInt`/`Date`
fields (e.g. `sources.byteSize` in the source-detail view) serialize.

Caveats:
- **No automated test suite is committed yet.** Verification so far is the live
  end-to-end boot above, not unit tests. (`packages/core` has a `test` script
  but the `test/` files are not present — adding them is the next hardening step.)
- **AI quality needs keys.** With no keys the pipeline runs on a deterministic
  local stub: it completes end-to-end, but flow-stage tagging is empty (stage
  embeddings are only generated when an embeddings provider is configured) and
  insight titles are heuristic. Set `EMBED_PROVIDER=openai` + `LLM_PROVIDER=anthropic`
  (and re-seed) for production-quality tagging/insights.
- The pgvector index uses `halfvec` because embeddings are 3072-dim (see
  `packages/db/README.md`).
