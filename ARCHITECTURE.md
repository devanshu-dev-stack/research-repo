# Research Repository — System Architecture & Implementation Blueprint

**Codename:** Collage Research Repository (CRR)
**Status:** Blueprint v1.0
**Stack decision:** Next.js · TypeScript · Tailwind · Node.js · PostgreSQL + pgvector · BullMQ/Redis
**AI posture:** Hybrid — cloud APIs where they win on quality/cost, self-hostable fallbacks where it matters
**Date:** 2026-06-05

---

## 0. How to read this document

This is a buildable blueprint, not prose. Each section maps to one of your 15 deliverables and is written so an engineer can start a ticket from it. Sections:

1. System architecture (the big picture)
2. Tech stack & rationale
3. Database schema (full DDL)
4. Processing pipeline design
5. AI tagging & classification strategy
6. Search architecture
7. File storage strategy
8. Folder structure
9. Frontend information architecture
10. Deployment strategy
11. Scalable ingestion workflow
12. Example APIs
13. UI wireframes (separate HTML file)
14. Background worker architecture
15. Security & privacy

A short FigJam-import note and a build sequencing plan close it out.

---

## 1. System Architecture

### 1.1 Component map

```
                          ┌─────────────────────────────────────────┐
                          │              Browser (Next.js)           │
                          │  Repository · Insights · Flow · Sources  │
                          └───────────────┬─────────────────────────┘
                                          │ HTTPS / tRPC or REST
                          ┌───────────────▼─────────────────────────┐
                          │            Next.js App (API routes)       │
                          │  Auth · Upload presign · Query · Mutations│
                          └──┬──────────────┬───────────────┬─────────┘
                             │              │               │
            enqueue jobs ────┘              │ read/write    │ presigned URLs
                             │              │               │
                   ┌─────────▼────┐  ┌──────▼───────┐  ┌────▼─────────┐
                   │ Redis + BullMQ│ │  PostgreSQL  │  │ Object Store │
                   │  job queues   │ │  + pgvector  │  │ (S3 / R2)    │
                   └───────┬───────┘ └──────────────┘  └──────────────┘
                           │ consumed by
                   ┌───────▼───────────────────────────────────────────┐
                   │              Worker pool (Node processes)           │
                   │  ingest → extract → normalize → embed → classify    │
                   │  → insight-extract → cluster                        │
                   └───┬───────────────┬───────────────┬────────────────┘
                       │               │               │
              ┌────────▼───┐   ┌───────▼──────┐  ┌─────▼─────────┐
              │ Transcribe │   │ OCR / Doc    │  │ LLM + Embeddings│
              │ (Whisper / │   │ extract      │  │ (provider      │
              │  Deepgram) │   │ (Tika/unpdf) │  │  adapter layer)│
              └────────────┘   └──────────────┘  └────────────────┘
```

### 1.2 Request vs. background split

- **Synchronous (request path):** auth, presigned upload URLs, querying the repo, manual tag edits, opening source previews. All sub-200ms reads against Postgres.
- **Asynchronous (worker path):** everything expensive and slow — transcription, OCR, text extraction, embedding, LLM classification, insight extraction, clustering. The UI shows live status (`pending → processing → ready → failed`) via polling or a lightweight SSE channel.

The hard rule: **the upload returns the moment the file is stored and a job is enqueued.** No processing happens on the request thread.

### 1.3 Data flow in one sentence

A file is uploaded → stored in object storage → a `source` row is created in `pending` → a pipeline job runs the stages → each stage writes back to the `source` and creates child rows (`chunks`, `insights`, `embeddings`) → the source flips to `ready` and appears, fully tagged and searchable, in the repository.

---

## 2. Tech Stack & Rationale

