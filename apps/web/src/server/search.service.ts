import { prisma, keywordLeg, semanticLeg, filterOnly, type ChunkRow } from "@research-repo/db";
import { getEmbedProvider } from "@research-repo/ai";
import { reciprocalRankFusion, type SearchQuery } from "@research-repo/core";

export interface SearchHitSnippet {
  chunkId: string;
  text: string;
  startMs: number | null;
  endMs: number | null;
  page: number | null;
  responseRef: string | null;
}

export interface SearchResultSource {
  id: string;
  sourceType: string;
  status: string;
  originalName: string;
  canonicalName: string | null;
  driveFileId: string | null;
  participant: string | null;
  topic: string | null;
  sentiment: string | null;
  recordedAt: Date | null;
  createdAt: Date;
  score: number;
  meeting: { id: string; title: string | null } | null;
  flowStages: { id: string; name: string }[];
  snippets: SearchHitSnippet[]; // best matching chunks (for preview + traceability)
}

export interface SearchResponse {
  mode: string;
  total: number;
  sources: SearchResultSource[];
}

const SNIPPETS_PER_SOURCE = 3;

export async function search(query: SearchQuery): Promise<SearchResponse> {
  const { q, filters, mode, limit } = query;

  // Empty query → pure filter listing (repository default view).
  if (!q.trim()) {
    const rows = await filterOnly(filters, limit);
    const sources = await hydrate(rows.map((r) => r.source_id), new Map(), {});
    return { mode: "filter", total: sources.length, sources };
  }

  // Run the requested legs.
  const legs: { id: string }[][] = [];
  let keyword: ChunkRow[] = [];
  let semantic: ChunkRow[] = [];

  if (mode === "keyword" || mode === "hybrid") {
    keyword = await keywordLeg(q, filters);
    legs.push(keyword.map((r) => ({ id: r.chunk_id })));
  }
  if (mode === "semantic" || mode === "hybrid") {
    const [vec] = await getEmbedProvider().embed([q]);
    semantic = await semanticLeg(vec, filters);
    legs.push(semantic.map((r) => ({ id: r.chunk_id })));
  }

  // Fuse chunk rankings with RRF.
  const fused = reciprocalRankFusion(legs);

  // Index chunk metadata for snippet building.
  const chunkMeta = new Map<string, ChunkRow>();
  for (const r of [...keyword, ...semantic]) chunkMeta.set(r.chunk_id, r);

  // Aggregate chunk scores to sources: source score = best chunk RRF score;
  // keep the top-N chunks per source as snippets.
  const bySource = new Map<string, { score: number; chunkIds: string[] }>();
  for (const [chunkId, score] of fused) {
    const meta = chunkMeta.get(chunkId);
    if (!meta) continue;
    const entry = bySource.get(meta.source_id) ?? { score: 0, chunkIds: [] };
    entry.score = Math.max(entry.score, score);
    entry.chunkIds.push(chunkId);
    bySource.set(meta.source_id, entry);
  }

  // Rank sources by fused score, take top `limit`.
  const ranked = [...bySource.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit);

  const scoreMap = new Map(ranked.map(([sid, v]) => [sid, v.score]));
  const snippetMap: Record<string, string[]> = {};
  for (const [sid, v] of ranked) {
    // best snippets = chunks with highest fused score for this source
    snippetMap[sid] = v.chunkIds
      .sort((a, b) => (fused.get(b) ?? 0) - (fused.get(a) ?? 0))
      .slice(0, SNIPPETS_PER_SOURCE);
  }

  const sources = await hydrate(ranked.map(([sid]) => sid), scoreMap, snippetMap);
  return { mode, total: sources.length, sources };
}

/** Load source rows + flow stages + snippet chunks, preserving rank order. */
async function hydrate(
  sourceIds: string[],
  scores: Map<string, number>,
  snippetIds: Record<string, string[]>,
): Promise<SearchResultSource[]> {
  if (sourceIds.length === 0) return [];

  const allSnippetIds = Object.values(snippetIds).flat();
  const [sources, snippetChunks] = await Promise.all([
    prisma.source.findMany({
      where: { id: { in: sourceIds } },
      select: {
        id: true, sourceType: true, status: true, originalName: true,
        canonicalName: true, driveFileId: true, participant: true, topic: true, sentiment: true,
        recordedAt: true, createdAt: true,
        meeting: { select: { id: true, title: true } },
        flowTags: { select: { stage: { select: { id: true, name: true } } } },
      },
    }),
    allSnippetIds.length
      ? prisma.chunk.findMany({
          where: { id: { in: allSnippetIds } },
          select: { id: true, text: true, startMs: true, endMs: true, page: true, responseRef: true },
        })
      : Promise.resolve([]),
  ]);

  const chunkById = new Map(snippetChunks.map((c) => [c.id, c]));
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  // Preserve the incoming rank order.
  return sourceIds
    .map((id): SearchResultSource | null => {
      const s = sourceById.get(id);
      if (!s) return null;
      const snippets = (snippetIds[id] ?? [])
        .map((cid) => chunkById.get(cid))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => ({
          chunkId: c.id, text: c.text, startMs: c.startMs,
          endMs: c.endMs, page: c.page, responseRef: c.responseRef,
        }));
      return {
        id: s.id,
        sourceType: s.sourceType,
        status: s.status,
        originalName: s.originalName,
        canonicalName: s.canonicalName,
        driveFileId: s.driveFileId,
        participant: s.participant,
        topic: s.topic,
        sentiment: s.sentiment,
        recordedAt: s.recordedAt,
        createdAt: s.createdAt,
        score: scores.get(id) ?? 0,
        meeting: s.meeting ? { id: s.meeting.id, title: s.meeting.title } : null,
        flowStages: s.flowTags.map((t) => ({ id: t.stage.id, name: t.stage.name })),
        snippets,
      };
    })
    .filter((x): x is SearchResultSource => x !== null);
}
