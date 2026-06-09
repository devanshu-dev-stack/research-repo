import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import {
  runPipeline,
  nameMeetingForSource,
  syncDrive,
  findUnfinishedSourceIds,
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
worker.on("failed", (job, err) => {
  console.error(`[worker] pipeline failed for ${job?.data?.sourceId}:`, err.message);
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

// Auto-reprocess: periodically re-enqueue sources stuck in failed/partial so
// transient failures (a flaky API call, a prior quota wall) self-heal. A source
// that has already failed REPROCESS_MAX_ATTEMPTS times is left alone so a
// genuinely broken file isn't retried forever. Idempotent stages mean a re-run
// only does the work still missing (embed/tag/insight). 0 interval = off.
const REPROCESS_INTERVAL_MIN = Number(process.env.REPROCESS_INTERVAL_MIN ?? 0);
const REPROCESS_MAX_ATTEMPTS = Number(process.env.REPROCESS_MAX_ATTEMPTS ?? 3);
const reprocessQueue = new Queue("reprocess", { connection });
const reprocessWorker = new Worker(
  "reprocess",
  async () => {
    const ids = await findUnfinishedSourceIds(REPROCESS_MAX_ATTEMPTS);
    for (const sourceId of ids) {
      await pipelineQueue.add(
        "pipeline",
        { sourceId },
        {
          jobId: sourceId, // dedupe with any in-flight pipeline for this source
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );
    }
    return { requeued: ids.length };
  },
  { connection, concurrency: 1 },
);
reprocessWorker.on("completed", (_job, result) => {
  if (result?.requeued) console.log(`[worker] reprocess re-queued ${result.requeued} source(s)`);
});
reprocessWorker.on("failed", (_job, err) => {
  console.error(`[worker] reprocess failed:`, err.message);
});

if (REPROCESS_INTERVAL_MIN > 0) {
  for (const j of await reprocessQueue.getRepeatableJobs()) {
    await reprocessQueue.removeRepeatableByKey(j.key);
  }
  await reprocessQueue.add(
    "reprocess-scheduled",
    {},
    { repeat: { every: REPROCESS_INTERVAL_MIN * 60_000 }, removeOnComplete: 50, removeOnFail: 50 },
  );
  console.log(
    `[worker] auto-reprocess every ${REPROCESS_INTERVAL_MIN}m ` +
      `(max ${REPROCESS_MAX_ATTEMPTS} attempts per source)`,
  );
}

console.log("[worker] pipeline + drive-sync + reprocess workers started");
