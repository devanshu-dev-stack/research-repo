-- Full-text search for the keyword leg of hybrid search.
-- A generated tsvector column stays in sync with chunks.text automatically;
-- the GIN index makes keyword ranking fast. We search chunks (not sources) so
-- keyword and vector legs operate on the same units, then fuse + group.

ALTER TABLE "chunks"
  ADD COLUMN "text_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("text", ''))) STORED;

CREATE INDEX "chunks_text_tsv_idx" ON "chunks" USING gin ("text_tsv");

-- Trigram index on chunk text too, for fuzzy / partial-token matches that FTS
-- misses (e.g. typos, substrings). Used as a fallback ranking signal.
CREATE INDEX "chunks_text_trgm_idx" ON "chunks" USING gin ("text" gin_trgm_ops);
