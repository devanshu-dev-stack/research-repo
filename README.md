# Research Repository

Product-research ingestion, auto-tagging against a Student/Faculty user-flow
taxonomy, insight extraction with full source traceability, and hybrid search.

Monorepo: Next.js + TypeScript + PostgreSQL/pgvector + Redis/BullMQ + S3.

## Quick start (Docker — the easy path)

Requires Docker Desktop only. From the repo root:

```bash
cp .env.example .env                 # optional: add API keys for real AI
docker compose -f infra/docker-compose.yml up --build
```

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

This was assembled in stages and each package typechecks, with unit tests on the
pure logic (naming, chunking, RRF, insight validation). A full live boot has not
been run yet — expect to shake out a few integration issues on first
`docker compose up` (the diagnostics and idempotent migrations are there to make
that quick). The pgvector index uses `halfvec` because embeddings are 3072-dim
(see `packages/db/README.md`).