| Layer | Choice | Why this, not the alternative |
|---|---|---|
| Framework | **Next.js (App Router) + TypeScript** | One codebase for UI + API; you already chose it. SSR for fast repo loads, RSC for data-heavy views. |
| Styling | **Tailwind + CSS variables for brand tokens** | Brand tokens map cleanly to CSS vars; utility classes keep components consistent and keyboard-friendly. |
| API layer | **tRPC** (internal) + thin REST for uploads/webhooks | tRPC gives end-to-end type safety with zero schema duplication. REST only where external callers/webhooks need it. |
| ORM | **Prisma** (+ raw SQL for vector queries) | Type-safe schema, great migrations DX. pgvector queries drop to raw SQL via `$queryRaw`. |
| DB | **PostgreSQL 16 + pgvector** | Your call, and the right one for this volume — one system to operate, transactional integrity between insights and their vectors. |
| Queue | **BullMQ on Redis** | Mature, observable, supports retries/backoff/rate-limits/repeatable jobs. Node-native. |
| Object storage | **S3-compatible (AWS S3 or Cloudflare R2)** | R2 has no egress fees — meaningful when previewing media often. Same SDK either way. |
| Transcription | **Cloud: Deepgram or OpenAI Whisper API. Self-host: faster-whisper** | Cloud for accuracy/speed at low ops cost; swap to self-hosted whisper if data residency requires it. |
| OCR | **Cloud: Google Vision / Textract. Self-host: Tesseract + PaddleOCR** | Tesseract is fine for clean screenshots; Vision wins on messy/handwritten. Adapter lets you pick per-job. |
| Doc extraction | **Apache Tika (server) or unpdf/mammoth (in-process)** | Tika handles the long tail of formats; lightweight libs cover PDF/DOCX without a JVM if you'd rather. |
| Embeddings | **Cloud: OpenAI `text-embedding-3-large` (or Voyage). Self-host: `bge-large` / `nomic-embed`** | 3-large is strong and cheap. Self-host path keeps you provider-independent. Dimension pinned in config. |
| LLM (classify/summarize) | **Cloud: Claude / GPT-class. Self-host: Llama-class via vLLM** | Classification + JTBD extraction need a capable model; adapter keeps it replaceable later (your constraint). |

**Hybrid recommendation, concretely:** start on cloud for transcription, embeddings, and LLM (fastest path to value, lowest ops). Keep OCR on Tesseract for cost. The provider-adapter layer (§5.4) means swapping any one of these to self-hosted is a config + one-file change, never a rewrite.

---

## 3. Database Schema

Postgres 16, `vector` extension enabled. Embedding dimension shown as 3072 (OpenAI 3-large); pin to your chosen model.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy keyword search
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────
-- Projects / collections
-- ─────────────────────────────────────────────────────────
CREATE TABLE projects (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────
-- User-flow taxonomy (imported/derived from FigJam)
-- Self-referential to support nested stages.
-- ─────────────────────────────────────────────────────────
CREATE TABLE flow_stages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  parent_id   UUID REFERENCES flow_stages(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,           -- "Checkout"
  slug        TEXT NOT NULL,           -- "checkout"
  description TEXT,                    -- seeds the classifier prompt + embedding
  position    INT DEFAULT 0,
  embedding   vector(3072),           -- stage description embedded for semantic match
  source_ref  TEXT,                    -- FigJam node id, for re-sync
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parent_id, slug)
);

-- ─────────────────────────────────────────────────────────
-- Sources = one uploaded research artifact (the unified object)
-- ─────────────────────────────────────────────────────────
CREATE TYPE source_type AS ENUM (
  'survey','video','audio','transcript','note','pdf','doc','image','other'
);
CREATE TYPE processing_status AS ENUM (
  'pending','processing','ready','failed','partial'
);

