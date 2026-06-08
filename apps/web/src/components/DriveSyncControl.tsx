"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";

/** Header control to mirror a Google Drive folder into the repository. Prompts
 *  for the folder the first time, then re-syncs (picking up only what's new). */
export function DriveSyncControl({ onSynced }: { onSynced: () => void }) {
  const status = trpc.drive.status.useQuery();
  const setRoot = trpc.drive.setRootFolder.useMutation();
  const sync = trpc.drive.sync.useMutation();
  const [busy, setBusy] = useState(false);

  const s = status.data;

  async function chooseFolder(): Promise<string | undefined> {
    const input = prompt(
      "Paste the Google Drive folder link (or its ID) to sync.\nEach sub-folder becomes a meeting; its files are imported and processed.",
      s?.rootFolderId ?? "",
    );
    if (!input?.trim()) return undefined;
    const res = await setRoot.mutateAsync({ folder: input.trim() });
    await status.refetch();
    return res.rootFolderId;
  }

  async function run() {
    if (!s?.configured) {
      alert(
        "Google Drive isn't connected yet.\n\n" +
          "Add the OAuth credentials to .env and run `pnpm drive:auth`, then restart the app.",
      );
      return;
    }
    let rootFolderId = s.rootFolderId ?? undefined;
    if (!rootFolderId) {
      rootFolderId = await chooseFolder();
      if (!rootFolderId) return;
    }

    setBusy(true);
    try {
      const res = await sync.mutateAsync({ rootFolderId });
      if (res.mode === "queued") {
        alert("Drive sync started — new files will appear here as they're processed.");
      } else {
        alert(
          `Drive sync complete:\n• ${res.created} new file(s)\n• ${res.skipped} already in sync\n• ${res.meetings} meeting(s)` +
            (res.errors?.length ? `\n• ${res.errors.length} file(s) couldn't be imported` : ""),
        );
      }
      onSynced();
      await status.refetch();
    } catch (e) {
      alert(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const lastSynced = s?.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
      <button
        onClick={run}
        disabled={busy}
        title={s?.configured ? "Pull new files from the connected Drive folder" : "Drive not connected"}
        style={{
          background: "#fff",
          color: "var(--ink, #2b2b2b)",
          border: "1px solid var(--line)",
          borderRadius: 8,
          padding: "10px 16px",
          fontWeight: 600,
          fontSize: 14,
          opacity: busy ? 0.6 : 1,
          cursor: busy ? "default" : "pointer",
          fontFamily: "var(--sans)",
        }}
      >
        {busy ? "Syncing…" : "⟳ Sync from Drive"}
      </button>
      <span style={{ fontSize: 11, color: "var(--muted)" }}>
        {!s?.configured
          ? "not connected"
          : lastSynced
            ? <>last synced {lastSynced} · <button onClick={chooseFolder} style={linkStyle}>change folder</button></>
            : s.rootFolderId
              ? <>folder set · <button onClick={chooseFolder} style={linkStyle}>change</button></>
              : "no folder chosen yet"}
      </span>
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--orange)",
  fontSize: 11,
  padding: 0,
  cursor: "pointer",
  textDecoration: "underline",
  fontFamily: "var(--sans)",
};
