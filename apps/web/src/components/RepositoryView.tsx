"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Chip, pillColor, cardStyle } from "./ui";
import { UploadModal } from "./UploadModal";

export function RepositoryView({ onOpenSource }: { onOpenSource: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const utils = trpc.useUtils();

  const search = trpc.search.query.useQuery(
    // Repository shows everything you've uploaded — including pending/processing —
    // so a file appears immediately with its live status (search defaults to
    // ready/partial only, which would hide an in-progress upload).
    {
      q,
      filters: { statuses: ["pending", "processing", "ready", "partial", "failed"] },
      mode: "hybrid",
      limit: 25,
    },
    { refetchInterval: 5000 }, // poll so pending → processing → ready shows up live
  );

  const sources = search.data?.sources ?? [];

  return (
    <>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 30 }}>Repository</h1>
          <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
            {search.isLoading ? "Loading…" : `${sources.length} files`} · everything you’ve uploaded, with its status
          </div>
        </div>
        <button
          onClick={() => setShowUpload(true)}
          style={{ background: "var(--orange)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 600, fontSize: 14 }}
        >
          + Upload
        </button>
      </header>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search across everything — by keyword or meaning"
        style={{ width: "100%", maxWidth: 480, padding: "10px 14px", border: "1px solid var(--line)", borderRadius: 8, marginBottom: 20, background: "#fff" }}
      />

      <div style={{ ...cardStyle, overflow: "hidden" }}>
        {sources.length === 0 && !search.isLoading && (
          <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
            Nothing here yet. Click <strong>+ Upload</strong> to add a meeting’s files.
          </div>
        )}
        {sources.map((s) => (
          <div
            key={s.id}
            onClick={() => onOpenSource(s.id)}
            style={{ padding: "14px 16px", borderBottom: "1px solid #f0ecdd", cursor: "pointer" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <strong style={{ fontSize: 14 }}>{s.topic || s.originalName}</strong>
              <span style={{ fontSize: 11, color: pillColor(s.status), fontWeight: 600 }} title={statusHelp(s.status)}>
                {s.status}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>
              {s.canonicalName || s.originalName} · {s.sourceType}
              {s.sentiment ? ` · ${s.sentiment}` : ""}
            </div>
            {s.flowStages.length > 0 && (
              <div style={{ marginTop: 6, display: "flex", gap: 4, flexWrap: "wrap" }}>
                {s.flowStages.map((fs) => (
                  <Chip key={fs.id}>{fs.name}</Chip>
                ))}
              </div>
            )}
            {s.snippets.length > 0 && (
              <div style={{ marginTop: 8, fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 12.5, color: "#4a4636", borderLeft: "2px solid var(--orange)", paddingLeft: 9 }}>
                “{s.snippets[0].text.slice(0, 160)}”
              </div>
            )}
          </div>
        ))}
      </div>

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onDone={() => utils.search.query.invalidate()}
        />
      )}
    </>
  );
}

function statusHelp(status: string): string {
  switch (status) {
    case "ready": return "Fully processed — searchable, tagged, insights extracted";
    case "processing": return "Being transcribed, chunked, and analyzed";
    case "partial": return "Usable, but a step didn't finish (often the daily AI quota) — re-run it later";
    case "failed": return "Couldn't be processed — check the file and re-run";
    default: return "Waiting to be processed";
  }
}
