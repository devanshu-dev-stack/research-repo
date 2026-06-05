import { prisma } from "@research-repo/db";
import {
  detectSourceType,
  extensionOf,
  type PresignRequest,
  type SourceCreateInput,
} from "@research-repo/core";
import {
  originalKey,
  presignPut,
  uploadStagingKey,
  s3,
} from "@research-repo/pipeline/storage";
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

const BUCKET = process.env.S3_BUCKET ?? "research-repo";

export interface PresignedUpload {
  uploadId: string;
  key: string;
  url: string;
  name: string;
}

/** Issue one presigned PUT per file into a staging prefix. The browser uploads
 *  directly; nothing proxies bytes through the app. */
export async function presignUploads(req: PresignRequest): Promise<PresignedUpload[]> {
  return Promise.all(
    req.files.map(async (f) => {
      const uploadId = randomUUID();
      const key = uploadStagingKey(uploadId, f.name);
      const url = await presignPut(key, f.mime);
      return { uploadId, key, url, name: f.name };
    }),
  );
}

export interface CreateSourceResult {
  sourceId: string;
  duplicate: boolean;
  status: string;
}

/**
 * Create a source row from a completed upload, then return it for enqueueing.
 * - Dedupe: if checksum matches an existing source, return that one (no new row).
 * - Moves the object from staging to its canonical per-source key.
 * The caller enqueues the pipeline (keeps this service queue-agnostic).
 */
export async function createSource(
  input: SourceCreateInput,
): Promise<CreateSourceResult> {
  // 1) Hard dedupe on checksum if provided.
  if (input.checksumSha256) {
    const existing = await prisma.source.findUnique({
      where: { checksumSha256: input.checksumSha256 },
    });
    if (existing) {
      return { sourceId: existing.id, duplicate: true, status: existing.status };
    }
  }

  const ext = extensionOf(input.originalName);
  const sourceType = detectSourceType(input.mime, ext);
  const projectId = input.projectId ?? (await defaultProjectId());

  // 2) Create the row first to get an id for the canonical key.
  const source = await prisma.source.create({
    data: {
      projectId,
      sourceType,
      status: "pending",
      originalName: input.originalName,
      storageKey: input.key, // temporary; updated after move
      mimeType: input.mime,
      byteSize: input.size != null ? BigInt(input.size) : null,
      checksumSha256: input.checksumSha256,
      participant: input.participant,
      topic: input.topic,
      recordedAt: input.recordedAt,
      metadata: input.source ? { source: input.source } : {},
    },
  });

  // 3) Move object from staging → canonical key (best effort; falls back to
  //    leaving it in staging if storage isn't configured in this env).
  const destKey = originalKey(projectId, source.id, input.originalName);
  try {
    await s3().send(
      new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: `${BUCKET}/${input.key}`,
        Key: destKey,
      }),
    );
    await prisma.source.update({
      where: { id: source.id },
      data: { storageKey: destKey },
    });
  } catch {
    // keep staging key; ingest can still read it
  }

  return { sourceId: source.id, duplicate: false, status: "pending" };
}

let _defaultProjectId: string | null = null;
async function defaultProjectId(): Promise<string> {
  if (_defaultProjectId) return _defaultProjectId;
  const p = await prisma.project.findFirst({ where: { slug: "collage-research" } });
  if (!p) throw new Error("Default project not found — run the db seed first.");
  _defaultProjectId = p.id;
  return p.id;
}
