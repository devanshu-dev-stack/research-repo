import {
  prisma,
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

  const sentiments: string[] = [];
  let created = 0;

  for (const chunk of chunks) {
    let drafts: InsightDraft[];
    try {
      const raw = await llm.extractInsights(chunk.text);
      // Validate each draft independently; keep the valid ones, drop malformed
      // (one bad entry shouldn't discard a whole chunk's insights).
      drafts = (Array.isArray(raw) ? raw : [])
        .map((d) => insightDraftSchema.safeParse(d))
        .filter((r): r is { success: true; data: InsightDraft } => r.success)
        .map((r) => r.data);
    } catch {
      drafts = [];
    }

    for (const draft of drafts) {
      if (draft.sentiment) sentiments.push(draft.sentiment);
      const insightId = await upsertInsight(draft, projectId);
      // Link evidence: insight ↔ chunk (+ exact quote).
      await prisma.insightEvidence.create({
        data: { insightId, chunkId: chunk.id, quote: draft.quote ?? null },
      });
      created++;
    }
  }

  // Roll up a coarse source sentiment from extracted signals.
  const sentiment = majoritySentiment(sentiments);
  if (sentiment && sentiment !== source.sentiment) {
    await prisma.source.update({ where: { id: sourceId }, data: { sentiment } });
  }

  return created;
}

/** Create a new insight, or attach to a near-duplicate (dedupe + frequency++). */
async function upsertInsight(
  draft: InsightDraft,
  projectId: string | undefined,
): Promise<string> {
  const embedder = getEmbedProvider();
  const [vec] = await embedder.embed([`${draft.title}. ${draft.quote ?? ""}`]);

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

  await prisma.$transaction(async (tx: typeof prisma) => {
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
