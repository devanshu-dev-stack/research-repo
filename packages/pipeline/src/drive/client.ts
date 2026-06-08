import { google, type drive_v3 } from "googleapis";

// Read-only scope: we mirror Drive → app, never write back. If write-back is
// ever added, broaden to "https://www.googleapis.com/auth/drive" and re-consent.
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

// Loopback redirect used by the one-time `pnpm drive:auth` consent flow.
// Desktop OAuth clients accept any localhost port without pre-registration.
export const DRIVE_OAUTH_PORT = 53682;
export const DRIVE_OAUTH_REDIRECT = `http://127.0.0.1:${DRIVE_OAUTH_PORT}/oauth2callback`;

/** True only when all three OAuth env vars are present (client + refresh token). */
export function isDriveConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_DRIVE_CLIENT_ID &&
      process.env.GOOGLE_DRIVE_CLIENT_SECRET &&
      process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
  );
}

// Instance type of the OAuth2 client, named via googleapis (a direct dep) so
// the inferred type doesn't leak the transitive google-auth-library path.
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

/** Build an OAuth2 client. Pass a redirect only for the interactive consent
 *  flow; the synced runtime uses a stored refresh token and needs none. */
export function makeOAuthClient(redirectUri?: string): OAuth2Client {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Google Drive OAuth client not configured — set GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET.",
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/** Authenticated Drive v3 client backed by the stored refresh token. */
export function getDriveClient(): drive_v3.Drive {
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error(
      "Google Drive refresh token missing — run `pnpm drive:auth` and set GOOGLE_DRIVE_REFRESH_TOKEN.",
    );
  }
  const auth = makeOAuthClient();
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: "v3", auth });
}
