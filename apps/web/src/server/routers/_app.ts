import {
  presignRequestSchema,
  sourceCreateSchema,
} from "@research-repo/core";
import { z } from "zod";
import { prisma } from "@research-repo/db";
import { findUnfinishedSourceIds } from "@research-repo/pipeline";
import { createSource, deleteSource, presignUploads } from "../sources.service";
import { enqueuePipeline } from "../queue";
import { router, publicProcedure } from "./trpc";
import { searchRouter } from "./search";
import { insightsRouter } from "./insights";
import { meetingsRouter } from "./meetings";
import { driveRouter } from "./drive";

export const sourcesRouter = router({
  // Batch presign for drag-and-drop / batch uploads.
  presign: publicProcedure
    .input(presignRequestSchema)
    .mutation(({ input }) => presignUploads(input)),

  // Create a source from a completed upload, then enqueue the pipeline.
  create: publicProcedure
    .input(sourceCreateSchema)
    .mutation(async ({ input }) => {
      const result = await createSource(input);
      if (!result.duplicate) {
        await enqueuePipeline(result.sourceId);
      }
      return result;
    }),

  // Paginated, filtered repository list.
  list: publicProcedure
    .input(
      z.object({
        projectId: z.string().uuid().optional(),
        status: z
          .enum(["pending", "processing", "ready", "failed", "partial"])
          .optional(),
        sourceType: z.string().optional(),
        cursor: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ input }) => {
      const items = await prisma.source.findMany({
        where: {
          projectId: input.projectId,
          status: input.status,
          sourceType: input.sourceType as any,
        },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        select: {
          id: true,
          sourceType: true,
          status: true,
          originalName: true,
          canonicalName: true,
          participant: true,
          topic: true,
          sentiment: true,
          recordedAt: true,
          createdAt: true,
        },
      });
      let nextCursor: string | undefined;
      if (items.length > input.limit) nextCursor = items.pop()!.id;
      return { items, nextCursor };
    }),

  // Source detail with chunks (for the source-detail view / traceability).
  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      return prisma.source.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          chunks: { orderBy: { ordinal: "asc" } },
          flowTags: { include: { stage: true } },
          meeting: { select: { id: true, title: true } },
        },
      });
    }),

  retryStage: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await enqueuePipeline(input.id);
      return { ok: true };
    }),

  // Re-run the pipeline for every failed/partial source (no attempt cap — this
  // is an explicit user action). Idempotent stages embed/tag/extract whatever's
  // still missing.
  reprocessUnfinished: publicProcedure.mutation(async () => {
    const ids = await findUnfinishedSourceIds();
    for (const id of ids) await enqueuePipeline(id);
    return { queued: ids.length };
  }),

  // Remove a source and everything derived from it.
  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ input }) => deleteSource(input.id)),
});

export const appRouter = router({
  sources: sourcesRouter,
  search: searchRouter,
  insights: insightsRouter,
  meetings: meetingsRouter,
  drive: driveRouter,
});
export type AppRouter = typeof appRouter;
