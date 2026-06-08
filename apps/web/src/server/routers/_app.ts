import {
  presignRequestSchema,
  sourceCreateSchema,
} from "@research-repo/core";
import { z } from "zod";
import { prisma } from "@research-repo/db";
import { createSource, presignUploads } from "../sources.service";
import { enqueuePipeline } from "../queue";
import { router, publicProcedure } from "./trpc";
import { searchRouter } from "./search";

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
        },
      });
    }),

  retryStage: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await enqueuePipeline(input.id);
      return { ok: true };
    }),
});

export const appRouter = router({ sources: sourcesRouter, search: searchRouter });
export type AppRouter = typeof appRouter;
