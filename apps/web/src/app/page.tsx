"use client";

import { useState } from "react";
import { RepositoryView } from "@/components/RepositoryView";
import { InsightsView } from "@/components/InsightsView";
import { FlowMapView } from "@/components/FlowMapView";
import { SourceDrawer } from "@/components/SourceDrawer";

type View = "repository" | "insights" | "flowmap";

const NAV: { key: View; label: string }[] = [
  { key: "repository", label: "Repository" },
  { key: "insights", label: "Insights" },
  { key: "flowmap", label: "Flow Map" },
];

export default function App() {
  const [view, setView] = useState<View>("repository");
  const [openSource, setOpenSource] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<{ id: string; name: string } | null>(null);

  function goInsightsForStage(s: { id: string; name: string }) {
    setStageFilter(s);
    setView("insights");
  }

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
          {NAV.map((n) => {
            const active = view === n.key;
            return (
              <button
                key={n.key}
                onClick={() => {
                  setView(n.key);
                  if (n.key !== "insights") setStageFilter(null);
                }}
                style={{
                  textAlign: "left",
                  background: active ? "#0b3252" : "transparent",
                  color: active ? "var(--cream)" : "#b9c6d4",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "none",
                  fontSize: 14,
                  fontFamily: "var(--sans)",
                }}
              >
                {n.label}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Main */}
      <main style={{ padding: "28px 32px" }}>
        {view === "repository" && <RepositoryView onOpenSource={setOpenSource} />}
        {view === "insights" && (
          <InsightsView
            onOpenSource={setOpenSource}
            stageFilter={stageFilter}
            onClearStage={() => setStageFilter(null)}
          />
        )}
        {view === "flowmap" && <FlowMapView onStage={goInsightsForStage} />}
      </main>

      {openSource && <SourceDrawer id={openSource} onClose={() => setOpenSource(null)} />}
    </div>
  );
}
