import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import {
  runPipeline,
  nameMeetingForSource,
  syncDrive,
  markSourceUnprocessed,
} from "@research-repo/pipeline";

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
// A failed pipeline run is auto-retried by the queue (attempts below). This event
// fires on every attempt; once the last one is exhausted, record a plain
// "not processed" message so the UI stops implying it'll keep trying.
worker.on("failed", async (job, err) => {
  const sourceId = job?.data?.sourceId;
  console.error(`[worker] pipeline failed for ${sourceId}:`, err.message);
  const attempts = job?.opts?.attempts ?? 1;
  if (sourceId && (job?.attemptsMade ?? 0) >= attempts) {
    await markSourceUnprocessed(sourceId, attempts);
    console.error(`[worker] giving up on ${sourceId} after ${attempts} attempts`);
  }
});

// Drive sync: mirror the configured folder, then enqueue a pipeline job per new
// source. Concurrency 1 so two syncs never race over the same files.
//
// Scheduled (auto) syncs apply a settle window so a file is only ingested once
// it's been untouched for DRIVE_SYNC_MIN_AGE_MIN minutes — i.e. the pipeline
// effectively fires ~that long after upload, by which point a Meet recording has
// finished finalizing in Drive. Manual syncs (job carries `manual: true`) skip
// the gate and ingest immediately.
const DRIVE_SYNC_MIN_AGE_MIN = Number(process.env.DRIVE_SYNC_MIN_AGE_MIN ?? 15);
const pipelineQueue = new Queue("pipeline", { connection });
const driveSyncQueue = new Queue("drive-sync", { connection });

// Enqueue a pipeline run for a source. jobId = sourceId dedupes in-flight runs,
// but BullMQ keeps that id reserved for a RETAINED finished job (removeOnFail),
// so a re-run would be silently dropped. Remove the prior finished job first; if
// it's currently active, remove() throws and the dedup correctly wins.
async function enqueuePipelineJob(sourceId: string): Promise<void> {
  await pipelineQueue.remove(sourceId).catch(() => {});
  await pipelineQueue.add(
    "pipeline",
    { sourceId },
    {
      jobId: sourceId,
      attempts: Number(process.env.PIPELINE_ATTEMPTS ?? 3), // auto-retry, then "not processed"
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );
}
const driveWorker = new Worker(
  "drive-sync",
  async (job) => {
    const { rootFolderId, manual } = (job.data ?? {}) as {
      rootFolderId?: string;
      manual?: boolean;
    };
    const minAgeMs = manual ? 0 : DRIVE_SYNC_MIN_AGE_MIN * 60_000;
    const result = await syncDrive({ rootFolderId, minAgeMs });
    for (const sourceId of result.createdSourceIds) {
      await enqueuePipelineJob(sourceId);
    }
    return result;
  },
  { connection, concurrency: 1 },
);

driveWorker.on("completed", (job, result) => {
  console.log(
    `[worker] drive-sync done: ${result?.createdSourceIds?.length ?? 0} new, ` +
      `${result?.skipped ?? 0} skipped, ${result?.deferred ?? 0} deferred, ` +
      `${result?.errors?.length ?? 0} errors`,
  );
});
driveWorker.on("failed", (_job, err) => {
  console.error(`[worker] drive-sync failed:`, err.message);
});

// Auto-sync scheduler: poll the configured Drive folder every
// DRIVE_SYNC_INTERVAL_MIN minutes (0 = off → manual sync only). Each run defers
// files newer than the settle window, so a freshly uploaded file is ingested on
// the first poll after it's been quiet for DRIVE_SYNC_MIN_AGE_MIN minutes.
const DRIVE_SYNC_INTERVAL_MIN = Number(process.env.DRIVE_SYNC_INTERVAL_MIN ?? 0);
if (DRIVE_SYNC_INTERVAL_MIN > 0) {
  // Clear any prior schedule (e.g. the interval changed between restarts), then
  // register the current one. Re-adding identical repeat opts is idempotent.
  for (const j of await driveSyncQueue.getRepeatableJobs()) {
    await driveSyncQueue.removeRepeatableByKey(j.key);
  }
  await driveSyncQueue.add(
    "drive-sync-scheduled",
    {},
    { repeat: { every: DRIVE_SYNC_INTERVAL_MIN * 60_000 }, removeOnComplete: 50, removeOnFail: 50 },
  );
  console.log(
    `[worker] drive auto-sync every ${DRIVE_SYNC_INTERVAL_MIN}m ` +
      `(settle window ${DRIVE_SYNC_MIN_AGE_MIN}m)`,
  );
}

console.log("[worker] pipeline + drive-sync workers started");
