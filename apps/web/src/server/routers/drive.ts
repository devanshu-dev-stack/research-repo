import { z } from "zod";
import { prisma } from "@research-repo/db";
import { isDriveConfigured } from "@research-repo/pipeline";
import { enqueueDriveSync } from "../queue";
import { router, publicProcedure } from "./trpc";

/** Accept either a raw folder id or a pasted Drive URL and pull out the id. */
function parseFolderId(input: string): string {
  const trimmed = input.trim();
  const fromPath = trimmed.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (fromPath) return fromPath[1];
  const fromQuery = trimmed.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (fromQuery) return fromQuery[1];
  return trimmed; // assume it's already a bare id
}

async function getSetting(key: string): Promise<string | null> {
  const s = await prisma.setting.findUnique({ where: { key } });
  return s?.value ?? null;
}

export const driveRouter = router({
  // Connection + sync state for the settings UI.
  status: publicProcedure.query(async () => {
    const [rootFolderId, lastSyncedAt, syncedSources] = await Promise.all([
      getSetting("drive.rootFolderId"),
      getSetting("drive.lastSyncedAt"),
      prisma.source.count({ where: { driveFileId: { not: null } } }),
    ]);
    return {
      configured: isDriveConfigured(), // OAuth creds present in env
      rootFolderId: rootFolderId ?? process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? null,
      lastSyncedAt,
      syncedSources,
    };
  }),

  // Persist which folder to mirror (accepts a full Drive URL or a bare id).
  setRootFolder: publicProcedure
    .input(z.object({ folder: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const id = parseFolderId(input.folder);
      await prisma.setting.upsert({
        where: { key: "drive.rootFolderId" },
        create: { key: "drive.rootFolderId", value: id },
        update: { value: id },
      });
      return { rootFolderId: id };
    }),

  // Trigger a sync. Throws a friendly error if OAuth isn't configured yet.
  sync: publicProcedure
    .input(z.object({ rootFolderId: z.string().optional() }).optional())
    .mutation(async ({ input }) => {
      if (!isDriveConfigured()) {
        throw new Error(
          "Google Drive isn't connected yet — add the OAuth credentials and run `pnpm drive:auth`.",
        );
      }
      return enqueueDriveSync(input?.rootFolderId);
    }),
});