CREATE TABLE sources (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  source_type     source_type NOT NULL,
  status          processing_status NOT NULL DEFAULT 'pending',

  -- naming + file
  original_name   TEXT NOT NULL,          -- as uploaded
  canonical_name  TEXT,                   -- [type]_[source]_[date]_[topic].ext
  storage_key     TEXT NOT NULL,          -- object-store key
  mime_type       TEXT,
  byte_size       BIGINT,
  checksum_sha256 TEXT,                    -- dedupe key

  -- normalized content
  participant     TEXT,
  topic           TEXT,
  content         TEXT,                    -- canonical extracted text
  transcript      TEXT,                    -- for audio/video
  sentiment       TEXT,                    -- positive | neutral | negative | mixed
  language        TEXT,

  -- timestamps
  recorded_at     TIMESTAMPTZ,             -- when the research happened
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,

  -- flexible bag
  metadata        JSONB NOT NULL DEFAULT '{}',
  error           TEXT,                    -- last failure reason

  UNIQUE (checksum_sha256)                 -- hard dedupe; soft handling in app layer
);
CREATE INDEX idx_sources_project   ON sources(project_id);
CREATE INDEX idx_sources_status    ON sources(status);
CREATE INDEX idx_sources_type      ON sources(source_type);
CREATE INDEX idx_sources_recorded  ON sources(recorded_at);
CREATE INDEX idx_sources_content_trgm ON sources USING gin (content gin_trgm_ops);

-- ─────────────────────────────────────────────────────────
-- Chunks = retrievable units (for RAG + timestamped traceability)
-- ─────────────────────────────────────────────────────────
CREATE TABLE chunks (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id     UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ordinal       INT NOT NULL,             -- chunk order within source
  text          TEXT NOT NULL,
  embedding     vector(3072),
  -- media traceability
  start_ms      INT,                      -- clip start (audio/video)
  end_ms        INT,
  page          INT,                      -- pdf/doc page
  bbox          JSONB,                    -- image OCR region [x,y,w,h]
  -- survey traceability
  response_ref  TEXT,                     -- survey row / question id
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chunks_source ON chunks(source_id);
-- HNSW for fast ANN; cosine distance to match normalized embeddings
CREATE INDEX idx_chunks_embedding ON chunks
  USING hnsw (embedding vector_cosine_ops);

-- ─────────────────────────────────────────────────────────
-- Tags: many-to-many between sources and flow stages (+ free tags)
-- ─────────────────────────────────────────────────────────
CREATE TYPE tag_origin AS ENUM ('auto','manual','override');

CREATE TABLE source_flow_tags (
  source_id   UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  stage_id    UUID NOT NULL REFERENCES flow_stages(id) ON DELETE CASCADE,
  confidence  REAL,                       -- 0..1 from classifier
  origin      tag_origin NOT NULL DEFAULT 'auto',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, stage_id)
);
CREATE INDEX idx_sft_stage ON source_flow_tags(stage_id);

CREATE TABLE tags (                        -- free-form / feature-area tags
  id    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name  TEXT UNIQUE NOT NULL,
  color TEXT
);
CREATE TABLE source_tags (
  source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
  tag_id    UUID REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, tag_id)
);

-- ─────────────────────────────────────────────────────────
-- Insights = reusable entities extracted from sources
-- ─────────────────────────────────────────────────────────
CREATE TYPE insight_kind AS ENUM (
  'pain_point','feature_request','ux_friction','positive',
  'theme','job_to_be_done','goal'
);

