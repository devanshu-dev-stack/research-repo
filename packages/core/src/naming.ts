// Canonical filename: [research-type]_[participant-or-source]_[date]_[topic].ext
// Pure functions — no I/O. Duplicate handling lives in the ingest stage
// (checksum unique constraint + name-collision suffixing).

const SOURCE_TYPE_PREFIX: Record<string, string> = {
  survey: "survey",
  video: "interview",
  audio: "interview",
  transcript: "transcript",
  note: "note",
  pdf: "doc",
  doc: "doc",
  image: "image",
  other: "source",
};

/** lowercase, ASCII, hyphenated, punctuation stripped, collapsed dashes. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60);
}

/** Normalize to YYYY-MM-DD, or YYYY-MM when only a month is meaningful (surveys). */
export function formatDate(d: Date, granularity: "day" | "month" = "day"): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  if (granularity === "month") return `${y}-${m}`;
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function extensionOf(originalName: string): string {
  const i = originalName.lastIndexOf(".");
  return i >= 0 ? originalName.slice(i + 1).toLowerCase() : "";
}

export interface CanonicalNameInput {
  sourceType: string;
  participant?: string | null;
  source?: string | null; // fallback when no participant (e.g. "nps", "support")
  date?: Date | null;
  topic?: string | null;
  originalName: string;
}

/** Build the canonical name; segments that resolve empty are dropped cleanly. */
export function canonicalName(input: CanonicalNameInput): string {
  const prefix = SOURCE_TYPE_PREFIX[input.sourceType] ?? "source";
  const who = slugify(input.participant || input.source || "unknown");
  const granularity = input.sourceType === "survey" ? "month" : "day";
  const date = formatDate(input.date ?? new Date(), granularity);
  const topic = input.topic ? slugify(input.topic) : "";
  const ext = extensionOf(input.originalName);

  const segments = [prefix, who, date, topic].filter(Boolean);
  const base = segments.join("_");
  return ext ? `${base}.${ext}` : base;
}

/** Append ` -2`, ` -3` … before the extension on a name collision. */
export function withCollisionSuffix(name: string, n: number): string {
  if (n <= 1) return name;
  const i = name.lastIndexOf(".");
  if (i < 0) return `${name}-${n}`;
  return `${name.slice(0, i)}-${n}${name.slice(i)}`;
}
