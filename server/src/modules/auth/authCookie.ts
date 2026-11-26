import type { ServerConfig } from "../../config.js";

interface AuthCookieOptions {
  name: string;
  value: string;
  /** `null` issues a browser-session cookie with no lifetime of its own. */
  maxAgeSeconds: number | null;
  /** The value is already cookie-safe and is sent as given. */
  encoded?: boolean;
}

/**
 * Serialize Rainver-owned auth cookies from the configured browser origin.
 * Better Auth owns its own cookie serialization; this helper keeps the
 * registration, reauthentication and browser-account cookies consistent with
 * that origin.
 */
export function authCookieHeader(config: ServerConfig, options: AuthCookieOptions): string {
  const secure = new URL(config.frontendUrl).protocol === "https:" ? "; Secure" : "";
  const value = options.encoded ? options.value : encodeURIComponent(options.value);
  const lifetime = options.maxAgeSeconds === null ? "" : `; Max-Age=${options.maxAgeSeconds}`;
  return `${options.name}=${value}${lifetime}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}
