# @research-repo/db

Prisma 7 + PostgreSQL 16 + pgvector data layer for the Research Repository.
Contains the schema, migrations, vector helpers, and the Collage AI flow-taxonomy seed.

## Layout

```
packages/db/
├─ prisma/
│  ├─ schema.prisma                 # 12 models, 5 enums, vector columns
│  ├─ taxonomy.ts                   # Student + Faculty stages (from FigJam)
│  ├─ seed.ts                       # inserts project + taxonomy (+ embeddings)
│  └─ migrations/
│     ├─ 00000000000000_init/                # tables, FKs, trigram + b-tree indexes
│     └─ 00000000000001_pgvector_indexes/    # HNSW (halfvec) ANN indexes
├─ prisma.config.ts                 # Prisma 7 datasource URL lives here
├─ src/
│  ├─ client.ts                     # PrismaClient singleton (pg driver adapter)
│  ├─ vector.ts                     # setEmbedding + halfvec ANN search helpers
│  └─ index.ts
└─ .env.example
```

## Setup

```bash
cp .env.example .env          # set DATABASE_URL (and OPENAI_API_KEY to embed at seed time)
pnpm install
pnpm generate                 # prisma generate
pnpm migrate:deploy           # applies both migrations (tables, then HNSW indexes)
pnpm seed                     # project + ~32 flow stages
```

Requires Postgres 16 with the `vector` (>= 0.7.0), `pg_trgm`, and `uuid-ossp`
extensions available. The Docker compose in `infra/` provides this.

## Embedding dimension & the halfvec decision

`text-embedding-3-large` outputs **3072** dims. pgvector's `vector` type only
supports HNSW indexes up to **2000** dims (an 8 KB index-page limit), so the
ANN indexes use the **halfvec** type, which goes to 4000 dims at half the bytes
(pgvector >= 0.7.0). The schema stores `vector(3072)`; the indexes cast to
`halfvec(3072)`.

**Critical:** queries must cast *both sides* to `halfvec` with `halfvec_cosine_ops`
or Postgres silently falls back to a sequential scan. `src/vector.ts` does this
correctly — use those helpers rather than hand-rolling vector SQL.

If you'd rather avoid halfvec entirely, pin `EMBED_DIM<=2000` (e.g. request 1536
dims from OpenAI via the `dimensions` param), change `vector(3072)` → `vector(1536)`
in `schema.prisma` and the init migration, and switch the index op-class back to
plain `vector_cosine_ops`.

## Vectors and Prisma

Prisma has no native vector type, so embedding columns are
`Unsupported("vector(3072)")` — readable in the schema, but not writable through
the typed client. Write them with `setEmbedding()` and query them with
`searchChunksByVector()` / `matchFlowStages()` (raw SQL under the hood).

## Validation status

- `schema.prisma` validates against the Prisma 7.8 schema engine (12 models, 5 enums, DMMF builds).
- Both migration SQL files parse as PostgreSQL.
- `src/*.ts` and `prisma/*.ts` typecheck clean under `strict`.
- A live `migrate deploy` + `seed` round-trip should be run once against your
  Postgres+pgvector instance (couldn't be executed in the authoring sandbox —
  no Postgres available there).
