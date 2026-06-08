import { createHash } from "node:crypto";
import { prisma } from "@research-repo/db";
import { detectSourceType, extensionOf } from "@research-repo/core";
import type { drive_v3 } from "googleapis";
import { getDriveClient, isDriveConfigured } from "./client";
import { originalKey, putObjectBytes } from "../storage";

const FOLDER_MIME = "application/vnd.google-apps.folder";

// Google-native docs can't be downloaded as bytes — they must be exported to a
// concrete format the pipeline understands. Everything else downloads as-is.
const EXPORT_MAP: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "text/plain", ext: "txt" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: "csv" },
  "application/vnd.google-apps.presentation": { mime: "application/pdf", ext: "pdf" },
};

export interface DriveSyncResult {
  rootFolderId: string;
  createdSourceIds: string[]; // newly ingested — caller enqueues the pipeline
  skipped: number; // already synced (loop guard) or content duplicate
  errors: { file: string; message: string }[];
  meetings: number; // meetings created or matched this run
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string | null;
  shortcutDetails?: { targetId?: string | null; targetMimeType?: string | null } | null;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Drive names can contain path-/object-key-hostile characters (Meet recordings
// are named like "… - 2026/06/04 14:00 EDT - Recording"). Keep it readable.
const sanitizeName = (n: string) => n.replace(/[\\/:*?"<>|]+/g, "-").trim() || "untitled";

/**
 * Mirror a Google Drive folder into the repository. Layout convention:
 *   root/<subfolder>/<files…>  → each subfolder becomes a Meeting,
 *   root/<loose files…>        → grouped into one Meeting bound to the root.
 * Idempotent: files already imported (by driveFileId) or whose content matches
 * an existing source (by checksum) are skipped, so re-running only picks up
 * what's new. Only the root's immediate subfolders are walked (one level deep).
 */
export async function syncDrive(
  opts: { rootFolderId?: string; projectId?: string } = {},
): Promise<DriveSyncResult> {
  if (!isDriveConfigured()) {
    throw new Error(
      "Google Drive not configured — set GOOGLE_DRIVE_CLIENT_ID / _SECRET / _REFRESH_TOKEN.",
    );
  }
  const drive = getDriveClient();
  const rootFolderId = await resolveRootFolderId(opts.rootFolderId);
  const projectId = opts.projectId ?? (await defaultProjectId());
  const result: DriveSyncResult = {
    rootFolderId,
    createdSourceIds: [],
    skipped: 0,
    errors: [],
    meetings: 0,
  };

  const children = await listChildren(drive, rootFolderId);
  const subfolders = children.filter((c) => c.mimeType === FOLDER_MIME);
  const looseFiles = children.filter((c) => c.mimeType !== FOLDER_MIME);

  // Loose files directly under root → one meeting bound to the root folder.
  if (looseFiles.length > 0) {
    const meetingId = await upsertMeeting(projectId, rootFolderId, await folderName(drive, rootFolderId));
    result.meetings++;
    for (const f of looseFiles) await ingestFile(drive, projectId, meetingId, f, result);
  }

  // Each immediate subfolder → its own meeting.
  for (const sf of subfolders) {
    const meetingId = await upsertMeeting(projectId, sf.id, sf.name);
    result.meetings++;
    const files = (await listChildren(drive, sf.id)).filter((c) => c.mimeType !== FOLDER_MIME);
    for (const f of files) await ingestFile(drive, projectId, meetingId, f, result);
  }

  const now = new Date().toISOString();
  await prisma.setting.upsert({
    where: { key: "drive.lastSyncedAt" },
    create: { key: "drive.lastSyncedAt", value: now },
    update: { value: now },
  });
  return result;
}

async function ingestFile(
  drive: drive_v3.Drive,
  projectId: string,
  meetingId: string,
  f: DriveFile,
  result: DriveSyncResult,
): Promise<void> {
  // Resolve a shortcut (alias) to the file it points at, and ingest that
  // target instead. Dedupe on the target id so a shortcut and a direct copy of
  // the same file don't both import.
  let fileId = f.id;
  let mimeType = f.mimeType;
  let name = sanitizeName(f.name);
  if (mimeType === "application/vnd.google-apps.shortcut") {
    const target = f.shortcutDetails;
    if (!target?.targetId || !target.targetMimeType) {
      result.skipped++; // dangling shortcut
      return;
    }
    fileId = target.targetId;
    mimeType = target.targetMimeType;
  }

  // Loop guard: this Drive file (target) was already imported.
  if (await prisma.source.findUnique({ where: { driveFileId: fileId }, select: { id: true } })) {
    result.skipped++;
    return;
  }

  // Fetch bytes (export for Google-native docs; skip types with no export).
  let bytes: Buffer;
  let mime: string;
  const exp = EXPORT_MAP[mimeType];
  try {
    if (exp) {
      const res = await drive.files.export(
        { fileId, mimeType: exp.mime },
        { responseType: "arraybuffer" },
      );
      bytes = Buffer.from(res.data as ArrayBuffer);
      mime = exp.mime;
      if (!name.toLowerCase().endsWith(`.${exp.ext}`)) name = `${name}.${exp.ext}`;
    } else if (mimeType.startsWith("application/vnd.google-apps")) {
      result.skipped++; // forms, drawings, folder shortcuts — nothing to ingest
      return;
    } else {
      const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" },
      );
      bytes = Buffer.from(res.data as ArrayBuffer);
      mime = mimeType || "application/octet-stream";
    }
  } catch (err) {
    result.errors.push({ file: f.name, message: msg(err) });
    return;
  }

  const checksum = createHash("sha256").update(bytes).digest("hex");

  // Content dedupe: same bytes already in the repo (e.g. uploaded by hand).
  // Adopt it into Drive tracking so future syncs skip it via the loop guard.
  const dup = await prisma.source.findUnique({
    where: { checksumSha256: checksum },
    select: { id: true },
  });
  if (dup) {
    await prisma.source
      .update({ where: { id: dup.id }, data: { driveFileId: f.id } })
      .catch(() => {});
    result.skipped++;
    return;
  }

  const sourceType = detectSourceType(mime, extensionOf(name));
  const source = await prisma.source.create({
    data: {
      projectId,
      meetingId,
      sourceType,
      status: "pending",
      originalName: name,
      storageKey: "", // set after the object is written (needs the source id)
      mimeType: mime,
      byteSize: BigInt(bytes.length),
      checksumSha256: checksum,
      driveFileId: fileId,
      recordedAt: f.modifiedTime ? new Date(f.modifiedTime) : undefined,
      metadata: { source: "google-drive", driveFileId: fileId, driveItemId: f.id },
    },
  });

  const key = originalKey(projectId, source.id, name);
  try {
    await putObjectBytes(key, bytes, mime);
  } catch (err) {
    // Couldn't persist the bytes — roll back the row so it isn't a dead source.
    await prisma.source.delete({ where: { id: source.id } }).catch(() => {});
    result.errors.push({ file: f.name, message: `storage write failed: ${msg(err)}` });
    return;
  }
  await prisma.source.update({ where: { id: source.id }, data: { storageKey: key } });
  result.createdSourceIds.push(source.id);
}

/** List a folder's immediate children (paginated; shared-drive aware). */
async function listChildren(drive: drive_v3.Drive, folderId: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, modifiedTime, shortcutDetails(targetId, targetMimeType))",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name && f.mimeType) {
        out.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          modifiedTime: f.modifiedTime,
          shortcutDetails: f.shortcutDetails,
        });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

async function folderName(drive: drive_v3.Drive, folderId: string): Promise<string> {
  try {
    const res = await drive.files.get({ fileId: folderId, fields: "name", supportsAllDrives: true });
    return res.data.name ?? "Drive";
  } catch {
    return "Drive";
  }
}

/** Find-or-create a meeting for a Drive folder, keyed by driveFolderId. */
async function upsertMeeting(
  projectId: string,
  driveFolderId: string,
  title: string,
): Promise<string> {
  // Already linked to this folder.
  const linked = await prisma.meeting.findUnique({
    where: { driveFolderId },
    select: { id: true },
  });
  if (linked) return linked.id;

  // Adopt an existing same-titled meeting that isn't yet Drive-linked (e.g. one
  // created by a manual upload of the same session) instead of duplicating it.
  const cleanTitle = title.trim();
  if (cleanTitle) {
    const sameName = await prisma.meeting.findFirst({
      where: { projectId, title: cleanTitle, driveFolderId: null },
      select: { id: true },
    });
    if (sameName) {
      await prisma.meeting.update({ where: { id: sameName.id }, data: { driveFolderId } });
      return sameName.id;
    }
  }

  const m = await prisma.meeting.create({
    data: { projectId, driveFolderId, title: cleanTitle || null },
  });
  return m.id;
}

async function resolveRootFolderId(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const setting = await prisma.setting.findUnique({ where: { key: "drive.rootFolderId" } });
  if (setting?.value) return setting.value;
  const env = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (env) return env;
  throw new Error(
    "No Drive root folder set — configure it in the app or set GOOGLE_DRIVE_ROOT_FOLDER_ID.",
  );
}

let _defaultProjectId: string | null = null;
async function defaultProjectId(): Promise<string> {
  if (_defaultProjectId) return _defaultProjectId;
  const p = await prisma.project.findFirst({ where: { slug: "collage-research" } });
  if (!p) throw new Error("Default project not found — run the db seed first.");
  _defaultProjectId = p.id;
  return p.id;
}
