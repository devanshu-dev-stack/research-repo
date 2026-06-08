-- pgvector ANN indexes — kept in a separate migration because HNSW index
-- builds are expensive; run once, off the hot path. Cosine ops match the
-- normalized embeddings produced by the AI provider layer.
--
-- NOTE on dimension limits: pgvector's hnsw/ivfflat indexes support up to
-- 2000 dimensions. text-embedding-3-large is 3072 — over that ceiling.
-- Two supported options:
--   (A) Use OpenAI's `dimensions` param to request 1536 or 1024 (recommended;
--       set EMBED_DIM accordingly and change vector(3072) -> vector(1536) in
--       the init migration + schema), then the indexes below apply directly.
--   (B) Keep 3072 and index a halfvec cast (pgvector >= 0.7), shown below.
--
-- Option B is written here so the repo works at 3072 out of the box. If you
-- pin EMBED_DIM<=2000, replace the halfvec expression indexes with plain
-- `USING hnsw (embedding vector_cosine_ops)`.

-- chunks: primary retrieval surface for RAG + search
CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks"
  USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);

-- insights: clustering + dedupe
CREATE INDEX "insights_embedding_hnsw_idx" ON "insights"
  USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);

-- flow_stages: small table; an index is optional. Sequential scan over a few
-- dozen stage embeddings is fine, so we skip an ANN index here.

-- ⚠️ CRITICAL query-side requirement: to actually USE these halfvec indexes,
-- the query must cast the column to halfvec with the SAME op-class, e.g.:
--   ORDER BY embedding::halfvec(3072) <=> $1::halfvec(3072) LIMIT 50;
-- Casting only the column (embedding::halfvec) or comparing against ::vector
-- silently falls back to a sequential scan. See src/vector.ts for the helper
-- that builds correct halfvec queries.
