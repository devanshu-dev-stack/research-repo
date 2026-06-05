import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// S3-compatible (AWS S3 / Cloudflare R2 / MinIO). Endpoint + path-style make
// it work against MinIO locally and real S3/R2 in prod with the same code.
const BUCKET = process.env.S3_BUCKET ?? "research-repo";

let _client: S3Client | null = null;
export function s3(): S3Client {
  if (_client) return _client;
  _client = new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: !!process.env.S3_ENDPOINT, // needed for MinIO
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
  return _client;
}

/** Key layout: projects/{projectId}/sources/{sourceId}/original/{name} */
export function originalKey(projectId: string, sourceId: string, name: string): string {
  return `projects/${projectId}/sources/${sourceId}/original/${name}`;
}
export function uploadStagingKey(uploadId: string, name: string): string {
  // Pre-source uploads land in a staging prefix; moved/renamed at sources.create.
  return `uploads/staging/${uploadId}/${name}`;
}

export async function presignPut(key: string, contentType?: string): Promise<string> {
  return getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 900 },
  );
}

export async function presignGet(key: string): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: 900,
  });
}

/** Pull an object's bytes for processing (extract/normalize stages). */
export async function getObjectBytes(key: string): Promise<Buffer> {
  const res = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks: Buffer[] = [];
  const body = res.Body as AsyncIterable<Uint8Array> | undefined;
  if (!body) throw new Error(`Empty body for key ${key}`);
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}
