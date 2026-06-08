# CLAUDE.md — context for Claude Code

## What this is
A research-repository platform: ingest product-research files → normalize →
chunk → embed → tag against a Student/Faculty user-flow taxonomy → extract
insights with source traceability → hybrid search. Monorepo (pnpm + turbo).

## Stack
Next.js 15 (App Router) + TypeScript · Prisma 7 + PostgreSQL 16 + pgvector ·
BullMQ/Redis · S3-compatible storage · tRPC. AI via provider adapters
(OpenAI embeddings, Anthropic LLM, or a local stub that needs no keys).

## Layout
- `apps/web` — UI, tRPC routers (`src/server/routers`), services, presign route
- `workers` — BullMQ pipeline consumer
- `packages/db` — Prisma schema, 3 migrations, `vector.ts` + `search.ts` raw SQL
- `packages/pipeline` — stages: extract, normalize, chunk, embed, classify, insight
- `packages/ai` — provider adapters + factories (`getEmbedProvider`, `getLLMProvider`)
- `packages/core` — pure logic: naming, chunking, zod schemas, RRF fusion

## Run it
`docker compose -f infra/docker-compose.yml up --build` (see README).
Local: `pnpm install && pnpm db:generate && pnpm db:migrate && pnpm db:seed`,
then `pnpm dev` + `pnpm worker`.

## Important implementation facts (don't regress these)
- **pgvector + 3072 dims:** HNSW caps at 2000 dims on `vector`, so indexes use
  `halfvec(3072)`. Vector queries MUST cast both sides to `halfvec` or they fall
  back to seq scan. See `packages/db/src/vector.ts` / `search.ts`.
- **Vectors aren't typed in Prisma:** `embedding`/`text_tsv` are
  `Unsupported(...)`; write via `setEmbedding`, read via raw SQL helpers.
- **Prisma 7:** the DB URL lives in `prisma.config.ts`, not the schema; the
  client uses the `@prisma/adapter-pg` driver adapter.
- **Stages are idempotent** (delete-then-write or embed-only-where-null) so the
  worker can retry safely. `runPipeline` sets status pending→processing→ready,
  or partial/failed.
- **Classifier is two-pass:** semantic shortlist (free) then LLM only on
  ambiguous chunks. Manual/override flow tags are never overwritten by re-runs.
- **Traceability chain:** insight → insight_evidence → chunk → source, with
  chunk carrying ms-timing / page / response_ref. Preserve it.

## Known gaps to expect on first boot
- No full live boot has been run; first `docker compose up` may need fixes
  (pnpm lockfile generation, Prisma engine fetch, Next transpile of workspace
  TS packages — `transpilePackages` is already set).
- `pnpm-lock.yaml` isn't committed; Dockerfiles fall back to non-frozen install.
- UI is a minimal repository+upload+search page; the Insight/Flow/Detail views
  from `wireframes.html` aren't built as React yet.

## Verify changes
`pnpm typecheck` across packages. Pure-logic packages have node:test suites
(`pnpm --filter @research-repo/core test`). After schema changes:
`pnpm db:generate` then a fresh `pnpm db:migrate`.
