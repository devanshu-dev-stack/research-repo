"use client";

import { trpc } from "@/lib/trpc";
import { Chip, SevDots, kindMeta } from "./ui";

export function InsightDetail({
  id,
  onOpenSource,
  onClose,
}: {
  id: string;
  onOpenSource: (id: string) => void;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const q = trpc.insights.get.useQuery({ id });
  const invalidate = () => {
    utils.insights.list.invalidate();
    utils.insights.kinds.invalidate();
    utils.insights.flowMap.invalidate();
  };
  const archive = trpc.insights.archive.useMutation({
    onSuccess: () => {
      invalidate();
      utils.insights.get.invalidate({ id });
    },
  });
  const del = trpc.insights.delete.useMutation({
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const ins = q.data as any;
  const m = ins ? kindMeta(ins.kind) : null;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,15,30,0.4)", zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(620px, 94vw)", maxHeight: "88vh", overflowY: "auto", background: "var(--cream)", border: "1px solid var(--line)", borderRadius: 14, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, color: "var(--muted)" }}>✕</button>
          {ins && (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => archive.mutate({ id, archived: !ins.archived })}
                disabled={archive.isPending}
                style={{ background: "#fff", color: "var(--navy)", border: "1px solid var(--line)", borderRadius: 8, padding: "7px 14px", fontSize: 13 }}
              >
                {ins.archived ? "Unarchive" : "Archive"}
              </button>
              <button
                onClick={() => {
                  if (confirm("Delete this insight permanently? This can’t be undone.")) del.mutate({ id });
                }}
                disabled={del.isPending}
                style={{ background: "#fff", color: "#c2304a", border: "1px solid #f0c8cf", borderRadius: 8, padding: "7px 14px", fontSize: 13 }}
              >
                Delete
              </button>
            </div>
          )}
        </div>

        {!ins && <div style={{ color: "var(--muted)" }}>Loading…</div>}

        {ins && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <Chip color={m!.color}>{m!.label}</Chip>
              {ins.archived && <Chip>archived</Chip>}
              {ins.frequency > 1 && <span style={{ fontSize: 12, color: "var(--muted)" }} title="How many times this came up">came up ×{ins.frequency}</span>}
              <span style={{ marginLeft: "auto" }}><SevDots n={ins.severity} /></span>
            </div>

            <h2 style={{ fontSize: 22, marginTop: 10 }}>{ins.title}</h2>
            {ins.summary && <p style={{ fontSize: 13.5, color: "#4a4636", marginTop: 8 }}>{ins.summary}</p>}

            {ins.stages.length > 0 && (
              <div style={{ marginTop: 12, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {ins.stages.map((st: any) => (
                  <span key={st.id} style={{ fontSize: 11.5, background: "#f0ecdd", color: "var(--muted)", borderRadius: 5, padding: "2px 8px" }}>{st.name}</span>
                ))}
              </div>
            )}

            <SectionLabel>Where it was said ({ins.evidence.length})</SectionLabel>
            <div style={{ display: "grid", gap: 10 }}>
              {ins.evidence.map((e: any, i: number) => (
                <div key={i} style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 5, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span>{whereLabel(e)}</span>
                    {e.sourceId && (
                      <span
                        onClick={() => onOpenSource(e.sourceId)}
                        style={{ color: "var(--blue)", cursor: "pointer", marginLeft: "auto" }}
                        title="Open the source"
                      >
                        ↳ {e.sourceName}
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 13.5, color: "#2c2a22", borderLeft: "2px solid var(--orange)", paddingLeft: 10 }}>
                    “{e.quote || "(no quote captured)"}”
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function whereLabel(e: { startMs: number | null; endMs: number | null; page: number | null; sourceType: string | null }): string {
  if (e.startMs != null) {
    return e.endMs != null ? `🕐 ${fmtMs(e.startMs)}–${fmtMs(e.endMs)}` : `🕐 ${fmtMs(e.startMs)}`;
  }
  if (e.page != null) return `page ${e.page}`;
  return e.sourceType === "video" || e.sourceType === "audio" ? "timing unavailable" : "from transcript";
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", fontWeight: 600, margin: "18px 0 8px" }}>
      {children}
    </div>
  );
}
