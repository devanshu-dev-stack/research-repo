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

export interface DriveSyncTrigger {
  mode: "queued" | "inline";
  /** Present only for inline runs (no Redis); the queued worker reports via logs. */
  created?: number;
  skipped?: number;
  meetings?: number;
  errors?: { file: string; message: string }[];
}

/**
 * Kick off a Google Drive sync. With Redis, enqueue a `drive-sync` job (the
 * worker runs it and enqueues a pipeline job per new source). Without Redis,
 * run it inline and enqueue each new source's pipeline here.
 */
export async function enqueueDriveSync(rootFolderId?: string): Promise<DriveSyncTrigger> {
  if (process.env.REDIS_URL) {
    const { getDriveSyncQueue } = await import("./queue.bull");
    await getDriveSyncQueue().add(
      "drive-sync",
      { rootFolderId },
      { removeOnComplete: 50, removeOnFail: 50 },
    );
    return { mode: "queued" };
  }

  const { syncDrive } = await import("@research-repo/pipeline");
  const result = await syncDrive({ rootFolderId });
  for (const id of result.createdSourceIds) await enqueuePipeline(id);
  return {
    mode: "inline",
    created: result.createdSourceIds.length,
    skipped: result.skipped,
    meetings: result.meetings,
    errors: result.errors,
  };
}
