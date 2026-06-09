import type { CSSProperties, ReactNode } from "react";

export function pillColor(status: string): string {
  if (status === "ready") return "#1a7a3a";
  if (status === "failed") return "#7c7766"; // "unprocessed" — neutral, not an error
  if (status === "partial") return "#b8860b";
  return "#0382ED";
}

// User-facing status word. The DB keeps "failed", but to the team a file the
// pipeline couldn't turn into searchable content just reads as unprocessed.
export function statusLabel(status: string): string {
  if (status === "failed") return "unprocessed";
  return status;
}

// Insight kind → display label + accent color (mapped onto the brand palette).
export const KIND_META: Record<string, { label: string; color: string }> = {
  pain_point: { label: "Pain point", color: "#c2304a" },
  feature_request: { label: "Feature request", color: "#0382ED" },
  ux_friction: { label: "UX friction", color: "#FF6713" },
  positive: { label: "Positive", color: "#1a7a3a" },
  theme: { label: "Theme", color: "#8b46c9" },
  job_to_be_done: { label: "Job to be done", color: "#002341" },
  goal: { label: "Goal", color: "#0aa0c4" },
};
export function kindMeta(kind: string) {
  return KIND_META[kind] ?? { label: kind, color: "#7c7766" };
}

const PERSONA_COLOR: Record<string, string> = {
  faculty: "#0382ED",
  student: "#8b46c9",
  both: "#7c7766",
};
export function personaColor(p: string): string {
  return PERSONA_COLOR[p] ?? "#7c7766";
}

export function Chip({
  children,
  color,
  onClick,
  title,
}: {
  children: ReactNode;
  color?: string;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <span
      onClick={onClick}
      title={title}
      style={{
        fontSize: 11,
        background: "var(--cream)",
        border: `1px solid ${color ?? "var(--line)"}`,
        color: color ?? "#4a4636",
        borderRadius: 6,
        padding: "2px 8px",
        whiteSpace: "nowrap",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      {children}
    </span>
  );
}

export function SevDots({ n }: { n: number | null | undefined }) {
  const sev = n ?? 0;
  return (
    <span style={{ display: "inline-flex", gap: 2, alignItems: "center" }} title={`severity ${sev}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          style={{ width: 6, height: 6, borderRadius: 3, background: i <= sev ? "var(--orange)" : "#e4dfce" }}
        />
      ))}
    </span>
  );
}

export const cardStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid var(--line)",
  borderRadius: 10,
};
