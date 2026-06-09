"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Chip, pillColor } from "./ui";

export function SourceDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const renameMeeting = trpc.meetings.rename.useMutation({
    onSuccess: () => {
      setEditingTitle(null);
      utils.sources.get.invalidate({ id });
      utils.meetings.list.invalidate();
    },
  });
  const src = trpc.sources.get.useQuery({ id }, { refetchInterval: (q) =>
    // keep polling while it's still processing
    q.state.data && ["pending", "processing"].includes((q.state.data as any).status) ? 3000 : false,
  });

  const s = src.data as any;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,15,30,0.35)", zIndex: 50, display: "flex", justifyContent: "flex-end" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(560px, 92vw)", height: "100%", background: "var(--cream)", borderLeft: "1px solid var(--line)", overflowY: "auto", padding: 24, boxShadow: "-12px 0 40px rgba(0,0,0,0.12)" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, color: "var(--muted)" }}>
            ✕
          </button>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {s?.driveFileId && (
              // Synced from Drive — open the original in Drive, which previews it
              // natively (video player, Doc/Sheet viewer) far better than we can.
              <a
                href={`https://drive.google.com/open?id=${s.driveFileId}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ background: "#fff", color: "var(--navy)", border: "1px solid var(--line)", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600, textDecoration: "none" }}
              >
                Open in Google Drive ↗
              </a>
            )}
          </div>
        </div>

        {!s && <div style={{ color: "var(--muted)" }}>Loading…</div>}

        {s && (
          <>
            <h2 style={{ fontSize: 24 }}>{s.topic || s.originalName}</h2>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ color: pillColor(s.status), fontWeight: 600 }}>{s.status}</span>
              <span>· {s.sourceType}</span>
              {s.participant && <span>· {s.participant}</span>}
              {s.sentiment && <span>· {s.sentiment}</span>}
              {s.byteSize != null && <span>· {formatBytes(Number(s.byteSize))}</span>}
            </div>
            {s.error && (
              <div style={{ marginTop: 10, fontSize: 12.5, color: "#c2304a", background: "#fff", border: "1px solid #f0c8cf", borderRadius: 8, padding: "8px 10px" }}>
                {s.error}
              </div>
            )}

            {s.meeting && (
              <div style={{ marginTop: 16 }}>
                <SectionLabel>Meeting</SectionLabel>
                {editingTitle !== null ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      autoFocus
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      style={{ flex: 1, padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 13 }}
                    />
                    <button
                      onClick={() => editingTitle.trim() && renameMeeting.mutate({ id: s.meeting.id, title: editingTitle.trim() })}
                      style={{ background: "var(--navy)", color: "#fff", border: "none", borderRadius: 8, padding: "0 12px", fontSize: 13 }}
                    >
                      Save
                    </button>
                    <button onClick={() => setEditingTitle(null)} style={{ background: "none", border: "1px solid var(--line)", borderRadius: 8, padding: "0 10px", fontSize: 13 }}>✕</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 500 }}>{s.meeting.title ?? "Untitled (naming…)"}</span>
                    <button
                      onClick={() => setEditingTitle(s.meeting.title ?? "")}
                      title="Rename meeting"
                      style={{ background: "none", border: "none", color: "var(--blue)", fontSize: 12 }}
                    >
                      ✎ rename
                    </button>
                  </div>
                )}
              </div>
            )}

            {s.flowTags?.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <SectionLabel>Flow stages</SectionLabel>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {s.flowTags.map((t: any) => (
                    <Chip key={t.stage?.id ?? t.stageId} title={`${Math.round((t.confidence ?? 0) * 100)}% · ${t.origin}`}>
                      {t.stage?.name ?? "—"}
                    </Chip>
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginTop: 20 }}>
              <SectionLabel>{s.chunks?.length ?? 0} chunks</SectionLabel>
              <div style={{ display: "grid", gap: 8 }}>
                {(s.chunks ?? []).map((c: any) => (
                  <div key={c.id} style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 4 }}>
                      #{c.ordinal}
                      {c.page != null ? ` · p.${c.page}` : ""}
                      {c.startMs != null ? ` · ${fmtMs(c.startMs)}` : ""}
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.5, color: "#2c2a22", whiteSpace: "pre-wrap" }}>{c.text}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", fontWeight: 600, marginBottom: 8 }}>
      {children}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
