"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { pillColor, cardStyle } from "./ui";
import { UploadModal } from "./UploadModal";

type Src = {
  id: string;
  status: string;
  sourceType: string;
  originalName: string;
  canonicalName: string | null;
  topic: string | null;
  sentiment: string | null;
  meeting: { id: string; title: string | null } | null;
  snippets: { text: string }[];
};

const ALL_STATUSES = ["pending", "processing", "ready", "partial", "failed"] as const;

export function RepositoryView({ onOpenSource }: { onOpenSource: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const utils = trpc.useUtils();

  const search = trpc.search.query.useQuery(
    { q, filters: { statuses: [...ALL_STATUSES] }, mode: "hybrid", limit: 50 },
    { refetchInterval: 5000 }, // pending → processing → ready shows up live
  );
  const del = trpc.sources.delete.useMutation({
    onSuccess: () => utils.search.query.invalidate(),
  });

  const sources = (search.data?.sources ?? []) as Src[];

  // Group files under their meeting (preserving recency order); loose files last.
  const groups: { key: string; title: string; items: Src[] }[] = [];
  const idx = new Map<string, number>();
  for (const s of sources) {
    const key = s.meeting?.id ?? "__ungrouped__";
    if (!idx.has(key)) {
      idx.set(key, groups.length);
      groups.push({
        key,
        title: s.meeting ? s.meeting.title ?? "Untitled meeting (naming…)" : "Ungrouped files",
        items: [],
      });
    }
    groups[idx.get(key)!].items.push(s);
  }

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function remove(e: React.MouseEvent, s: Src) {
    e.stopPropagation();
    if (confirm(`Remove “${s.topic || s.originalName}”?\nThis deletes the file and any insights from it. This can’t be undone.`)) {
      del.mutate({ id: s.id });
    }
  }

  return (
    <>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 30 }}>Repository</h1>
          <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
            {search.isLoading ? "Loading…" : `${sources.length} files in ${groups.length} group${groups.length === 1 ? "" : "s"}`} · grouped by meeting
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

      {groups.length === 0 && !search.isLoading && (
        <div style={{ ...cardStyle, padding: 40, textAlign: "center", color: "var(--muted)" }}>
          Nothing here yet. Click <strong>+ Upload</strong> to add a meeting’s files.
        </div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          return (
            <div key={g.key} style={{ ...cardStyle, overflow: "hidden" }}>
              {/* Meeting header (the dropdown) */}
              <button
                onClick={() => toggle(g.key)}
                style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 10, background: "var(--cream)", border: "none", borderBottom: isCollapsed ? "none" : "1px solid var(--line)", padding: "12px 16px", cursor: "pointer", fontFamily: "var(--sans)" }}
              >
                <span style={{ color: "var(--muted)", fontSize: 12, width: 12 }}>{isCollapsed ? "▸" : "▾"}</span>
                <span style={{ fontWeight: 600, fontSize: 14, fontFamily: "var(--serif)" }}>{g.title}</span>
                <span style={{ fontSize: 11, color: "var(--muted)", background: "#fff", border: "1px solid var(--line)", borderRadius: 999, padding: "1px 8px" }}>
                  {g.items.length} file{g.items.length === 1 ? "" : "s"}
                </span>
              </button>

              {/* Files in this meeting */}
              {!isCollapsed &&
                g.items.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => onOpenSource(s.id)}
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, padding: "12px 16px 12px 38px", borderBottom: "1px solid #f5f1e4", cursor: "pointer" }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <strong style={{ fontSize: 13.5 }}>{s.topic || s.originalName}</strong>
                        <span style={{ fontSize: 11, color: pillColor(s.status), fontWeight: 600 }} title={statusHelp(s.status)}>{s.status}</span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>
                        {s.canonicalName || s.originalName} · {s.sourceType}
                        {s.sentiment ? ` · ${s.sentiment}` : ""}
                      </div>
                      {s.snippets.length > 0 && (
                        <div style={{ marginTop: 7, fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 12.5, color: "#4a4636", borderLeft: "2px solid var(--orange)", paddingLeft: 9 }}>
                          “{s.snippets[0].text.slice(0, 160)}”
                        </div>
                      )}
                    </div>
                    <button
                      onClick={(e) => remove(e, s)}
                      title="Remove this file"
                      style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 14, flexShrink: 0, padding: "2px 4px" }}
                    >
                      🗑
                    </button>
                  </div>
                ))}
            </div>
          );
        })}
      </div>

      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onDone={() => utils.search.query.invalidate()} />}
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
