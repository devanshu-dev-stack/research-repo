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

type MeetingGroup = { typeIdx: number; files: { file: File; type: string }[] };

export function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [groups, setGroups] = useState<MeetingGroup[]>([{ typeIdx: 0, files: [] }]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeGroup = useRef(0);
  const activeAccept = useRef<string>("");

  const createMeeting = trpc.meetings.create.useMutation();
  const createSource = trpc.sources.create.useMutation();

  function setGroup(i: number, patch: Partial<MeetingGroup>) {
    setGroups((prev) => prev.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  }
  function openPicker(i: number) {
    activeGroup.current = i;
    activeAccept.current = TYPES[groups[i].typeIdx].accept;
    if (fileRef.current) {
      fileRef.current.accept = activeAccept.current;
      fileRef.current.click();
    }
  }
  function addPicked(files: FileList | null) {
    if (!files?.length) return;
    const i = activeGroup.current;
    const type = TYPES[groups[i].typeIdx].label;
    const added = Array.from(files).map((file) => ({ file, type }));
    setGroups((prev) => prev.map((g, j) => (j === i ? { ...g, files: [...g.files, ...added] } : g)));
    if (fileRef.current) fileRef.current.value = "";
  }

  const totalFiles = groups.reduce((n, g) => n + g.files.length, 0);
  const nonEmpty = groups.filter((g) => g.files.length > 0);

  async function upload() {
    if (nonEmpty.length === 0) return;
    setBusy(true);
    try {
      // One Meeting per non-empty group; its files upload into it.
      for (const g of nonEmpty) {
        const { id: meetingId } = await createMeeting.mutateAsync({});
        await uploadFiles(g.files.map((s) => s.file), (input) => createSource.mutateAsync(input), { meetingId });
      }
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
        style={{ width: "min(600px, 94vw)", maxHeight: "90vh", overflowY: "auto", background: "var(--cream)", border: "1px solid var(--line)", borderRadius: 14, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={{ fontSize: 22 }}>Add meetings</h2>
          <button onClick={onClose} disabled={busy} style={{ background: "none", border: "none", fontSize: 20, color: "var(--muted)" }}>✕</button>
        </div>
        <p style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
          Each meeting groups the files from one research session (a recording, notes, a survey).
          Add as many meetings as you like, then upload them all at once — each is named automatically.
        </p>

        <input ref={fileRef} type="file" multiple hidden onChange={(e) => addPicked(e.target.files)} />

        <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
          {groups.map((g, i) => (
            <div key={i} style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <strong style={{ fontSize: 14, fontFamily: "var(--serif)" }}>Meeting {i + 1}</strong>
                {groups.length > 1 && (
                  <button
                    onClick={() => setGroups((prev) => prev.filter((_, j) => j !== i))}
                    disabled={busy}
                    style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 12 }}
                  >
                    remove meeting ✕
                  </button>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <select
                  value={g.typeIdx}
                  onChange={(e) => setGroup(i, { typeIdx: Number(e.target.value) })}
                  style={{ padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#fff", fontSize: 13, flex: "1 1 180px" }}
                >
                  {TYPES.map((t, ti) => (
                    <option key={t.label} value={ti}>{t.label}</option>
                  ))}
                </select>
                <button
                  onClick={() => openPicker(i)}
                  style={{ background: "var(--navy)", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600 }}
                >
                  + Add files
                </button>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 5 }}>{TYPES[g.typeIdx].hint}</div>

              {g.files.length > 0 && (
                <div style={{ marginTop: 10, display: "grid", gap: 5 }}>
                  {g.files.map((s, fi) => (
                    <div key={fi} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: "var(--cream)", border: "1px solid var(--line)", borderRadius: 7, padding: "6px 9px" }}>
                      <span style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.file.name} <span style={{ color: "var(--muted)", fontSize: 11 }}>· {s.type}</span>
                      </span>
                      <button
                        onClick={() => setGroup(i, { files: g.files.filter((_, j) => j !== fi) })}
                        disabled={busy}
                        style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 13 }}
                      >✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <button
          onClick={() => setGroups((prev) => [...prev, { typeIdx: 0, files: [] }])}
          disabled={busy}
          style={{ marginTop: 12, width: "100%", background: "#fff", color: "var(--navy)", border: "1px dashed var(--navy)", borderRadius: 8, padding: "9px", fontSize: 13.5, fontWeight: 600 }}
        >
          + Add another meeting
        </button>

        <button
          onClick={upload}
          disabled={busy || nonEmpty.length === 0}
          style={{ marginTop: 12, width: "100%", background: "var(--orange)", color: "#fff", border: "none", borderRadius: 8, padding: "12px", fontSize: 15, fontWeight: 600, opacity: busy || nonEmpty.length === 0 ? 0.5 : 1 }}
        >
          {busy
            ? "Uploading…"
            : `Upload ${totalFiles} file${totalFiles === 1 ? "" : "s"} across ${nonEmpty.length || 0} meeting${nonEmpty.length === 1 ? "" : "s"}`}
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
