import { z } from "zod";
import { prisma } from "@research-repo/db";
import { router, publicProcedure } from "./trpc";

// Insight + flow-map reads for the Insights and Flow Map views. Insights are
// surfaced with their traceability chain (evidence quote → chunk → source) so
// the UI can link each claim back to where it came from.
export const insightsRouter = router({
  // Ranked insights (most frequent / most severe first), with evidence + tags.
  list: publicProcedure
    .input(
      z.object({
        projectId: z.string().uuid().optional(),
        kind: z.string().optional(),
        stageId: z.string().uuid().optional(),
        meetingId: z.string().uuid().optional(),
        includeArchived: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(100),
      }),
    )
    .query(async ({ input }) => {
      const insights = await prisma.insight.findMany({
        where: {
          projectId: input.projectId,
          kind: input.kind ? (input.kind as any) : undefined,
          archived: input.includeArchived ? undefined : false,
          flowTags: input.stageId ? { some: { stageId: input.stageId } } : undefined,
          evidence: input.meetingId
            ? { some: { chunk: { source: { meetingId: input.meetingId } } } }
            : undefined,
        },
        orderBy: [{ frequency: "desc" }, { severity: "desc" }],
        take: input.limit,
        include: {
          evidence: {
            take: 5,
            include: {
              chunk: {
                select: {
                  source: {
                    select: {
                      id: true,
                      originalName: true,
                      topic: true,
                      sourceType: true,
                      meeting: { select: { id: true, title: true } },
                    },
                  },
                },
              },
            },
          },
          flowTags: { include: { stage: { select: { id: true, name: true, persona: true } } } },
        },
      });

      return insights.map((i) => {
        const sources = new Map<string, { id: string; name: string }>();
        const meetings = new Map<string, { id: string; title: string }>();
        const evidence = i.evidence.map((e) => {
          const s = e.chunk?.source;
          const name = s ? s.topic || s.originalName : null;
          if (s) sources.set(s.id, { id: s.id, name: name! });
          if (s?.meeting) meetings.set(s.meeting.id, { id: s.meeting.id, title: s.meeting.title ?? "Untitled meeting" });
          return { quote: e.quote, sourceId: s?.id ?? null, sourceName: name };
        });
        return {
          id: i.id,
          kind: i.kind,
          title: i.title,
          summary: i.summary,
          severity: i.severity,
          frequency: i.frequency,
          archived: i.archived,
          stages: i.flowTags.map((t) => t.stage).filter(Boolean),
          evidence,
          sources: [...sources.values()],
          meetings: [...meetings.values()],
        };
      });
    }),

  // Full detail for one insight: every evidence quote with its timestamp
  // (when said, for audio/video) or page, plus source and stages.
  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const i = await prisma.insight.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          evidence: {
            include: {
              chunk: {
                select: {
                  startMs: true,
                  endMs: true,
                  page: true,
                  ordinal: true,
                  source: { select: { id: true, originalName: true, topic: true, sourceType: true } },
                },
              },
            },
          },
          flowTags: { include: { stage: { select: { id: true, name: true } } } },
        },
      });
      return {
        id: i.id,
        kind: i.kind,
        title: i.title,
        summary: i.summary,
        severity: i.severity,
        frequency: i.frequency,
        archived: i.archived,
        stages: i.flowTags.map((t) => t.stage).filter(Boolean),
        evidence: i.evidence.map((e) => ({
          quote: e.quote,
          startMs: e.chunk?.startMs ?? null,
          endMs: e.chunk?.endMs ?? null,
          page: e.chunk?.page ?? null,
          sourceId: e.chunk?.source?.id ?? null,
          sourceName: e.chunk?.source ? e.chunk.source.topic || e.chunk.source.originalName : null,
          sourceType: e.chunk?.source?.sourceType ?? null,
        })),
      };
    }),

  archive: publicProcedure
    .input(z.object({ id: z.string().uuid(), archived: z.boolean() }))
    .mutation(({ input }) =>
      prisma.insight.update({ where: { id: input.id }, data: { archived: input.archived } }),
    ),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await prisma.insight.delete({ where: { id: input.id } });
      return { deleted: true };
    }),

  // Insight counts per kind — drives the filter chips on the Insights view.
  kinds: publicProcedure
    .input(z.object({ projectId: z.string().uuid().optional() }))
    .query(async ({ input }) => {
      const grouped = await prisma.insight.groupBy({
        by: ["kind"],
        where: { projectId: input.projectId },
        _count: { _all: true },
      });
      return grouped
        .map((g) => ({ kind: g.kind, count: g._count._all }))
        .sort((a, b) => b.count - a.count);
    }),

  // Flow taxonomy with per-stage tagged-source + insight counts. The client
  // builds the persona-grouped tree from parentId.
  flowMap: publicProcedure
    .input(z.object({ projectId: z.string().uuid().optional() }))
    .query(async () => {
      const stages = await prisma.flowStage.findMany({
        orderBy: [{ position: "asc" }],
        select: {
          id: true,
          name: true,
          persona: true,
          parentId: true,
          position: true,
          _count: { select: { sourceTags: true, insightTags: true } },
        },
      });
      return stages.map((s) => ({
        id: s.id,
        name: s.name,
        persona: s.persona,
        parentId: s.parentId,
        position: s.position,
        sources: s._count.sourceTags,
        insights: s._count.insightTags,
      }));
    }),
});
