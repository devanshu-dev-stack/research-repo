import { z } from "zod";

export const SOURCE_TYPES = [
  "survey", "video", "audio", "transcript", "note", "pdf", "doc", "image", "other",
] as const;

export const sourceTypeSchema = z.enum(SOURCE_TYPES);
export type SourceTypeT = z.infer<typeof sourceTypeSchema>;

// Detect source type from mime + extension. Conservative: unknown -> "other".
export function detectSourceType(mime: string | undefined, ext: string): SourceTypeT {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (["csv", "tsv"].includes(ext) || m.includes("csv")) return "survey";
  if (["doc", "docx"].includes(ext) || m.includes("word")) return "doc";
  if (["txt", "md"].includes(ext) || m.startsWith("text/")) return "note";
  return "other";
}

// ── API input schemas ────────────────────────────────────
export const presignRequestSchema = z.object({
  files: z
    .array(
      z.object({
        name: z.string().min(1),
        size: z.number().int().positive(),
        mime: z.string().optional(),
      }),
    )
    .min(1)
    .max(100),
});
export type PresignRequest = z.infer<typeof presignRequestSchema>;

export const sourceCreateSchema = z.object({
  key: z.string().min(1), // object-store key from the presign step
  originalName: z.string().min(1),
  mime: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  checksumSha256: z.string().length(64).optional(),
  projectId: z.string().uuid().optional(),
  participant: z.string().optional(),
  source: z.string().optional(),
  topic: z.string().optional(),
  recordedAt: z.coerce.date().optional(),
});
export type SourceCreateInput = z.infer<typeof sourceCreateSchema>;

// LLM insight-extraction contract (validated before persisting).
export const insightDraftSchema = z.object({
  kind: z.enum([
    "pain_point", "feature_request", "ux_friction", "positive",
    "theme", "job_to_be_done", "goal",
  ]),
  title: z.string().min(1),
  quote: z.string().optional(),
  severity: z.number().int().min(1).max(5).optional(),
  sentiment: z.enum(["positive", "neutral", "negative", "mixed"]).optional(),
  flow_stage_hints: z.array(z.string()).optional(),
});
export const insightExtractionSchema = z.object({
  insights: z.array(insightDraftSchema),
});
export type InsightDraft = z.infer<typeof insightDraftSchema>;
