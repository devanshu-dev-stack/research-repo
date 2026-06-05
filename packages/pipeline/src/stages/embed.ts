import { prisma, setEmbedding } from "@research-repo/db";
import { getEmbedProvider } from "@research-repo/ai";

/**
 * Stage: embed. Embeds every chunk lacking a vector and writes it. Embeddings
 * can't be set through the typed client (Unsupported vector column), so we use
 * the db package's setEmbedding helper (parameterized raw UPDATE).
 *
 * Idempotent by construction: only embeds chunks whose embedding IS NULL, so a
 * re-run after a partial failure resumes rather than redoing work.
 */
export async function runEmbed(sourceId: string): Promise<number> {
  const provider = getEmbedProvider();

  // Find chunks without embeddings (raw — embedding isn't in the typed model).
  const pending = (await prisma.$queryRawUnsafe(
    `SELECT id, text FROM chunks WHERE source_id = $1::uuid AND embedding IS NULL ORDER BY ordinal`,
    sourceId,
  )) as { id: string; text: string }[];
  if (pending.length === 0) return 0;

  const BATCH = 64;
  let embedded = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const vectors = await provider.embed(batch.map((c: { text: string }) => c.text));
    // Write sequentially; could be parallelized with a small pool if needed.
    for (let j = 0; j < batch.length; j++) {
      await setEmbedding("chunks", batch[j].id, vectors[j]);
      embedded++;
    }
  }
  return embedded;
}
