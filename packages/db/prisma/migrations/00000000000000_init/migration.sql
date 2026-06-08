-- Init migration — extensions, enums, tables, indexes, FKs
-- Generated to match schema.prisma. Vector columns are created here as the
-- `vector` type; their ANN indexes live in the next migration (heavy build).

-- Extensions
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enums
CREATE TYPE "SourceType" AS ENUM ('survey','video','audio','transcript','note','pdf','doc','image','other');
CREATE TYPE "ProcessingStatus" AS ENUM ('pending','processing','ready','failed','partial');
CREATE TYPE "TagOrigin" AS ENUM ('auto','manual','override');
CREATE TYPE "InsightKind" AS ENUM ('pain_point','feature_request','ux_friction','positive','theme','job_to_be_done','goal');
CREATE TYPE "Persona" AS ENUM ('student','faculty','both');

-- projects
CREATE TABLE "projects" (
  "id"          UUID NOT NULL DEFAULT uuid_generate_v4(),
  "name"        TEXT NOT NULL,
  "slug"        TEXT NOT NULL,
  "description" TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- flow_stages
CREATE TABLE "flow_stages" (
  "id"          UUID NOT NULL DEFAULT uuid_generate_v4(),
  "parent_id"   UUID,
  "persona"     "Persona" NOT NULL DEFAULT 'both',
  "name"        TEXT NOT NULL,
  "slug"        TEXT NOT NULL,
  "description" TEXT,
  "position"    INTEGER NOT NULL DEFAULT 0,
  "source_ref"  TEXT,
  "embedding"   vector(3072),
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "flow_stages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "flow_stages_parent_id_slug_key" ON "flow_stages"("parent_id","slug");
CREATE INDEX "flow_stages_persona_idx" ON "flow_stages"("persona");

-- sources
CREATE TABLE "sources" (
  "id"              UUID NOT NULL DEFAULT uuid_generate_v4(),
  "project_id"      UUID,
  "source_type"     "SourceType" NOT NULL,
  "status"          "ProcessingStatus" NOT NULL DEFAULT 'pending',
  "original_name"   TEXT NOT NULL,
  "canonical_name"  TEXT,
  "storage_key"     TEXT NOT NULL,
  "mime_type"       TEXT,
  "byte_size"       BIGINT,
  "checksum_sha256" TEXT,
  "participant"     TEXT,
  "topic"           TEXT,
  "content"         TEXT,
  "transcript"      TEXT,
  "sentiment"       TEXT,
  "language"        TEXT,
  "recorded_at"     TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at"    TIMESTAMP(3),
  "metadata"        JSONB NOT NULL DEFAULT '{}',
  "error"           TEXT,
  CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sources_checksum_sha256_key" ON "sources"("checksum_sha256");
CREATE INDEX "sources_project_id_idx" ON "sources"("project_id");
CREATE INDEX "sources_status_idx" ON "sources"("status");
CREATE INDEX "sources_source_type_idx" ON "sources"("source_type");
CREATE INDEX "sources_recorded_at_idx" ON "sources"("recorded_at");
-- fuzzy keyword search over content
CREATE INDEX "sources_content_trgm_idx" ON "sources" USING gin ("content" gin_trgm_ops);

-- chunks
CREATE TABLE "chunks" (
  "id"           UUID NOT NULL DEFAULT uuid_generate_v4(),
  "source_id"    UUID NOT NULL,
  "ordinal"      INTEGER NOT NULL,
  "text"         TEXT NOT NULL,
  "embedding"    vector(3072),
  "start_ms"     INTEGER,
  "end_ms"       INTEGER,
  "page"         INTEGER,
  "bbox"         JSONB,
  "response_ref" TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chunks_source_id_idx" ON "chunks"("source_id");

-- source_flow_tags
CREATE TABLE "source_flow_tags" (
  "source_id"  UUID NOT NULL,
  "stage_id"   UUID NOT NULL,
  "confidence" DOUBLE PRECISION,
  "origin"     "TagOrigin" NOT NULL DEFAULT 'auto',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "source_flow_tags_pkey" PRIMARY KEY ("source_id","stage_id")
);
CREATE INDEX "source_flow_tags_stage_id_idx" ON "source_flow_tags"("stage_id");

-- tags
CREATE TABLE "tags" (
  "id"    UUID NOT NULL DEFAULT uuid_generate_v4(),
  "name"  TEXT NOT NULL,
  "color" TEXT,
  CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- source_tags
CREATE TABLE "source_tags" (
  "source_id" UUID NOT NULL,
  "tag_id"    UUID NOT NULL,
  CONSTRAINT "source_tags_pkey" PRIMARY KEY ("source_id","tag_id")
);

-- insights
CREATE TABLE "insights" (
  "id"         UUID NOT NULL DEFAULT uuid_generate_v4(),
  "project_id" UUID,
  "kind"       "InsightKind" NOT NULL,
  "title"      TEXT NOT NULL,
  "summary"    TEXT,
  "severity"   INTEGER,
  "frequency"  INTEGER NOT NULL DEFAULT 1,
  "cluster_id" UUID,
  "embedding"  vector(3072),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "insights_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "insights_kind_idx" ON "insights"("kind");
CREATE INDEX "insights_cluster_id_idx" ON "insights"("cluster_id");

-- insight_evidence
CREATE TABLE "insight_evidence" (
  "id"         UUID NOT NULL DEFAULT uuid_generate_v4(),
  "insight_id" UUID NOT NULL,
  "chunk_id"   UUID NOT NULL,
  "quote"      TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "insight_evidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "insight_evidence_insight_id_idx" ON "insight_evidence"("insight_id");
CREATE INDEX "insight_evidence_chunk_id_idx" ON "insight_evidence"("chunk_id");

-- insight_flow_tags
CREATE TABLE "insight_flow_tags" (
  "insight_id" UUID NOT NULL,
  "stage_id"   UUID NOT NULL,
  CONSTRAINT "insight_flow_tags_pkey" PRIMARY KEY ("insight_id","stage_id")
);

-- saved_views
CREATE TABLE "saved_views" (
  "id"         UUID NOT NULL DEFAULT uuid_generate_v4(),
  "name"       TEXT NOT NULL,
  "filters"    JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- processing_jobs
CREATE TABLE "processing_jobs" (
  "id"         UUID NOT NULL DEFAULT uuid_generate_v4(),
  "source_id"  UUID,
  "stage"      TEXT NOT NULL,
  "status"     TEXT NOT NULL,
  "attempts"   INTEGER NOT NULL DEFAULT 0,
  "error"      TEXT,
  "started_at" TIMESTAMP(3),
  "ended_at"   TIMESTAMP(3),
  CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "processing_jobs_source_id_idx" ON "processing_jobs"("source_id");

-- Foreign keys
ALTER TABLE "flow_stages"      ADD CONSTRAINT "flow_stages_parent_id_fkey"      FOREIGN KEY ("parent_id")  REFERENCES "flow_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sources"          ADD CONSTRAINT "sources_project_id_fkey"          FOREIGN KEY ("project_id") REFERENCES "projects"("id")    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chunks"           ADD CONSTRAINT "chunks_source_id_fkey"            FOREIGN KEY ("source_id")  REFERENCES "sources"("id")     ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_flow_tags" ADD CONSTRAINT "source_flow_tags_source_id_fkey"  FOREIGN KEY ("source_id")  REFERENCES "sources"("id")     ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_flow_tags" ADD CONSTRAINT "source_flow_tags_stage_id_fkey"   FOREIGN KEY ("stage_id")   REFERENCES "flow_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_tags"      ADD CONSTRAINT "source_tags_source_id_fkey"       FOREIGN KEY ("source_id")  REFERENCES "sources"("id")     ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_tags"      ADD CONSTRAINT "source_tags_tag_id_fkey"          FOREIGN KEY ("tag_id")     REFERENCES "tags"("id")        ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "insights"         ADD CONSTRAINT "insights_project_id_fkey"         FOREIGN KEY ("project_id") REFERENCES "projects"("id")    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "insight_evidence" ADD CONSTRAINT "insight_evidence_insight_id_fkey" FOREIGN KEY ("insight_id") REFERENCES "insights"("id")    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "insight_evidence" ADD CONSTRAINT "insight_evidence_chunk_id_fkey"   FOREIGN KEY ("chunk_id")   REFERENCES "chunks"("id")      ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "insight_flow_tags" ADD CONSTRAINT "insight_flow_tags_insight_id_fkey" FOREIGN KEY ("insight_id") REFERENCES "insights"("id")  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "insight_flow_tags" ADD CONSTRAINT "insight_flow_tags_stage_id_fkey"   FOREIGN KEY ("stage_id")   REFERENCES "flow_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "processing_jobs"  ADD CONSTRAINT "processing_jobs_source_id_fkey"   FOREIGN KEY ("source_id")  REFERENCES "sources"("id")     ON DELETE CASCADE ON UPDATE CASCADE;
