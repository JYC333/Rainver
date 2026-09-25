import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { authCookieHeader } from "../src/modules/auth/authCookie.js";

function config(frontendUrl: string): ServerConfig {
  return { frontendUrl } as ServerConfig;
}

describe("Rainver auth cookies", () => {
  it("keeps local HTTP cookies usable without weakening HTTPS cookies", () => {
    const local = authCookieHeader(config("http://localhost:5173"), { name: "rainver.test", value: "a/b c", maxAgeSeconds: 600 });
    expect(local).toBe("rainver.test=a%2Fb%20c; Max-Age=600; Path=/; HttpOnly; SameSite=Lax");
    expect(local).not.toContain("; Secure");

    const production = authCookieHeader(config("https://rainver.example"), { name: "rainver.test", value: "", maxAgeSeconds: 0 });
    expect(production).toBe("rainver.test=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure");
  });
});
