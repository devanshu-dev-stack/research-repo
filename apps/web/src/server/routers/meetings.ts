import { z } from "zod";
import { prisma } from "@research-repo/db";
import { nameMeetingFromSources } from "@research-repo/pipeline";
import { router, publicProcedure } from "./trpc";

// A Meeting groups the files uploaded together (one research session). Title is
// AI-generated from content after processing, and editable here.
export const meetingsRouter = router({
  // Create the group up front; the upload flow then attaches each file to it.
  create: publicProcedure
    .input(z.object({ title: z.string().optional(), projectId: z.string().uuid().optional() }).optional())
    .mutation(async ({ input }) => {
      const projectId =
        input?.projectId ?? (await prisma.project.findFirstOrThrow({ where: { slug: "collage-research" } })).id;
      const m = await prisma.meeting.create({ data: { projectId, title: input?.title?.trim() || null } });
      return { id: m.id };
    }),

  list: publicProcedure
    .input(z.object({ projectId: z.string().uuid().optional() }).optional())
    .query(async ({ input }) => {
      const meetings = await prisma.meeting.findMany({
        where: { projectId: input?.projectId },
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { sources: true } } },
      });
      return meetings.map((m) => ({
        id: m.id,
        title: m.title,
        sourceCount: m._count.sources,
        createdAt: m.createdAt,
      }));
    }),

  rename: publicProcedure
    .input(z.object({ id: z.string().uuid(), title: z.string().min(1).max(200) }))
    .mutation(({ input }) =>
      prisma.meeting.update({ where: { id: input.id }, data: { title: input.title.trim() } }),
    ),

  // Clear the title and let the AI re-name it from current content.
  retitle: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await prisma.meeting.update({ where: { id: input.id }, data: { title: null } });
      await nameMeetingFromSources(input.id);
      return { ok: true };
    }),
});
