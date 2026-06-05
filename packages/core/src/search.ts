import { z } from "zod";
import { sourceTypeSchema } from "./schemas";

// The blueprint filter set: flow stage, feature area/tag, sentiment, date,
// research type, participant segment, project. All optional; combine freely.
export const searchFiltersSchema = z.object({
  projectId: z.string().uuid().optional(),
  flowStageIds: z.array(z.string().uuid()).optional(),
  tagIds: z.array(z.string().uuid()).optional(),
  sentiment: z.enum(["positive", "neutral", "negative", "mixed"]).optional(),
  sourceType: sourceTypeSchema.optional(),
  participant: z.string().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  // Only surface sources that finished processing by default.
  statuses: z
    .array(z.enum(["pending", "processing", "ready", "failed", "partial"]))
    .default(["ready", "partial"]),
});
export type SearchFilters = z.infer<typeof searchFiltersSchema>;

export const searchQuerySchema = z.object({
  q: z.string().trim().default(""),
  filters: searchFiltersSchema.default({}),
  mode: z.enum(["hybrid", "keyword", "semantic"]).default("hybrid"),
  limit: z.number().int().min(1).max(100).default(25),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

// Reciprocal Rank Fusion. Each input is a ranked list of ids (best first).
// score(id) = sum over lists of 1 / (k + rank). k=60 is the common default.
export function reciprocalRankFusion(
  lists: { id: string; weight?: number }[][],
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, idx) => {
      const w = item.weight ?? 1;
      const add = w / (k + idx + 1);
      scores.set(item.id, (scores.get(item.id) ?? 0) + add);
    });
  }
  return scores;
}
