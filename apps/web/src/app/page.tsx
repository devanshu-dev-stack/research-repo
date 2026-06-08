"use client";

import { useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { uploadFiles } from "@/lib/upload";

export default function RepositoryPage() {
  const [q, setQ] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const utils = trpc.useUtils();

  // Search (empty query = newest sources, the repository default view).
  const search = trpc.search.query.useQuery(
    { q, filters: {}, mode: "hybrid", limit: 25 },
    { refetchInterval: 5000 }, // poll so processing → ready shows up live
  );

  const createSource = trpc.sources.create.useMutation();

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      await uploadFiles(Array.from(files), (input) =>
        createSource.mutateAsync(input),
      );
      await utils.search.query.invalidate();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const sources = search.data?.sources ?? [];

  return (
    <div style={{ minHeight: "100vh", display: "grid", gridTemplateColumns: "240px 1fr" }}>
      {/* Nav */}
      <aside style={{ background: "var(--navy)", color: "var(--cream)", padding: 24 }}>
        <div style={{ fontFamily: "var(--serif)", fontSize: 22, lineHeight: 1.1 }}>
          Research<br />Repository
          <div style={{ fontFamily: "var(--hand)", fontSize: 14, color: "var(--sky)", marginTop: 8 }}>
            everything, traceable.
          </div>
        </div>
        <nav style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
          <span style={{ background: "#0b3252", padding: "8px 10px", borderRadius: 8 }}>Repository</span>
          <span style={{ color: "#b9c6d4", padding: "8px 10px" }}>Insights</span>
          <span style={{ color: "#b9c6d4", padding: "8px 10px" }}>Flow Map</span>
        </nav>
      </aside>

      {/* Main */}
      <main style={{ padding: "28px 32px" }}>
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
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => onPick(e.target.files)}
          />
        </header>

        {/* Search */}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search research… (hybrid keyword + semantic)"
          style={{ width: "100%", maxWidth: 480, padding: "10px 14px", border: "1px solid var(--line)", borderRadius: 8, marginBottom: 20, background: "#fff" }}
        />

        {/* Results */}
        <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
          {sources.length === 0 && !search.isLoading && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
              No sources yet. Drop a .txt, .csv, .pdf, or audio/video file to begin.
            </div>
          )}
          {sources.map((s) => (
            <div key={s.id} style={{ padding: "14px 16px", borderBottom: "1px solid #f0ecdd" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <strong style={{ fontSize: 14 }}>{s.topic || s.originalName}</strong>
                <span style={{ fontSize: 11, color: pillColor(s.status), fontWeight: 600 }}>
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
                    <span key={fs.id} style={{ fontSize: 11, background: "var(--cream)", border: "1px solid var(--line)", borderRadius: 6, padding: "2px 8px" }}>
                      {fs.name}
                    </span>
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
      </main>
    </div>
  );
}

function pillColor(status: string): string {
  if (status === "ready") return "#1a7a3a";
  if (status === "failed") return "#c2304a";
  if (status === "partial") return "#b8860b";
  return "#0382ED";
}
