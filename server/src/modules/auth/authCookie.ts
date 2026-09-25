import type { ServerConfig } from "../../config.js";

export interface AuthCookieOptions {
  name: string;
  value: string;
  maxAgeSeconds: number;
}

/**
 * Serialize Rainver-owned auth cookies from the configured browser origin.
 * Better Auth owns its own cookie serialization; this helper keeps the
 * registration and reauthentication cookies consistent with that origin.
 */
export function authCookieHeader(config: ServerConfig, options: AuthCookieOptions): string {
  const secure = new URL(config.frontendUrl).protocol === "https:" ? "; Secure" : "";
  return `${options.name}=${encodeURIComponent(options.value)}; Max-Age=${options.maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}
