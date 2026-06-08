import {
  prisma,
  Prisma,
  setEmbedding,
  getEmbedding,
  nearestInsights,
} from "@research-repo/db";
import { getLLMProvider, getEmbedProvider } from "@research-repo/ai";
import { insightDraftSchema, type InsightDraft } from "@research-repo/core";

// A new insight whose embedding is this close to an existing same-kind insight
// is treated as the same insight: link new evidence, bump frequency, instead of
// creating a duplicate.
const DEDUPE_SCORE = Number(process.env.INSIGHT_DEDUPE_SCORE ?? 0.9);
// Chunks per LLM extraction request when the provider supports batching. Bigger
// = fewer requests (kinder to per-minute rate limits) at the cost of a larger
// single response. 8 is a safe default for gemini-2.5-flash's output budget.
const INSIGHT_BATCH = Number(process.env.INSIGHT_BATCH ?? 8);

/**
 * Stage: insight. For each chunk, the LLM extracts drafts (pain points,
 * feature requests, JTBD, …). Each draft is validated, embedded, deduped
 * against existing insights, and linked to its originating chunk via
 * insight_evidence — preserving the exact quote, and through the chunk its
 * timestamp / page / response_ref. That chain is the source-traceability spine.
 *
 * Idempotent: clears this source's previously-derived evidence (and any
 * insights left with no evidence) before re-extracting, so re-runs converge.
 */
export async function runInsight(sourceId: string): Promise<number> {
  const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
  const projectId = source.projectId ?? undefined;

  const chunks = await prisma.chunk.findMany({
    where: { sourceId },
    select: { id: true, text: true },
    orderBy: { ordinal: "asc" },
  });
  if (chunks.length === 0) return 0;

  const llm = getLLMProvider();
  const embedder = getEmbedProvider();

  // Idempotency: drop prior evidence sourced from this source's chunks.
  await clearPriorEvidence(sourceId);

  // 1) Extract drafts for all chunks. When the provider batches, each request
  //    covers INSIGHT_BATCH chunks; batches run concurrently (the provider's
  //    own rate limiter paces + retries them). Falls back to per-chunk calls.
  const batches: { id: string; text: string }[][] = [];
  for (let i = 0; i < chunks.length; i += INSIGHT_BATCH) {
    batches.push(chunks.slice(i, i + INSIGHT_BATCH));
  }
  const extracted = await Promise.all(
    batches.map(async (batch) => {
      try {
        if (llm.extractInsightsBatch) return await llm.extractInsightsBatch(batch);
        return await Promise.all(
          batch.map(async (c) => ({
            chunkId: c.id,
            drafts: await llm.extractInsights(c.text).catch(() => [] as InsightDraft[]),
          })),
        );
      } catch {
        return batch.map((c) => ({ chunkId: c.id, drafts: [] as InsightDraft[] }));
      }
    }),
  );

  // 2) Validate each draft independently; keep (chunkId, draft) pairs in chunk
  //    order. One malformed entry is dropped without losing the rest.
  const pairs: { chunkId: string; draft: InsightDraft }[] = [];
  for (const group of extracted.flat()) {
    for (const d of Array.isArray(group.drafts) ? group.drafts : []) {
      const parsed = insightDraftSchema.safeParse(d);
      if (parsed.success) pairs.push({ chunkId: group.chunkId, draft: parsed.data });
    }
  }

  // 3) Embed every draft in a single batched call (the embedder splits into
  //    provider-sized sub-batches internally) instead of one call per draft.
  const vectors = pairs.length
    ? await embedder.embed(pairs.map((p) => `${p.draft.title}. ${p.draft.quote ?? ""}`))
    : [];

  // 4) Persist sequentially so semantic dedup sees prior inserts deterministically.
  const sentiments: string[] = [];
  let created = 0;
  for (let i = 0; i < pairs.length; i++) {
    const { chunkId, draft } = pairs[i];
    if (draft.sentiment) sentiments.push(draft.sentiment);
    const insightId = await upsertInsight(draft, projectId, vectors[i]);
    // Link evidence: insight ↔ chunk (+ exact quote).
    await prisma.insightEvidence.create({
      data: { insightId, chunkId, quote: draft.quote ?? null },
    });
    created++;
  }

  // Roll up a coarse source sentiment from extracted signals.
  const sentiment = majoritySentiment(sentiments);
  if (sentiment && sentiment !== source.sentiment) {
    await prisma.source.update({ where: { id: sourceId }, data: { sentiment } });
  }

  return created;
}

/** Create a new insight, or attach to a near-duplicate (dedupe + frequency++).
 *  `vec` is the draft's embedding, precomputed in one batched call upstream. */
async function upsertInsight(
  draft: InsightDraft,
  projectId: string | undefined,
  vec: number[],
): Promise<string> {
  const neighbors = await nearestInsights(vec, draft.kind, {
    projectId,
    limit: 1,
    minScore: DEDUPE_SCORE,
  });

  if (neighbors.length > 0) {
    const match = neighbors[0];
    await prisma.insight.update({
      where: { id: match.id },
      data: {
        frequency: { increment: 1 },
        // keep the higher severity seen
        severity: draft.severity ?? undefined,
      },
    });
    return match.id;
  }

  const insight = await prisma.insight.create({
    data: {
      projectId,
      kind: draft.kind as any,
      title: draft.title,
      severity: draft.severity ?? null,
      frequency: 1,
    },
  });
  await setEmbedding("insights", insight.id, vec);

  // Carry the model's flow-stage hints onto the insight when they resolve.
  if (draft.flow_stage_hints?.length) {
    const stages = await prisma.flowStage.findMany({
      where: { slug: { in: draft.flow_stage_hints } },
      select: { id: true },
    });
    for (const s of stages) {
      await prisma.insightFlowTag.upsert({
        where: { insightId_stageId: { insightId: insight.id, stageId: s.id } },
        update: {},
        create: { insightId: insight.id, stageId: s.id },
      });
    }
  }

  return insight.id;
}

async function clearPriorEvidence(sourceId: string): Promise<void> {
  const chunkIds = (
    await prisma.chunk.findMany({ where: { sourceId }, select: { id: true } })
  ).map((c: { id: string }) => c.id);
  if (chunkIds.length === 0) return;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Remove evidence rows tied to this source's chunks.
    await tx.insightEvidence.deleteMany({ where: { chunkId: { in: chunkIds } } });
    // Delete now-orphaned insights (no remaining evidence); decrement others.
    const orphans = (await tx.$queryRawUnsafe(
      `SELECT i.id FROM insights i
       LEFT JOIN insight_evidence e ON e.insight_id = i.id
       WHERE e.id IS NULL`,
    )) as { id: string }[];
    if (orphans.length > 0) {
      await tx.insight.deleteMany({ where: { id: { in: orphans.map((o: { id: string }) => o.id) } } });
    }
  });
}

function majoritySentiment(s: string[]): string | null {
  if (s.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const x of s) counts[x] = (counts[x] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}
