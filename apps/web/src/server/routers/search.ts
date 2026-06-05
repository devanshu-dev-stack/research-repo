import { z } from "zod";
import { searchQuerySchema } from "@research-repo/core";
import { prisma } from "@research-repo/db";
import { router, publicProcedure } from "./trpc";
import { search } from "../search.service";

export const searchRouter = router({
  // Hybrid (or keyword / semantic) search with the full filter set.
  query: publicProcedure
    .input(searchQuerySchema)
    .query(({ input }) => search(input)),

  // Facet counts for the filter rail (sentiment, type, flow stage).
  facets: publicProcedure
    .input(z.object({ projectId: z.string().uuid().optional() }))
    .query(async ({ input }) => {
      const where = {
        projectId: input.projectId,
        status: { in: ["ready", "partial"] as const },
      };
      const [byType, bySentiment, byStage] = await Promise.all([
        prisma.source.groupBy({
          by: ["sourceType"], where, _count: true,
        }),
        prisma.source.groupBy({
          by: ["sentiment"], where, _count: true,
        }),
        prisma.sourceFlowTag.groupBy({
          by: ["stageId"], _count: true,
          where: { source: where },
        }),
      ]);
      // Resolve stage names for the stage facet.
      const stageIds = byStage.map((s) => s.stageId);
      const stages = stageIds.length
        ? await prisma.flowStage.findMany({
            where: { id: { in: stageIds } },
            select: { id: true, name: true, persona: true },
          })
        : [];
      const stageName = new Map(stages.map((s) => [s.id, s]));
      return {
        sourceTypes: byType.map((t) => ({ value: t.sourceType, count: t._count })),
        sentiments: bySentiment
          .filter((s) => s.sentiment)
          .map((s) => ({ value: s.sentiment!, count: s._count })),
        flowStages: byStage
          .map((s) => ({
            id: s.stageId,
            name: stageName.get(s.stageId)?.name ?? "",
            persona: stageName.get(s.stageId)?.persona ?? "both",
            count: s._count,
          }))
          .filter((s) => s.name)
          .sort((a, b) => b.count - a.count),
      };
    }),

  // Saved views — persist + recall the full filter/query state.
  saveView: publicProcedure
    .input(z.object({ name: z.string().min(1), state: z.any() }))
    .mutation(({ input }) =>
      prisma.savedView.create({ data: { name: input.name, filters: input.state } }),
    ),
  listViews: publicProcedure.query(() =>
    prisma.savedView.findMany({ orderBy: { createdAt: "desc" } }),
  ),
  deleteView: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ input }) =>
      prisma.savedView.delete({ where: { id: input.id } }),
    ),
});
