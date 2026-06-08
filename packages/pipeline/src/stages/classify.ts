import { prisma, Prisma, getEmbedding, matchFlowStages } from "@research-repo/db";
import { getLLMProvider } from "@research-repo/ai";

const THRESHOLD = Number(process.env.CLASSIFY_THRESHOLD ?? 0.3);
// Pass B kicks in when the top match is weak or the top two are close (ambiguous).
const AMBIGUOUS_MARGIN = 0.05;
const WEAK_TOP = THRESHOLD + 0.1;

interface StageScore {
  id: string;
  name: string;
  score: number; // max confidence seen across chunks
}

/**
 * Stage: classify. Maps a source to flow stages.
 *
 * Pass A (free): cosine-match each chunk embedding against flow_stages; collect
 *   candidate stages above THRESHOLD, keeping the max score per stage.
 * Pass B (LLM, only when ambiguous): when a chunk's top candidates are close or
 *   weak, ask the LLM to adjudicate among the shortlist.
 *
 * Idempotent + override-safe: removes only `auto` tags for this source, then
 * writes the new auto tags. Rows with origin 'manual'/'override' are untouched.
 */
export async function runClassify(sourceId: string): Promise<number> {
  const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });

  const chunks = await prisma.chunk.findMany({
    where: { sourceId },
    select: { id: true, text: true },
    orderBy: { ordinal: "asc" },
  });
  if (chunks.length === 0) return 0;

  const llm = getLLMProvider();
  const best = new Map<string, StageScore>();

  type Candidate = Awaited<ReturnType<typeof matchFlowStages>>[number];

  // Pass A (DB-only) for every chunk: semantic shortlist + ambiguity flag.
  const perChunk: { candidates: Candidate[]; ambiguous: boolean }[] = [];
  for (const chunk of chunks) {
    const vec = await getEmbedding("chunks", chunk.id);
    const candidates = vec ? await matchFlowStages(vec, THRESHOLD) : [];
    let ambiguous = false;
    if (candidates.length > 0) {
      const top = candidates[0];
      const close = candidates[1] && top.score - candidates[1].score < AMBIGUOUS_MARGIN;
      ambiguous = top.score < WEAK_TOP || !!close; // weak top, or top-two within margin
    }
    perChunk.push({ candidates, ambiguous });
  }

  // Pass B (LLM) only for ambiguous chunks — run concurrently; the provider's
  // rate limiter paces + retries so a big file doesn't serialize or 429.
  const adjudications = await Promise.all(
    chunks.map(async (chunk, i): Promise<Candidate[] | null> => {
      const { candidates, ambiguous } = perChunk[i];
      if (!ambiguous || candidates.length === 0) return null;
      const shortlist = candidates.slice(0, 4);
      const adjudicated = await llm
        .classify({
          text: chunk.text,
          candidates: shortlist.map((c) => ({ id: c.id, name: c.name, description: c.slug })),
        })
        .catch(() => []);
      if (adjudicated.length === 0) return null;
      const byId = new Map(shortlist.map((c) => [c.id, c]));
      return adjudicated
        .filter((m) => byId.has(m.id))
        .map((m) => ({ ...byId.get(m.id)!, score: m.confidence }));
    }),
  );

  // Merge: an adjudicated override replaces Pass A candidates for that chunk.
  for (let i = 0; i < chunks.length; i++) {
    const accepted = adjudications[i] ?? perChunk[i].candidates;
    for (const c of accepted) {
      const prev = best.get(c.id);
      if (!prev || c.score > prev.score) {
        best.set(c.id, { id: c.id, name: c.name, score: c.score });
      }
    }
  }

  // Write: clear prior auto tags, keep manual/override, insert fresh auto tags.
  const tags = [...best.values()];
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.sourceFlowTag.deleteMany({ where: { sourceId, origin: "auto" } });
    for (const t of tags) {
      await tx.sourceFlowTag.upsert({
        where: { sourceId_stageId: { sourceId, stageId: t.id } },
        // don't downgrade a manual/override row to auto
        update: {},
        create: { sourceId, stageId: t.id, confidence: t.score, origin: "auto" },
      });
    }
  });

  // Derive a coarse source sentiment hint if not already set (cheap, optional).
  if (!source.sentiment) {
    // left for the insight stage, which has richer per-chunk sentiment
  }

  return tags.length;
}
