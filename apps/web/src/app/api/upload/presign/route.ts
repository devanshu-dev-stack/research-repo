import { NextRequest, NextResponse } from "next/server";
import { presignRequestSchema } from "@research-repo/core";
import { presignUploads } from "@/server/sources.service";

// POST /api/upload/presign  -> [{ uploadId, key, url, name }]
// REST (not tRPC) so non-JS clients / direct uploads can use it too.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = presignRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const uploads = await presignUploads(parsed.data);
    return NextResponse.json({ uploads });
  } catch (err) {
    return NextResponse.json(
      { error: "presign_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
