import { Worker } from "bullmq";
import IORedis from "ioredis";
import { runPipeline, nameMeetingForSource } from "@research-repo/pipeline";

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

console.log("[worker] pipeline worker started");
