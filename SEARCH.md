# Search Layer — Hybrid (keyword + vector) with RRF

Turns everything the pipeline wrote (chunks, embeddings, flow tags, sentiment,
insights) into the repository search experience from the blueprint.

## How it works

```
query "checkout error"  +  filters
        │
        ├─ keyword leg     FTS over chunks.text_tsv (websearch_to_tsquery)   ── ranked chunk list
        │                  + filters applied in the same WHERE
        ├─ semantic leg    embed(query) → halfvec ANN over chunk embeddings  ── ranked chunk list
        │                  + same filters
        ▼
   RRF fusion             score(chunk) = Σ 1/(k + rank)  across legs   (k=60)
        ▼
   group to sources       source score = best chunk score; keep top-3 chunks as snippets
        ▼
   hydrate                source rows + flow stages + snippet chunks (with ms/page/response_ref)
```

Both legs run over **chunks** (not sources) so they're directly fusable, and
both apply the **same filter predicate** so fusion is apples-to-apples. Results
group to sources, but snippets retain chunk-level traceability (timestamp / page
/ survey row) — clicking a result can jump to the exact moment.

### Why RRF (not score averaging)

Keyword scores (`ts_rank`) and cosine similarities live on different scales;
averaging them is meaningless. Reciprocal Rank Fusion uses only *rank position*,
so the two legs combine fairly and agreement across legs is rewarded. `k=60` is
the standard default.

## Modes

`hybrid` (default, both legs) · `keyword` (FTS only) · `semantic` (vector only).
Empty query → pure **filter listing** (the repository default view), newest first.

## Filter set (blueprint)

flow stage (any-of) · feature-area tag (any-of) · sentiment · research type ·
participant (ILIKE) · date range (on recorded_at, falling back to created_at) ·
project · status (defaults to ready+partial). All optional, all combinable, all
folded into the SQL `WHERE` of both legs so they constrain ranking, not just
post-filter.

## API (tRPC `search` router)

- `search.query({ q, filters, mode, limit })` → ranked sources + snippets
- `search.facets({ projectId })` → counts per source-type / sentiment / flow stage (for the filter rail)
- `search.saveView` / `search.listViews` / `search.deleteView` → saved views (persist full filter+query state)

## Schema addition

Migration `00000000000002_fts_search` adds:
- `chunks.text_tsv` — a **generated** `tsvector` column (auto-syncs with `text`)
  with a GIN index → the keyword leg.
- a trigram GIN index on `chunks.text` → fuzzy / partial-token fallback.

No backfill needed: the generated column populates for existing rows on
migration and stays current on every write.

## Provider note

The semantic leg embeds the query via the same `EMBED_PROVIDER` as ingestion —
so query and document embeddings share a space. With the local stub it still
runs end-to-end (loose relevance); set `EMBED_PROVIDER=openai` for real quality.

## Verification status

- `packages/core`: typechecks clean; RRF tested (agreement wins, order
  preserved, weights honored).
- `packages/db` search module: typechecks clean (all `Prisma.sql` composition).
- `apps/web` search.service + search router: typecheck clean against typed
  Prisma/tRPC contracts; FTS migration SQL parses as Postgres.
- Not run here (no Postgres): a live query round-trip. Run against `infra/`
  after applying the FTS migration.
