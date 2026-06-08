"use client";

import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { uploadFiles } from "@/lib/upload";
import { pillColor } from "./ui";

// Input types guide the file picker. A meeting can mix them (e.g. a recording
// + notes + a survey), so you add files in batches and they upload as one group.
const TYPES = [
  { label: "Text / notes", accept: ".txt,.md,text/plain", hint: "Plain notes, memos, markdown" },
  { label: "Document", accept: ".pdf,.doc,.docx,application/pdf", hint: "PDF or Word documents" },
  { label: "Survey / CSV", accept: ".csv,.tsv,text/csv", hint: "Spreadsheet or survey exports" },
  { label: "Image", accept: "image/*", hint: "Screenshots, whiteboards (text is read via OCR)" },
  { label: "Audio", accept: "audio/*", hint: "Recordings — transcribed automatically" },
  { label: "Video", accept: "video/*", hint: "Call recordings — audio is transcribed" },
  { label: "Anything", accept: "", hint: "Any file type" },
];

const STATUS_LEGEND = [
  { s: "processing", text: "being transcribed, chunked, and analyzed" },
  { s: "ready", text: "fully processed — searchable, tagged, insights extracted" },
  { s: "partial", text: "usable, but a step didn't finish (often the daily AI quota) — re-run it later" },
  { s: "failed", text: "couldn't be processed — check the file and re-run" },
];

export function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [typeIdx, setTypeIdx] = useState(0);
  const [staged, setStaged] = useState<{ file: File; type: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const createMeeting = trpc.meetings.create.useMutation();
  const createSource = trpc.sources.create.useMutation();

  function addPicked(files: FileList | null) {
    if (!files?.length) return;
    const type = TYPES[typeIdx].label;
    setStaged((prev) => [...prev, ...Array.from(files).map((file) => ({ file, type }))]);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function upload() {
    if (staged.length === 0) return;
    setBusy(true);
    try {
      const { id: meetingId } = await createMeeting.mutateAsync({});
      await uploadFiles(
        staged.map((s) => s.file),
        (input) => createSource.mutateAsync(input),
        { meetingId },
      );
      onDone();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,15,30,0.4)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(560px, 94vw)", maxHeight: "88vh", overflowY: "auto", background: "var(--cream)", border: "1px solid var(--line)", borderRadius: 14, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={{ fontSize: 22 }}>Add a meeting</h2>
          <button onClick={onClose} disabled={busy} style={{ background: "none", border: "none", fontSize: 20, color: "var(--muted)" }}>✕</button>
        </div>
        <p style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
          Add all the files from one research session — a recording, notes, a survey — and they’ll be
          grouped together and named automatically. Insights will trace back to this meeting.
        </p>

        {/* Step 1: choose a type, add files */}
        <div style={{ marginTop: 18, background: "#fff", border: "1px solid var(--line)", borderRadius: 10, padding: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "#4a4636" }}>1 · What are you adding?</label>
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={typeIdx}
              onChange={(e) => setTypeIdx(Number(e.target.value))}
              style={{ padding: "9px 12px", border: "1px solid var(--line)", borderRadius: 8, background: "#fff", fontSize: 14, flex: "1 1 200px" }}
            >
              {TYPES.map((t, i) => (
                <option key={t.label} value={i}>{t.label}</option>
              ))}
            </select>
            <button
              onClick={() => fileRef.current?.click()}
              style={{ background: "var(--navy)", color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 14, fontWeight: 600 }}
            >
              + Add files
            </button>
            <input ref={fileRef} type="file" multiple hidden accept={TYPES[typeIdx].accept || undefined} onChange={(e) => addPicked(e.target.files)} />
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>{TYPES[typeIdx].hint}</div>
        </div>

        {/* Step 2: staged files */}
        <div style={{ marginTop: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "#4a4636" }}>
            2 · Files in this meeting {staged.length > 0 && `(${staged.length})`}
          </label>
          {staged.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--muted)", padding: "14px 0" }}>
              No files yet — pick a type above and add one or more.
            </div>
          ) : (
            <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
              {staged.map((s, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: "#fff", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px" }}>
                  <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.file.name} <span style={{ color: "var(--muted)", fontSize: 11 }}>· {s.type}</span>
                  </span>
                  <button onClick={() => setStaged((p) => p.filter((_, j) => j !== i))} disabled={busy} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 14 }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={upload}
          disabled={busy || staged.length === 0}
          style={{ marginTop: 18, width: "100%", background: "var(--orange)", color: "#fff", border: "none", borderRadius: 8, padding: "12px", fontSize: 15, fontWeight: 600, opacity: busy || staged.length === 0 ? 0.5 : 1 }}
        >
          {busy ? "Uploading…" : `Upload ${staged.length || ""} file${staged.length === 1 ? "" : "s"} as one meeting`}
        </button>

        {/* Footer: what the statuses mean */}
        <div style={{ marginTop: 18, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", fontWeight: 600, marginBottom: 8 }}>
            What the statuses mean
          </div>
          <div style={{ display: "grid", gap: 5 }}>
            {STATUS_LEGEND.map((l) => (
              <div key={l.s} style={{ fontSize: 12, color: "#4a4636", display: "flex", gap: 8 }}>
                <span style={{ color: pillColor(l.s), fontWeight: 700, minWidth: 64 }}>{l.s}</span>
                <span>{l.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
