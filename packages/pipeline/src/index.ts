import { prisma } from "@research-repo/db";
import { runExtract } from "./stages/extract";
import { runNormalize } from "./stages/normalize";
import { runChunk } from "./stages/chunk";
import { runEmbed } from "./stages/embed";
import { runClassify } from "./stages/classify";
import { runInsight } from "./stages/insight";

export type StageName =
  | "extract"
  | "normalize"
  | "chunk"
  | "embed"
  | "classify"
  | "insight";

// Full pipeline. Media `extract` runs first (feeds normalize); classify+insight
// run after embeddings exist. Each stage is idempotent so retries are safe.
const STAGES: { name: StageName; run: (id: string) => Promise<unknown> }[] = [
  { name: "extract", run: runExtract },
  { name: "normalize", run: runNormalize },
  { name: "chunk", run: runChunk },
  { name: "embed", run: runEmbed },
  { name: "classify", run: runClassify },
  { name: "insight", run: runInsight },
];

/** Run one stage with audit + error capture. Throws on failure (so the queue
 *  can apply its retry/backoff policy). */
export async function runStage(sourceId: string, name: StageName): Promise<void> {
  const stage = STAGES.find((s) => s.name === name);
  if (!stage) throw new Error(`Unknown stage: ${name}`);

  const job = await prisma.processingJob.create({
    data: { sourceId, stage: name, status: "active", startedAt: new Date() },
  });
  try {
    await stage.run(sourceId);
    await prisma.processingJob.update({
      where: { id: job.id },
      data: { status: "completed", endedAt: new Date() },
    });
  } catch (err) {
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        endedAt: new Date(),
        attempts: { increment: 1 },
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

/**
 * Run the full spine for a source. In production each stage is its own queued
 * job (see workers/); this sequential runner is used by the inline worker and
 * by tests. Marks the source ready on success, partial/failed otherwise.
 */
export async function runPipeline(sourceId: string): Promise<void> {
  await prisma.source.update({
    where: { id: sourceId },
    data: { status: "processing", error: null },
  });

  let lastOk: StageName | null = null;
  try {
    for (const stage of STAGES) {
      await runStage(sourceId, stage.name);
      lastOk = stage.name;
    }
    await prisma.source.update({
      where: { id: sourceId },
      data: { status: "ready", processedAt: new Date() },
    });
  } catch (err) {
    // "Usable" = we produced content and chunks (got through `chunk`); a later
    // failure (embed/classify/insight) still leaves a searchable source.
    const usable = lastOk === "chunk" || lastOk === "embed" || lastOk === "classify";
    await prisma.source.update({
      where: { id: sourceId },
      data: {
        status: usable ? "partial" : "failed",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

export { runExtract, runNormalize, runChunk, runEmbed, runClassify, runInsight };
export { nameMeetingFromSources, nameMeetingForSource } from "./meeting";
