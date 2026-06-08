import { prisma, Prisma } from "@research-repo/db";
import { chunkContent, type ChunkInput } from "@research-repo/core";

/**
 * Stage: chunk. Reads the normalized units stashed on source.metadata._units
 * and writes chunk rows. Idempotent: deletes existing chunks for the source
 * first, so re-runs never duplicate (and cascade-clears their embeddings).
 */
export async function runChunk(sourceId: string): Promise<number> {
  const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
  const units = ((source.metadata as any)?._units as ChunkInput[]) ?? [];

  const inputs: ChunkInput[] =
    units.length > 0
      ? units
      : source.content
        ? [{ text: source.content }]
        : [];

  const produced = chunkContent(inputs);

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.chunk.deleteMany({ where: { sourceId } });
    if (produced.length > 0) {
      await tx.chunk.createMany({
        data: produced.map((c) => ({
          sourceId,
          ordinal: c.ordinal,
          text: c.text,
          page: c.page,
          responseRef: c.responseRef,
          startMs: c.startMs,
          endMs: c.endMs,
        })),
      });
    }
  });

  return produced.length;
}
