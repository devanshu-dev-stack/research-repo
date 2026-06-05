import { runPipeline } from "@research-repo/pipeline";

/**
 * Enqueue the processing pipeline for a source.
 *
 * If REDIS_URL is set, enqueue a BullMQ job (drained by workers/). Otherwise
 * run inline (fire-and-forget) so the spine works in dev/tests with no Redis.
 * The request path still returns immediately either way.
 */
export async function enqueuePipeline(sourceId: string): Promise<void> {
  if (process.env.REDIS_URL) {
    const { getPipelineQueue } = await import("./queue.bull");
    const queue = getPipelineQueue();
    await queue.add(
      "pipeline",
      { sourceId },
      {
        jobId: sourceId, // dedupe: one in-flight pipeline per source
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    return;
  }

  // Inline fallback — do not block the caller.
  void runPipeline(sourceId).catch((err) => {
    console.error(`[pipeline] inline run failed for ${sourceId}:`, err);
  });
}
