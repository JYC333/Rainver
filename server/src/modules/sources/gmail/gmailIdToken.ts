/**
 * Google account identity from the ID token of the authorization-code
 * exchange. The token arrives in the direct TLS response from the fixed
 * `oauth2.googleapis.com` endpoint to this server (never through the browser),
 * which is the case where Google's OpenID guidance allows validating the claims
 * without a JWKS signature check. `iss`, `aud`, `exp` and `sub` are required.
 */
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const SUBJECT = /^[\x21-\x7e]{1,255}$/;
const CLOCK_SKEW_S = 60;

export function googleSubjectFromIdToken(idToken: string | null, clientId: string, nowMs = Date.now()): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  let claims: Record<string, unknown>;
  try {
    const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    claims = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const now = Math.floor(nowMs / 1000);
  const aud = claims.aud;
  const audienceOk = aud === clientId || (Array.isArray(aud) && aud.length === 1 && aud[0] === clientId);
  if (!audienceOk || typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) return null;
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now) return null;
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > now) return null;
  if (claims.azp !== undefined && claims.azp !== clientId) return null;
  return typeof claims.sub === "string" && SUBJECT.test(claims.sub) ? claims.sub : null;
}
