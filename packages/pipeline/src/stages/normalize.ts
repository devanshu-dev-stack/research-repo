import { prisma } from "@research-repo/db";
import { canonicalName, type ChunkInput } from "@research-repo/core";
import { getObjectBytes } from "../storage";

export interface NormalizeResult {
  content: string;
  // Structured units carry traceability into the chunk stage.
  units: ChunkInput[];
  language?: string;
}

/**
 * Stage: normalize. Branches by source_type to produce canonical `content`
 * plus traceable `units`. Text-spine implements note/transcript/survey fully;
 * pdf/doc/audio/video/image return empty and are completed by the media
 * stages (transcribe/ocr/doc-extract) added later.
 *
 * Idempotent: it only writes scalar fields on the source row.
 */
export async function runNormalize(sourceId: string): Promise<void> {
  const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });

  let result: NormalizeResult = { content: "", units: [] };

  switch (source.sourceType) {
    case "note":
    case "transcript": {
      const bytes = await getObjectBytes(source.storageKey);
      const text = bytes.toString("utf8");
      result = { content: text, units: [{ text }] };
      break;
    }
    case "survey": {
      const bytes = await getObjectBytes(source.storageKey);
      result = parseSurvey(bytes.toString("utf8"));
      break;
    }
    // Media/doc types: consume what the `extract` stage produced.
    case "pdf":
    case "doc":
    case "image":
    case "audio":
    case "video": {
      const extracted = (source.metadata as any)?._extracted as
        | { content: string; units: ChunkInput[] }
        | undefined;
      if (extracted && (extracted.content || extracted.units?.length)) {
        result = { content: extracted.content ?? "", units: extracted.units ?? [] };
      } else {
        // extract produced nothing (e.g. provider unconfigured) → stays partial
        result = { content: source.content ?? "", units: source.content ? [{ text: source.content }] : [] };
      }
      break;
    }
    case "other":
    default:
      result = { content: source.content ?? "", units: source.content ? [{ text: source.content }] : [] };
      break;
  }

  const canonical =
    source.canonicalName ??
    canonicalName({
      sourceType: source.sourceType,
      participant: source.participant,
      source: (source.metadata as any)?.source ?? null,
      topic: source.topic,
      date: source.recordedAt ?? source.createdAt,
      originalName: source.originalName,
    });

  await prisma.source.update({
    where: { id: sourceId },
    data: {
      content: result.content,
      language: result.language ?? source.language,
      canonicalName: canonical,
      // stash units for the chunk stage without a new table
      metadata: {
        ...(source.metadata as object),
        _units: result.units,
      } as any,
    },
  });
}

/** Minimal CSV survey parser: one chunk-unit per response row, with a
 *  response_ref so insights trace back to the exact row. Dependency-free. */
export function parseSurvey(csv: string): NormalizeResult {
  const rows = csvRows(csv);
  if (rows.length === 0) return { content: "", units: [] };
  const header = rows[0];
  const units: ChunkInput[] = [];
  const contentParts: string[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const pairs = header
      .map((h, i) => (cells[i] ? `${h}: ${cells[i]}` : ""))
      .filter(Boolean);
    const text = pairs.join("\n");
    if (!text.trim()) continue;
    units.push({ text, responseRef: `row:${r}` });
    contentParts.push(text);
  }
  return { content: contentParts.join("\n\n"), units };
}

// Tiny RFC-4180-ish CSV reader (handles quotes, commas, newlines in quotes).
function csvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((x) => x !== "")) rows.push(row); }
  return rows;
}
