"use client";

import { trpc } from "@/lib/trpc";
import { personaColor, cardStyle } from "./ui";

type Stage = {
  id: string;
  name: string;
  persona: string;
  parentId: string | null;
  position: number;
  sources: number;
  insights: number;
};

const PERSONA_LABEL: Record<string, string> = {
  faculty: "Faculty",
  student: "Student",
  both: "Shared",
};

export function FlowMapView({ onStage }: { onStage: (s: { id: string; name: string }) => void }) {
  const flow = trpc.insights.flowMap.useQuery({});
  const stages = (flow.data ?? []) as Stage[];

  const roots = stages.filter((s) => !s.parentId);
  const childrenOf = (id: string) => stages.filter((s) => s.parentId === id);

  // Group root stages by persona.
  const personas = ["faculty", "student", "both"].filter((p) => roots.some((r) => r.persona === p));

  return (
    <>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 30 }}>Flow Map</h1>
        <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
          {flow.isLoading ? "Loading…" : `${stages.length} stages · tap a stage to see its insights`}
        </div>
      </header>

      {personas.map((p) => (
        <section key={p} style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 16, color: personaColor(p), marginBottom: 10 }}>{PERSONA_LABEL[p] ?? p}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
            {roots
              .filter((r) => r.persona === p)
              .map((root) => {
                const kids = childrenOf(root.id);
                return (
                  <div key={root.id} style={{ ...cardStyle, padding: 14 }}>
                    <StageRow stage={root} onStage={onStage} bold />
                    {kids.length > 0 && (
                      <div style={{ marginTop: 8, display: "grid", gap: 4, paddingLeft: 4, borderLeft: "2px solid #f0ecdd" }}>
                        {kids.map((k) => (
                          <StageRow key={k.id} stage={k} onStage={onStage} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </section>
      ))}
    </>
  );
}

function StageRow({
  stage,
  onStage,
  bold,
}: {
  stage: Stage;
  onStage: (s: { id: string; name: string }) => void;
  bold?: boolean;
}) {
  const tagged = stage.sources + stage.insights > 0;
  return (
    <div
      onClick={() => onStage({ id: stage.id, name: stage.name })}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        borderRadius: 6,
        cursor: "pointer",
        background: bold ? "var(--cream)" : "transparent",
        opacity: tagged ? 1 : 0.55,
      }}
    >
      <span style={{ fontSize: 13, fontWeight: bold ? 600 : 400 }}>{stage.name}</span>
      <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <Count n={stage.insights} label="insights" color="var(--orange)" />
        <Count n={stage.sources} label="sources" color="var(--blue)" />
      </span>
    </div>
  );
}

function Count({ n, label, color }: { n: number; label: string; color: string }) {
  if (!n) return null;
  return (
    <span title={`${n} ${label}`} style={{ fontSize: 11, fontWeight: 600, color, background: "#fff", border: `1px solid ${color}`, borderRadius: 999, padding: "1px 7px" }}>
      {n}
    </span>
  );
}
