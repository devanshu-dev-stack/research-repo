// Browser-side upload flow. Keeps the request path O(1) per file: the browser
// uploads bytes directly to object storage via presigned PUT, then registers
// the source. Computes a SHA-256 checksum for dedupe.

export interface UploadFileResult {
  name: string;
  sourceId: string;
  duplicate: boolean;
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Upload a batch of files.
 * @param createSource - bound tRPC mutation (sources.create) injected by caller.
 */
export async function uploadFiles(
  files: File[],
  createSource: (input: {
    key: string;
    originalName: string;
    mime?: string;
    size?: number;
    checksumSha256?: string;
    participant?: string;
    topic?: string;
  }) => Promise<{ sourceId: string; duplicate: boolean }>,
  meta: { participant?: string; topic?: string } = {},
): Promise<UploadFileResult[]> {
  // 1) Batch presign
  const presignRes = await fetch("/api/upload/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      files: files.map((f) => ({ name: f.name, size: f.size, mime: f.type })),
    }),
  });
  if (!presignRes.ok) throw new Error("presign failed");
  const { uploads } = (await presignRes.json()) as {
    uploads: { uploadId: string; key: string; url: string; name: string }[];
  };

  // 2) Upload bytes directly + register each source (parallel).
  return Promise.all(
    files.map(async (file, i) => {
      const slot = uploads[i];
      await fetch(slot.url, {
        method: "PUT",
        headers: file.type ? { "Content-Type": file.type } : undefined,
        body: file,
      });
      const checksum = await sha256Hex(file);
      const res = await createSource({
        key: slot.key,
        originalName: file.name,
        mime: file.type || undefined,
        size: file.size,
        checksumSha256: checksum,
        participant: meta.participant,
        topic: meta.topic,
      });
      return { name: file.name, sourceId: res.sourceId, duplicate: res.duplicate };
    }),
  );
}