CREATE TABLE insights (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,
  kind        insight_kind NOT NULL,
  title       TEXT NOT NULL,              -- short, deduped label
  summary     TEXT,                       -- LLM synthesis across evidence
  severity    INT,                        -- 1..5
  frequency   INT DEFAULT 1,              -- count of supporting evidence
  embedding   vector(3072),              -- for clustering + dedupe
  cluster_id  UUID,                       -- assigned by clustering job
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_insights_kind    ON insights(kind);
CREATE INDEX idx_insights_cluster ON insights(cluster_id);
CREATE INDEX idx_insights_embedding ON insights
  USING hnsw (embedding vector_cosine_ops);

-- Evidence links every insight back to a specific chunk (= source + timestamp/page)
CREATE TABLE insight_evidence (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  insight_id UUID NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  chunk_id   UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  quote      TEXT,                         -- the exact supporting snippet
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_evidence_insight ON insight_evidence(insight_id);
CREATE INDEX idx_evidence_chunk   ON insight_evidence(chunk_id);

-- Insights also inherit/relate to flow stages
CREATE TABLE insight_flow_tags (
  insight_id UUID REFERENCES insights(id) ON DELETE CASCADE,
  stage_id   UUID REFERENCES flow_stages(id) ON DELETE CASCADE,
  PRIMARY KEY (insight_id, stage_id)
);

-- ─────────────────────────────────────────────────────────
-- Saved views / collections
-- ─────────────────────────────────────────────────────────
CREATE TABLE saved_views (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL,
  filters    JSONB NOT NULL DEFAULT '{}',  -- serialized filter state
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────
-- Job audit (mirrors BullMQ, but queryable + permanent)
-- ─────────────────────────────────────────────────────────
CREATE TABLE processing_jobs (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id  UUID REFERENCES sources(id) ON DELETE CASCADE,
  stage      TEXT NOT NULL,                -- 'transcribe','ocr','embed',...
  status     TEXT NOT NULL,                -- queued|active|completed|failed
  attempts   INT DEFAULT 0,
  error      TEXT,
  started_at TIMESTAMPTZ,
  ended_at   TIMESTAMPTZ
);
CREATE INDEX idx_jobs_source ON processing_jobs(source_id);
```

**Schema notes**
- The JSON object in your spec maps to a `sources` row plus its `chunks`, `source_flow_tags`, and derived `insights`. `feature_requests`/`pain_points` are not columns — they're `insights` with a `kind`, so they're reusable and clusterable rather than trapped in one row.
- **Traceability is structural, not optional:** every insight reaches its origin through `insight_evidence → chunks → sources`, and a chunk carries `start_ms/end_ms`, `page`, `bbox`, or `response_ref`. That's how a quote opens to the exact 0:42 of a video or row 17 of a survey.
- pgvector `hnsw` indexes give fast approximate search; `pg_trgm` covers fuzzy keyword. Hybrid search (§6) combines both.

---

## 4. Processing Pipeline Design

### 4.1 Stages (each is a discrete, retryable job)

```
 upload
   │
   ▼
[1 ingest]      validate · checksum · dedupe check · write source row (pending)
   │
   ▼
[2 extract]     branch by type:
   │              audio/video → transcribe (Whisper/Deepgram) → transcript + word timings
   │              image       → OCR (Tesseract/Vision) → text + bbox
   │              pdf/doc      → text extract (Tika/unpdf/mammoth) → text + page map
   │              survey       → parse rows → per-response records
   │              note/text    → passthrough
   ▼
[3 normalize]   build canonical `content`, detect language, generate canonical_name,
   │            set participant/topic/recorded_at from metadata
   ▼
[4 chunk]       split content into retrieval units, preserving timing/page/bbox/response_ref
   ▼
[5 embed]       embed each chunk (batched) → write vector(...) on chunks
   ▼
[6 classify]    map chunks/source to flow_stages (semantic + LLM) → source_flow_tags
   ▼
[7 insight]     LLM extracts pain points / requests / JTBD / sentiment per chunk
   │            → insights + insight_evidence (with exact quote + chunk link)
   ▼
[8 cluster]     (periodic, project-wide) group near-duplicate insights → cluster_id,
                bump frequency, recompute severity
   ▼
 status → ready
```

### 4.2 Failure & partial-success policy

- Each stage retries with exponential backoff (BullMQ: 3 attempts, 2^n × base).
- If a non-critical stage fails (e.g., insight extraction) but earlier ones succeeded, the source is marked `partial` and still appears/searchable. The failed stage can be re-run from the source detail page.
- `processing_jobs` records every attempt for observability and a "retry stage" button.

### 4.3 Idempotency

Stages are keyed by `(source_id, stage)` and write deterministically (delete-then-insert child rows for that stage). Re-running a stage never duplicates chunks or insights.

---

## 5. AI Tagging & Classification Strategy

### 5.1 Building the taxonomy from the flow

1. Import flow stages (FigJam export or seed list) into `flow_stages`, each with a `description`.
2. Embed each stage's `name + description` → `flow_stages.embedding`.
3. That embedding set *is* the classifier's reference space.

### 5.2 Two-pass classification (cheap → precise)

- **Pass A — semantic shortlist (free, fast):** cosine-match each source/chunk embedding against `flow_stages.embedding`. Keep stages above a similarity threshold (e.g., 0.30) as candidates. Most content resolves here.
- **Pass B — LLM adjudication (only on ambiguous cases):** when top candidates are close or below threshold, send the chunk + candidate stage descriptions to the LLM and ask for the best-fitting stage(s) with confidence. This keeps LLM spend low while improving precision where it matters.

Multi-tagging falls out naturally — any stage above threshold (or LLM-confirmed) is written to `source_flow_tags` with `confidence` and `origin='auto'`. Manual edits write `origin='manual'`/`'override'` and are never overwritten by re-runs.

### 5.3 Insight extraction prompt contract

The LLM is asked, per chunk, to return strict JSON:

```json
{
  "insights": [
    {
      "kind": "pain_point",
      "title": "Can't find saved items after onboarding",
      "quote": "I set everything up but then couldn't find my saved courses",
      "severity": 4,
      "sentiment": "negative",
      "flow_stage_hints": ["onboarding","search"]
    }
  ]
}
```

The app validates against a Zod schema, drops malformed entries, and links each insight to its chunk via `insight_evidence` (preserving the exact `quote` and therefore the timestamp/page).

### 5.4 Provider adapter (your "keep it replaceable" constraint)

A single interface decouples the pipeline from vendors:

```ts
interface AIProvider {
  embed(texts: string[]): Promise<number[][]>;
  transcribe(fileUrl: string): Promise<{ text: string; words: Word[] }>;
  classify(input: ClassifyInput): Promise<StageMatch[]>;
  extractInsights(chunk: string): Promise<InsightDraft[]>;
  summarize(texts: string[]): Promise<string>;
}
```

Implementations: `OpenAIProvider`, `AnthropicProvider`, `LocalProvider` (vLLM/whisper/bge). Selected per-capability via env (`EMBED_PROVIDER=openai`, `LLM_PROVIDER=anthropic`, `OCR_PROVIDER=tesseract`). Swapping later is one env change, not a refactor.

---

## 6. Search Architecture

**Hybrid search** — keyword + semantic, fused.

1. **Keyword:** `pg_trgm` / `tsvector` over `sources.content` and `chunks.text` for exact and fuzzy matches.
2. **Semantic:** embed the query → pgvector cosine ANN over `chunks.embedding` (and `insights.embedding` for insight search).
3. **Fusion:** combine with Reciprocal Rank Fusion (RRF) so neither modality dominates; return chunks, then group by source.
4. **Filters** (applied as SQL `WHERE` before/with ranking): flow stage, feature area/tag, sentiment, date range, source type, participant segment, project.

```sql
-- Semantic leg (parameterized embedding $1, filters folded in)
SELECT c.id, c.source_id, c.text,
       1 - (c.embedding <=> $1) AS score
FROM chunks c
JOIN sources s ON s.id = c.source_id
WHERE s.status IN ('ready','partial')
  AND ($2::uuid IS NULL OR s.project_id = $2)
ORDER BY c.embedding <=> $1
LIMIT 50;
```

Saved views persist the full filter state to `saved_views.filters` (JSONB) for one-click recall.

**RAG ask-your-research:** the same retrieval feeds an optional "ask" box — retrieve top-k chunks → LLM answers with inline citations that link straight back to sources/timestamps (reusing the traceability chain).

---

## 7. File Storage Strategy

- **Object store** (S3/R2) holds originals + derived media (e.g., extracted audio, page thumbnails). Postgres holds only keys + metadata.
- **Key layout:**
  `projects/{projectId}/sources/{sourceId}/original/{canonical_name}`
  `projects/{projectId}/sources/{sourceId}/derived/{kind}/{file}`
- **Uploads** use presigned PUT URLs — the browser uploads directly to storage; the app never proxies bytes. Batch uploads request a batch of presigned URLs.
- **Previews** use short-lived presigned GET URLs, so source files open in-app without making the bucket public.

### 7.1 Canonical naming

`[research-type]_[participant-or-source]_[date]_[topic].ext`

- Slugify each segment (lowercase, ASCII, hyphenated, stripped punctuation).
- Date normalized to `YYYY-MM-DD` (or `YYYY-MM` for survey waves).
- **Duplicate handling:** the `checksum_sha256` unique constraint catches byte-identical re-uploads (app surfaces "already imported, view existing"). Name collisions with different content get a ` -2`, ` -3` suffix. The original filename is always retained in `original_name`.

---

## 8. Suggested Folder Structure

```
research-repo/
├─ apps/
│  └─ web/                        # Next.js app (UI + API routes)
│     ├─ app/
│     │  ├─ (repo)/repository/
│     │  ├─ (repo)/insights/
│     │  ├─ (repo)/flow/
│     │  ├─ (repo)/sources/[id]/
│     │  ├─ (repo)/timeline/
│     │  ├─ tags/
│     │  └─ api/
│     │     ├─ upload/presign/route.ts
│     │     ├─ trpc/[trpc]/route.ts
│     │     └─ webhooks/transcription/route.ts
│     ├─ components/              # reusable, brand-token-driven UI
│     ├─ lib/                     # client helpers, hooks
│     └─ styles/tokens.css        # brand CSS variables
├─ packages/
│  ├─ db/                         # Prisma schema, migrations, seed
│  ├─ core/                       # domain types, Zod schemas, shared logic
│  ├─ ai/                         # AIProvider adapters (openai/anthropic/local)
│  ├─ pipeline/                   # stage implementations (ingest…cluster)
│  └─ config/                     # env loading + validation (zod)
├─ workers/
│  └─ src/
│     ├─ queues.ts                # BullMQ queue + worker registration
│     ├─ processors/              # one file per stage
│     └─ index.ts                 # worker entrypoint
├─ infra/
│  ├─ docker-compose.yml          # postgres+pgvector, redis, minio, app, worker
│  └─ Dockerfile.{web,worker}
├─ .env.example
├─ turbo.json                     # monorepo task pipeline
└─ ARCHITECTURE.md
```

Monorepo (Turborepo + pnpm) keeps `core`, `ai`, and `pipeline` shared between the web app and workers with one type system — directly serving your maintainability/DX constraints.

---

## 9. Frontend Information Architecture

Brand-aligned (Copernicus display, Geist body, DK Formosa accents; navy/blue/cream base with lilac/orange/pink/sky accents). Views map 1:1 to your spec:

| View | Purpose | Key components |
|---|---|---|
| **Repository** | Default landing. Filterable table/grid of all sources. | Filter rail, data table, status pills, command-K search |
| **Insight board** | Clustered insights as cards, grouped by kind/stage. | Insight cards, cluster columns, severity/frequency chips |
| **Flow map** | The user-flow taxonomy; click a stage to see its feedback. | Flow stage nodes, per-stage counts, tag management entry |
| **Source detail** | One artifact: media player/preview + transcript + extracted insights, each linking to its exact moment. | Synced transcript, timeline scrubber, evidence list |
| **Timeline / activity** | Chronological feed of ingests & extractions. | Activity rows, date grouping |
| **Tag management** | Edit taxonomy, merge tags, adjust stage descriptions. | Editable tree, merge dialog |

Cross-cutting: a persistent **Command-K** palette (search + navigation), keyboard shortcuts throughout, left nav, and a global filter state that powers saved views. Information hierarchy follows Linear/Dovetail conventions — dense but calm, generous whitespace on the cream surface, color used sparingly for status and emphasis.

See `wireframes.html` for the rendered, brand-styled mockups.

---

## 10. Deployment Strategy

- **Local dev:** `docker compose up` brings up Postgres+pgvector, Redis, MinIO (S3-compatible), the web app, and a worker. `.env` from `.env.example`. One command to a working stack.
- **Staging/prod options:**
  - *Simplest:* Vercel (web) + managed Postgres with pgvector (Neon/Supabase/RDS) + Upstash Redis + R2/S3 + a worker on Fly.io/Railway/a small VM.
  - *Single-VM:* the same `docker-compose` on one box behind a reverse proxy — fine to start, scales vertically.
- **Migrations:** Prisma migrate on deploy; vector index creation in a follow-up migration (HNSW build is heavy — do it once, off the hot path).
- **Scaling levers:** workers scale horizontally (add processes/containers); Postgres scales vertically then via read replicas for search; queues smooth bursts.

### 10.1 Environment variables

```
# Core
DATABASE_URL=postgres://...
REDIS_URL=redis://...
APP_URL=http://localhost:3000

# Object storage (S3/R2/MinIO)
S3_ENDPOINT=...
S3_BUCKET=research-repo
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_REGION=auto

# AI providers (hybrid — set per capability)
EMBED_PROVIDER=openai            # openai | voyage | local
LLM_PROVIDER=anthropic           # anthropic | openai | local
TRANSCRIBE_PROVIDER=deepgram     # deepgram | openai | local
OCR_PROVIDER=tesseract           # tesseract | google | textract
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
DEEPGRAM_API_KEY=...
EMBED_DIM=3072                   # must match the chosen model + schema

# Tuning
CLASSIFY_THRESHOLD=0.30
CHUNK_TOKENS=400
CHUNK_OVERLAP=60
```

---

## 11. Scalable Ingestion Workflow

1. User drops files (single or batch) → client requests N presigned URLs from `/api/upload/presign`.
2. Browser uploads directly to object storage in parallel.
3. On each completed upload, client calls `sources.create` (tRPC) with key + metadata → row written `pending`, ingest job enqueued.
4. Worker pool drains the queue; UI reflects per-source status live.
5. Backpressure: queue concurrency + provider rate-limits in BullMQ prevent overrunning transcription/LLM quotas. Large media is processed at lower concurrency than text.

This keeps ingestion responsive at 10 files or 10,000 — the request path is always O(1) per file; the heavy work is queued and elastic.

---

## 12. Example APIs

tRPC routers (typed end-to-end). Illustrative signatures:

```ts
// upload
POST /api/upload/presign          // { files: [{name, size, mime}] } -> [{ url, key }]

// sources
sources.create({ key, originalName, mime, size, projectId?, participant?, recordedAt? })
sources.list({ filters, cursor, limit })          // paginated, filtered
sources.get({ id })                               // full detail + chunks + insights
sources.retryStage({ id, stage })
sources.updateTags({ id, stageIds, origin:'override' })

// search
search.query({ q, filters, mode:'hybrid' })       // -> grouped sources + chunk hits
search.ask({ q, projectId })                       // RAG answer + citations

// insights
insights.list({ filters })
insights.get({ id })                               // + evidence (chunk + quote + source)
insights.merge({ ids })                            // manual cluster merge

// taxonomy
flow.listStages()
flow.upsertStage({ id?, name, description, parentId? })  // re-embeds on save
flow.importFromFigjam({ payload })                 // parse export -> stages

// views
views.save({ name, filters })
views.list()
```

REST endpoints exist only for: presigned uploads, provider webhooks (async transcription callbacks), and health checks.

---

## 13. UI Wireframes

Delivered as a separate, brand-styled, clickable HTML file (`wireframes.html`) covering Repository, Source detail, Insight board, and Flow map. It uses your exact palette and type roles so you can react to the real look, not gray boxes.

---

## 14. Background Worker Architecture

- **BullMQ queues**, one per stage class (`extract`, `embed`, `classify`, `insight`, `cluster`) so each can have independent concurrency and rate limits.
- **Orchestration:** a parent `pipeline` job enqueues child stage jobs in sequence using BullMQ Flows (parent waits on children), so a source advances stage→stage with clean dependency tracking.
- **Concurrency profile:** text stages high concurrency; transcription/LLM gated to provider limits; clustering runs as a scheduled repeatable job (e.g., every 15 min) per active project rather than per source.
- **Observability:** Bull Board dashboard in dev; `processing_jobs` table for permanent, queryable history and the per-source retry UI.
- **Idempotent processors** (delete-then-write per stage) make retries safe.

```ts
// workers/src/queues.ts (shape)
export const queues = {
  extract:  new Queue('extract',  { connection }),
  embed:    new Queue('embed',    { connection }),
  classify: new Queue('classify', { connection }),
  insight:  new Queue('insight',  { connection }),
  cluster:  new Queue('cluster',  { connection }),
};
// each Worker: concurrency + limiter set per provider
new Worker('embed', embedProcessor, { connection, concurrency: 8 });
new Worker('insight', insightProcessor, {
  connection, concurrency: 2,
  limiter: { max: 60, duration: 60_000 },   // 60 LLM calls/min
});
```

---

## 15. Security & Privacy

- **Access:** auth on every route (NextAuth/Auth.js or your IdP). Object store stays private; all file access via short-lived presigned URLs scoped to the requesting user.
- **PII:** research data is sensitive. Store participant identifiers in a dedicated column you can pseudonymize; offer a "redact PII" pipeline stage (LLM/regex) that writes a redacted `content` variant for search while keeping the original access-controlled.
- **Data residency:** the provider adapter lets you force self-hosted transcription/LLM/embeddings when data can't leave your environment — no architectural change, just env.
- **Encryption:** TLS in transit; bucket + DB encryption at rest (standard on managed providers).
- **Secrets:** never in the repo; `.env` locally, secret manager in prod. `packages/config` validates required vars at boot and fails fast.
- **Audit:** `processing_jobs` + an append-only activity log give you who/what/when for ingestion and edits.
- **Deletion:** deleting a source cascades to chunks/insights/evidence and triggers an object-store delete job — true erasure for compliance requests.

---

## Appendix A — FigJam import

Two supported paths:
1. **Structured export:** export the FigJam board to JSON/CSV (node text + connections). `flow.importFromFigjam` parses node labels into `flow_stages`, infers nesting/order from connectors, then embeds each stage.
2. **Manual seed:** start from the listed stages (Onboarding, Sign-up, Search, Checkout, Collaboration, Settings, Notifications) and refine descriptions in the Tag management view. Re-import later to sync — `source_ref` lets us match existing stages to FigJam nodes without duplicating.

> I can't read the FigJam file directly. Send a PNG/PDF for visual reference or, better, a JSON/CSV export for automatic taxonomy import.

## Appendix B — Suggested build sequence

1. **Foundation:** monorepo, Prisma schema + migrations, Docker compose, brand tokens, app shell + nav.
2. **Ingestion E2E (text only):** presigned upload → source row → normalize → chunk → embed → repository view. Proves the spine end-to-end cheaply.
3. **Search:** hybrid search + filters + saved views.
4. **Classification:** seed taxonomy → two-pass tagging → flow map view.
5. **Insights:** extraction → evidence links → insight board → source detail traceability.
6. **Media:** transcription + OCR + timestamped previews.
7. **Clustering + RAG ask:** dedupe insights, ask-your-research.
8. **Hardening:** auth, PII redaction, deletion, observability.

Each step is shippable on its own — nothing here requires a big-bang launch.
