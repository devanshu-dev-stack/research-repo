# Ingestion → Repository Spine

The end-to-end path that takes an uploaded file and makes it a searchable,
chunked, embedded `source` row — text formats first (note, transcript, survey).
Media (audio/video/pdf/image) plug into the same shape via later stages.

## Flow

```
browser
  │  1. POST /api/upload/presign         → presigned PUT URLs (staging keys)
  │  2. PUT bytes directly to S3/R2/MinIO (no proxy through the app)
  │  3. sources.create (tRPC)            → Source row (pending) + dedupe + enqueue
  ▼
queue (BullMQ, or inline if no REDIS_URL)
  ▼
pipeline.runPipeline(sourceId)
  ├─ extract    media→text: transcribe (audio/video) · OCR (image) · doc text (pdf/doc)
  ├─ normalize  extract canonical content + units, set canonical name      (status→processing)
  ├─ chunk      split units → chunk rows (page/response_ref/timing kept)
  ├─ embed      embed each chunk → vector(3072) via setEmbedding
  ├─ classify   two-pass flow-stage tagging (semantic shortlist + LLM adjudication)
  └─ insight    LLM extraction → insights + evidence links + dedupe          (status→ready)
```

`extract` runs first and feeds `normalize` (text formats skip it). Failure
after `chunk` → `partial` (still searchable); failure before → `failed`.
Every stage writes a `processing_jobs` audit row and is idempotent.

## The two-pass classifier (classify stage)

- **Pass A — semantic shortlist (free):** each chunk embedding is cosine-matched
  against `flow_stages.embedding` via `matchFlowStages`; stages above
  `CLASSIFY_THRESHOLD` become candidates (max score kept per stage).
- **Pass B — LLM adjudication (only when ambiguous):** triggered when a chunk's
  top match is weak (`< threshold + 0.1`) or the top two are within
  `0.05`. The LLM picks among the ≤4-stage shortlist. Most chunks never hit Pass B.
- **Override-safe:** only `origin='auto'` tags are cleared on re-run; `manual`/
  `override` rows set by an editor are never touched.

## Insight extraction + traceability (insight stage)

Per chunk, the LLM returns drafts validated **per-entry** against the Zod
contract (one malformed draft doesn't discard the chunk's others). Each kept
draft is embedded, **deduped** against existing same-kind insights
(`nearestInsights` ≥ `INSIGHT_DEDUPE_SCORE` → attach + `frequency++` instead of
duplicating), and linked to its chunk via `insight_evidence` with the exact
quote. That `insight → evidence → chunk → source` chain (chunk carries
ms-timing / page / response_ref) is the source-traceability spine. Re-runs clear
this source's prior evidence and prune orphaned insights, so they converge.

## Packages

| Path | Role |
|---|---|
| `packages/core` | Pure logic: slugify + `canonicalName`, `chunkContent`, Zod schemas, `detectSourceType`. No I/O. |
| `packages/ai` | `AIProvider` adapter. `OpenAIEmbedProvider` + `LocalStubProvider` (runs with no keys). Selected per-env. |
| `packages/pipeline` | `storage` (presign/get), the three stages, and `runPipeline` orchestrator. |
| `apps/web/src/server` | `sources.service` (presign + create + dedupe + move), tRPC `sources` router, queue enqueue. |
| `apps/web/src/app/api/upload/presign` | REST presign endpoint. |
| `apps/web/src/lib/upload.ts` | Browser helper: presign → PUT → create, with SHA-256 dedupe. |
| `workers/src/index.ts` | BullMQ worker draining the pipeline queue. |

## Running without external services

- **No OpenAI key** → `LocalStubProvider` produces deterministic 3072-dim unit
  vectors so the pipeline completes (not for production retrieval quality).
- **No Redis** → `enqueuePipeline` runs the pipeline inline (fire-and-forget);
  the request still returns immediately.
- **No S3** → `createSource` keeps the staging key if the copy fails; normalize
  reads whatever key is set. (Provide MinIO via `infra/` for the real path.)

These fallbacks make the spine runnable in dev/CI; set the env vars to flip each
to its production provider with no code change.

## Source-type coverage

Text: **note**, **transcript** (UTF-8), **survey** (CSV → one traceable unit per
row). Media via the `extract` stage: **audio/video** → transcription with
per-utterance ms timing (Deepgram; `noop` fallback), **image** → OCR with word
bboxes (Tesseract.js, pure-JS), **pdf/doc** → text with page units (pdf-parse /
mammoth). Media providers are optional deps — unconfigured, the source becomes
`partial` rather than failing.

## Verification status

- `packages/core`: typechecks clean; 12 tests pass (naming, chunking,
  source-type detection, survey→chunk→embed dims, **per-entry insight
  validation**, severity bounds).
- `packages/ai`: typechecks clean (incl. new Anthropic LLM provider); 4 tests
  pass on JSON-parse tolerance (fences, leading prose, garbage→null, no-throw).
- `packages/pipeline`: all six stages typecheck clean under `strict`.
- Not run here (no Postgres/Redis/S3/model APIs in the sandbox): a live
  upload→ready round-trip and real LLM calls. Run against the `infra/` stack
  with `LLM_PROVIDER=anthropic` + keys for production behavior.

## Provider selection (all env, no code change)

`EMBED_PROVIDER` (openai|local) · `LLM_PROVIDER` (anthropic|local) ·
`TRANSCRIBE_PROVIDER` (deepgram|noop) · `OCR_PROVIDER` (tesseract|noop) ·
`DOC_PROVIDER` (local|noop). Every one falls back to a stub/no-op so the full
pipeline runs offline.

## Next stages (same orchestrator shape)

`cluster` (project-wide insight clustering beyond pairwise dedupe) — plus the
search layer (hybrid keyword + vector with RRF) that reads everything these
stages wrote.
