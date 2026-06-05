import { Prisma } from "@prisma/client";
import { prisma } from "./client";
import { EMBED_DIM, toVectorLiteral } from "./vector";

// Hybrid search. Both legs run over `chunks` with the SAME filter predicate,
// so keyword and semantic results are directly fusable. We over-fetch per leg
// (FETCH_PER_LEG), fuse with RRF in the app layer, then group to sources.

const FETCH_PER_LEG = 100;

export interface SearchFiltersSql {
  projectId?: string;
  flowStageIds?: string[];
  tagIds?: string[];
  sentiment?: string;
  sourceType?: string;
  participant?: string;
  dateFrom?: Date;
  dateTo?: Date;
  statuses: string[];
}

export interface ChunkRow {
  chunk_id: string;
  source_id: string;
  text: string;
  rank: number; // leg-local score (ts_rank or cosine sim)
}

// Build the shared filter predicate as a Prisma.Sql fragment. Joins to sources
// (always) and conditionally to tag tables. Returns the WHERE fragment plus any
// JOINs needed.
function filterSql(f: SearchFiltersSql): { joins: Prisma.Sql; where: Prisma.Sql } {
  const conds: Prisma.Sql[] = [
    Prisma.sql`s.status = ANY(${f.statuses}::"ProcessingStatus"[])`,
  ];
  if (f.projectId) conds.push(Prisma.sql`s.project_id = ${f.projectId}::uuid`);
  if (f.sentiment) conds.push(Prisma.sql`s.sentiment = ${f.sentiment}`);
  if (f.sourceType) conds.push(Prisma.sql`s.source_type = ${f.sourceType}::"SourceType"`);
  if (f.participant) conds.push(Prisma.sql`s.participant ILIKE ${"%" + f.participant + "%"}`);
  if (f.dateFrom) conds.push(Prisma.sql`COALESCE(s.recorded_at, s.created_at) >= ${f.dateFrom}`);
  if (f.dateTo) conds.push(Prisma.sql`COALESCE(s.recorded_at, s.created_at) <= ${f.dateTo}`);

  // Flow-stage filter: source must be tagged with ANY of the given stages.
  if (f.flowStageIds?.length) {
    conds.push(Prisma.sql`EXISTS (
      SELECT 1 FROM source_flow_tags sft
      WHERE sft.source_id = s.id AND sft.stage_id = ANY(${f.flowStageIds}::uuid[])
    )`);
  }
  // Tag filter: source must carry ANY of the given free-form tags.
  if (f.tagIds?.length) {
    conds.push(Prisma.sql`EXISTS (
      SELECT 1 FROM source_tags st
      WHERE st.source_id = s.id AND st.tag_id = ANY(${f.tagIds}::uuid[])
    )`);
  }

  const where = Prisma.sql`${Prisma.join(conds, " AND ")}`;
  const joins = Prisma.sql`JOIN sources s ON s.id = c.source_id`;
  return { joins, where };
}

/** Keyword leg: full-text rank over chunks.text_tsv, filtered. */
export async function keywordLeg(
  q: string,
  f: SearchFiltersSql,
): Promise<ChunkRow[]> {
  if (!q.trim()) return [];
  const { joins, where } = filterSql(f);
  // websearch_to_tsquery handles user-style queries ("a b" OR -c) safely.
  return prisma.$queryRaw<ChunkRow[]>(Prisma.sql`
    SELECT c.id AS chunk_id, c.source_id, c.text,
           ts_rank(c.text_tsv, websearch_to_tsquery('english', ${q})) AS rank
    FROM chunks c
    ${joins}
    WHERE ${where}
      AND c.text_tsv @@ websearch_to_tsquery('english', ${q})
    ORDER BY rank DESC
    LIMIT ${FETCH_PER_LEG}
  `);
}

/** Semantic leg: halfvec ANN over chunk embeddings, filtered. */
export async function semanticLeg(
  queryVec: number[],
  f: SearchFiltersSql,
): Promise<ChunkRow[]> {
  const { joins, where } = filterSql(f);
  const lit = toVectorLiteral(queryVec);
  const dim = Prisma.raw(String(EMBED_DIM));
  return prisma.$queryRaw<ChunkRow[]>(Prisma.sql`
    SELECT c.id AS chunk_id, c.source_id, c.text,
           1 - (c.embedding::halfvec(${dim}) <=> ${lit}::halfvec(${dim})) AS rank
    FROM chunks c
    ${joins}
    WHERE ${where}
      AND c.embedding IS NOT NULL
    ORDER BY c.embedding::halfvec(${dim}) <=> ${lit}::halfvec(${dim})
    LIMIT ${FETCH_PER_LEG}
  `);
}

/** Filter-only listing (empty query): newest sources matching the filters. */
export async function filterOnly(
  f: SearchFiltersSql,
  limit: number,
): Promise<{ source_id: string }[]> {
  const conds: Prisma.Sql[] = [
    Prisma.sql`s.status = ANY(${f.statuses}::"ProcessingStatus"[])`,
  ];
  if (f.projectId) conds.push(Prisma.sql`s.project_id = ${f.projectId}::uuid`);
  if (f.sentiment) conds.push(Prisma.sql`s.sentiment = ${f.sentiment}`);
  if (f.sourceType) conds.push(Prisma.sql`s.source_type = ${f.sourceType}::"SourceType"`);
  if (f.participant) conds.push(Prisma.sql`s.participant ILIKE ${"%" + f.participant + "%"}`);
  if (f.dateFrom) conds.push(Prisma.sql`COALESCE(s.recorded_at, s.created_at) >= ${f.dateFrom}`);
  if (f.dateTo) conds.push(Prisma.sql`COALESCE(s.recorded_at, s.created_at) <= ${f.dateTo}`);
  if (f.flowStageIds?.length) {
    conds.push(Prisma.sql`EXISTS (SELECT 1 FROM source_flow_tags sft WHERE sft.source_id = s.id AND sft.stage_id = ANY(${f.flowStageIds}::uuid[]))`);
  }
  if (f.tagIds?.length) {
    conds.push(Prisma.sql`EXISTS (SELECT 1 FROM source_tags st WHERE st.source_id = s.id AND st.tag_id = ANY(${f.tagIds}::uuid[]))`);
  }
  return prisma.$queryRaw<{ source_id: string }[]>(Prisma.sql`
    SELECT s.id AS source_id FROM sources s
    WHERE ${Prisma.join(conds, " AND ")}
    ORDER BY COALESCE(s.recorded_at, s.created_at) DESC
    LIMIT ${limit}
  `);
}
