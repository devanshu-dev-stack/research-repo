"use client";

import { useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { uploadFiles } from "@/lib/upload";
import { Chip, pillColor, cardStyle } from "./ui";

export function RepositoryView({ onOpenSource }: { onOpenSource: (id: string) => void }) {
  const [q, setQ] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const utils = trpc.useUtils();

  const search = trpc.search.query.useQuery(
    { q, filters: {}, mode: "hybrid", limit: 25 },
    { refetchInterval: 5000 }, // poll so processing → ready shows up live
  );
  const createSource = trpc.sources.create.useMutation();

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      await uploadFiles(Array.from(files), (input) => createSource.mutateAsync(input));
      await utils.search.query.invalidate();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const sources = search.data?.sources ?? [];

  return (
    <>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 30 }}>Repository</h1>
          <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
            {search.isLoading ? "Loading…" : `${sources.length} sources`}
          </div>
        </div>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          style={{ background: "var(--orange)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 600, fontSize: 14 }}
        >
          {uploading ? "Uploading…" : "+ Upload"}
        </button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => onPick(e.target.files)} />
      </header>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search research… (hybrid keyword + semantic)"
        style={{ width: "100%", maxWidth: 480, padding: "10px 14px", border: "1px solid var(--line)", borderRadius: 8, marginBottom: 20, background: "#fff" }}
      />

      <div style={{ ...cardStyle, overflow: "hidden" }}>
        {sources.length === 0 && !search.isLoading && (
          <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
            No sources yet. Drop a .txt, .csv, .pdf, or audio/video file to begin.
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
              <span style={{ fontSize: 11, color: pillColor(s.status), fontWeight: 600 }}>{s.status}</span>
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
    </>
  );
}
