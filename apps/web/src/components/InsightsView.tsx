"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Chip, SevDots, kindMeta, cardStyle } from "./ui";

export function InsightsView({
  onOpenSource,
  stageFilter,
  onClearStage,
}: {
  onOpenSource: (id: string) => void;
  stageFilter: { id: string; name: string } | null;
  onClearStage: () => void;
}) {
  const [kind, setKind] = useState<string | null>(null);
  const kinds = trpc.insights.kinds.useQuery({});
  const insights = trpc.insights.list.useQuery({
    kind: kind ?? undefined,
    stageId: stageFilter?.id,
    limit: 100,
  });

  const rows = insights.data ?? [];
  const total = (kinds.data ?? []).reduce((n, k) => n + k.count, 0);

  return (
    <>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 30 }}>Insights</h1>
        <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
          {insights.isLoading ? "Loading…" : `${rows.length} shown`}
          {stageFilter && (
            <>
              {" · filtered by "}
              <Chip color="#0382ED" onClick={onClearStage}>
                {stageFilter.name} ✕
              </Chip>
            </>
          )}
        </div>
      </header>

      {/* Kind filter chips */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        <FilterChip active={!kind} onClick={() => setKind(null)} label="All" count={total} />
        {(kinds.data ?? []).map((k) => {
          const m = kindMeta(k.kind);
          return (
            <FilterChip
              key={k.kind}
              active={kind === k.kind}
              onClick={() => setKind(k.kind)}
              label={m.label}
              count={k.count}
              color={m.color}
            />
          );
        })}
      </div>

      {rows.length === 0 && !insights.isLoading && (
        <div style={{ ...cardStyle, padding: 40, textAlign: "center", color: "var(--muted)" }}>
          No insights yet. Upload research and let the pipeline extract them.
        </div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {rows.map((ins) => {
          const m = kindMeta(ins.kind);
          return (
            <div key={ins.id} style={{ ...cardStyle, padding: "14px 16px", borderLeft: `3px solid ${m.color}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Chip color={m.color}>{m.label}</Chip>
                  <strong style={{ fontSize: 14.5 }}>{ins.title}</strong>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                  {ins.frequency > 1 && (
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>×{ins.frequency}</span>
                  )}
                  <SevDots n={ins.severity} />
                </div>
              </div>

              {ins.summary && (
                <p style={{ fontSize: 13, color: "#4a4636", marginTop: 6 }}>{ins.summary}</p>
              )}

              {ins.evidence[0]?.quote && (
                <div style={{ marginTop: 8, fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 12.5, color: "#4a4636", borderLeft: "2px solid var(--orange)", paddingLeft: 9 }}>
                  “{ins.evidence[0].quote}”
                </div>
              )}

              <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {ins.stages.map((st: any) => (
                  <Chip key={st.id}>{st.name}</Chip>
                ))}
                {ins.sources.map((src) => (
                  <Chip key={src.id} color="#0382ED" onClick={() => onOpenSource(src.id)} title="Open source">
                    ↳ {src.name}
                  </Chip>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
  color,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        border: `1px solid ${active ? color ?? "var(--navy)" : "var(--line)"}`,
        background: active ? color ?? "var(--navy)" : "#fff",
        color: active ? "#fff" : "#4a4636",
        borderRadius: 999,
        padding: "5px 12px",
        fontSize: 12.5,
        fontWeight: 500,
      }}
    >
      {label} <span style={{ opacity: 0.7 }}>{count}</span>
    </button>
  );
}
