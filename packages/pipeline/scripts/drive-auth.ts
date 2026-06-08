/**
 * One-time Google Drive consent flow. Run with `pnpm drive:auth`.
 *
 * Requires GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET in your env
 * (the repo-root .env is loaded automatically). Opens a localhost listener,
 * prints a consent URL, and on approval exchanges the code for a refresh token
 * which it prints for you to paste into .env as GOOGLE_DRIVE_REFRESH_TOKEN.
 *
 * No secrets leave your machine: the token round-trips between Google and the
 * loopback server only.
 */
import { config } from "dotenv";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";

// Load the repo-root .env regardless of where the script is invoked from
// (pnpm runs it with cwd = packages/pipeline, which has no .env of its own).
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env") });

import {
  DRIVE_OAUTH_PORT,
  DRIVE_OAUTH_REDIRECT,
  DRIVE_SCOPE,
  makeOAuthClient,
} from "../src/drive/client";

async function main() {
  const auth = makeOAuthClient(DRIVE_OAUTH_REDIRECT);
  const url = auth.generateAuthUrl({
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force a refresh token even on re-auth
    scope: [DRIVE_SCOPE],
  });

  console.log("\n1. Open this URL in a browser signed in as the Drive owner:\n");
  console.log(`   ${url}\n`);
  console.log("2. Approve access. You'll be redirected back here automatically.\n");

  const code = await waitForCode();
  const { tokens } = await auth.getToken(code);

  if (!tokens.refresh_token) {
    console.error(
      "\n✗ No refresh token returned. Revoke the app at https://myaccount.google.com/permissions",
    );
    console.error("  and run this again (Google only issues one on first consent).\n");
    process.exit(1);
  }

  console.log("\n✓ Success. Add this line to your repo-root .env:\n");
  console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  process.exit(0);
}

/** Spin up the loopback server, resolve with the OAuth `code` query param. */
function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", DRIVE_OAUTH_REDIRECT);
      if (u.pathname !== "/oauth2callback") {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:system-ui;padding:2rem">${
          code ? "✓ Authorized. You can close this tab and return to the terminal." : `✗ ${err ?? "No code returned."}`
        }</body></html>`,
      );
      server.close();
      if (code) resolve(code);
      else reject(new Error(err ?? "No authorization code returned."));
    });
    server.listen(DRIVE_OAUTH_PORT, () => {
      console.log(`(listening on ${DRIVE_OAUTH_REDIRECT})`);
    });
    server.on("error", reject);
  });
}

main().catch((err) => {
  console.error("\n✗ Auth failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
