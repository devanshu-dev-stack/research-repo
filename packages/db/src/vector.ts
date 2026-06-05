import { Prisma } from "@prisma/client";
import { prisma } from "./client";

// Embedding dimension — MUST match the model and the schema's vector(N).
// If you pin EMBED_DIM <= 2000 you can drop the ::halfvec casts below and use
// plain vector_cosine_ops indexes instead.
export const EMBED_DIM = Number(process.env.EMBED_DIM ?? 3072);

/** Format a JS number[] as a pgvector literal: '[0.1,0.2,...]'. */
export function toVectorLiteral(vec: number[]): string {
  if (vec.length !== EMBED_DIM) {
    throw new Error(`Embedding length ${vec.length} != EMBED_DIM ${EMBED_DIM}`);
  }
  return `[${vec.join(",")}]`;
}

/**
 * Write an embedding onto a row. Prisma can't set Unsupported("vector")
 * columns, so we use a parameterized raw UPDATE. `table` is whitelisted.
 */
export async function setEmbedding(
  table: "chunks" | "insights" | "flow_stages",
  id: string,
  vec: number[],
): Promise<void> {
  const lit = toVectorLiteral(vec);
  // Table name is whitelisted above; id + vector are parameterized.
  await prisma.$executeRawUnsafe(
    `UPDATE "${table}" SET embedding = $1::vector WHERE id = $2::uuid`,
    lit,
    id,
  );
}

export interface ChunkHit {
  id: string;
  source_id: string;
  text: string;
  score: number; // cosine similarity 0..1
}

/**
 * Semantic ANN search over chunks. Casts to halfvec on BOTH sides so the
 * halfvec HNSW index is actually used (see migration warning). Optional
 * project filter folded in.
 */
export async function searchChunksByVector(
  queryVec: number[],
  opts: { projectId?: string; limit?: number } = {},
): Promise<ChunkHit[]> {
  const lit = toVectorLiteral(queryVec);
  const limit = opts.limit ?? 50;

  return prisma.$queryRaw<ChunkHit[]>(Prisma.sql`
    SELECT c.id, c.source_id, c.text,
           1 - (c.embedding::halfvec(${Prisma.raw(String(EMBED_DIM))})
                <=> ${lit}::halfvec(${Prisma.raw(String(EMBED_DIM))})) AS score
    FROM chunks c
    JOIN sources s ON s.id = c.source_id
    WHERE s.status IN ('ready','partial')
      AND (${opts.projectId ?? null}::uuid IS NULL OR s.project_id = ${opts.projectId ?? null}::uuid)
    ORDER BY c.embedding::halfvec(${Prisma.raw(String(EMBED_DIM))})
             <=> ${lit}::halfvec(${Prisma.raw(String(EMBED_DIM))})
    LIMIT ${limit}
  `);
}

/** Match a chunk/source embedding against flow-stage embeddings (Pass A of the
 *  two-pass classifier). Small table → plain sequential cosine is fine. */
export interface StageMatch {
  id: string;
  name: string;
  slug: string;
  persona: string;
  score: number;
}
export async function matchFlowStages(
  vec: number[],
  threshold = Number(process.env.CLASSIFY_THRESHOLD ?? 0.3),
): Promise<StageMatch[]> {
  const lit = toVectorLiteral(vec);
  return prisma.$queryRaw<StageMatch[]>(Prisma.sql`
    SELECT id, name, slug, persona::text AS persona,
           1 - (embedding <=> ${lit}::vector) AS score
    FROM flow_stages
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> ${lit}::vector) >= ${threshold}
    ORDER BY score DESC
  `);
}

/** Read a stored embedding back as number[] (Prisma can't select vector cols). */
export async function getEmbedding(
  table: "chunks" | "insights" | "flow_stages",
  id: string,
): Promise<number[] | null> {
  const rows = await prisma.$queryRawUnsafe<{ embedding: string | null }[]>(
    `SELECT embedding::text AS embedding FROM "${table}" WHERE id = $1::uuid`,
    id,
  );
  const raw = rows[0]?.embedding;
  if (!raw) return null;
  // pgvector text form: "[0.1,0.2,...]"
  return raw.slice(1, -1).split(",").map(Number);
}

/** Insight semantic dedupe: nearest existing insights to a vector, same kind. */
export interface InsightNeighbor {
  id: string;
  title: string;
  score: number;
}
export async function nearestInsights(
  vec: number[],
  kind: string,
  opts: { projectId?: string; limit?: number; minScore?: number } = {},
): Promise<InsightNeighbor[]> {
  const lit = toVectorLiteral(vec);
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 0;
  const dim = String(EMBED_DIM);
  return prisma.$queryRaw<InsightNeighbor[]>(Prisma.sql`
    SELECT id, title,
           1 - (embedding::halfvec(${Prisma.raw(dim)}) <=> ${lit}::halfvec(${Prisma.raw(dim)})) AS score
    FROM insights
    WHERE embedding IS NOT NULL
      AND kind = ${kind}::"InsightKind"
      AND (${opts.projectId ?? null}::uuid IS NULL OR project_id = ${opts.projectId ?? null}::uuid)
      AND 1 - (embedding::halfvec(${Prisma.raw(dim)}) <=> ${lit}::halfvec(${Prisma.raw(dim)})) >= ${minScore}
    ORDER BY embedding::halfvec(${Prisma.raw(dim)}) <=> ${lit}::halfvec(${Prisma.raw(dim)})
    LIMIT ${limit}
  `);
}
