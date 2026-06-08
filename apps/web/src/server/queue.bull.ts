import { Queue } from "bullmq";
import IORedis from "ioredis";

let _connection: IORedis | null = null;
let _queue: Queue | null = null;

export function getRedisConnection(): IORedis {
  return (_connection ??= new IORedis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null, // required by BullMQ
  }));
}

export function getPipelineQueue(): Queue {
  return (_queue ??= new Queue("pipeline", { connection: getRedisConnection() }));
}

let _driveQueue: Queue | null = null;
export function getDriveSyncQueue(): Queue {
  return (_driveQueue ??= new Queue("drive-sync", { connection: getRedisConnection() }));
}
