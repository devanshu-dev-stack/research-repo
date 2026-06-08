import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { runPipeline, nameMeetingForSource, syncDrive } from "@research-repo/pipeline";

const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

// One worker drives the full spine per source. As media/classify/insight
// stages are added, split into per-stage queues with independent concurrency
// (see ARCHITECTURE.md §14).
const worker = new Worker(
  "pipeline",
  async (job) => {
    const { sourceId } = job.data as { sourceId: string };
    try {
      await runPipeline(sourceId);
    } finally {
      // Best-effort: title the meeting from whatever processed (covers 'partial' too).
      await nameMeetingForSource(sourceId).catch(() => {});
    }
  },
  { connection, concurrency: Number(process.env.PIPELINE_CONCURRENCY ?? 4) },
);

worker.on("completed", (job) => {
  console.log(`[worker] pipeline completed for ${job.data.sourceId}`);
});
worker.on("failed", (job, err) => {
  console.error(`[worker] pipeline failed for ${job?.data?.sourceId}:`, err.message);
});

// Drive sync: mirror the configured folder, then enqueue a pipeline job per new
// source. Concurrency 1 so two syncs never race over the same files.
const pipelineQueue = new Queue("pipeline", { connection });
const driveWorker = new Worker(
  "drive-sync",
  async (job) => {
    const { rootFolderId } = (job.data ?? {}) as { rootFolderId?: string };
    const result = await syncDrive({ rootFolderId });
    for (const sourceId of result.createdSourceIds) {
      await pipelineQueue.add(
        "pipeline",
        { sourceId },
        {
          jobId: sourceId,
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );
    }
    return result;
  },
  { connection, concurrency: 1 },
);

driveWorker.on("completed", (job, result) => {
  console.log(
    `[worker] drive-sync done: ${result?.createdSourceIds?.length ?? 0} new, ` +
      `${result?.skipped ?? 0} skipped, ${result?.errors?.length ?? 0} errors`,
  );
});
driveWorker.on("failed", (_job, err) => {
  console.error(`[worker] drive-sync failed:`, err.message);
});

console.log("[worker] pipeline + drive-sync workers started");
