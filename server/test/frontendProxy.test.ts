import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The production web image is the only public entrypoint of a hosted
// instance, so what its nginx forwards to the server is a security boundary
// as much as a routing table. Pinned here because the first hosted instance
// found the gap the hard way: the daemon's WebSocket path fell through to the
// SPA fallback and every pairing died with a 1006 before hello.
const nginxConf = readFileSync(join(import.meta.dirname, "..", "..", "apps", "web", "nginx.conf"), "utf8");

function locationBlock(matcher: string): string {
  const start = nginxConf.indexOf(`location ${matcher} {`);
  expect(start, `no location block for ${matcher}`).toBeGreaterThan(-1);
  return nginxConf.slice(start, nginxConf.indexOf("\n    }", start));
}

describe("production nginx proxy", () => {
  it("forwards the API with WebSocket upgrade to the server service", () => {
    const api = locationBlock("/api/");
    expect(api).toContain("proxy_pass http://server:8010;");
    expect(api).toContain('proxy_set_header Connection "upgrade";');
  });

  it("forwards the paired-host daemon WebSocket by exact path", () => {
    const ws = locationBlock("= /internal/hosts/ws");
    expect(ws).toContain("proxy_pass http://server:8010;");
    expect(ws).toContain("proxy_set_header Upgrade $http_upgrade;");
    expect(ws).toContain('proxy_set_header Connection "upgrade";');
  });

  it("exposes nothing else under /internal", () => {
    const internalLocations = [...nginxConf.matchAll(/location\s+(=\s+)?(\S*\/internal\S*)\s*\{/g)].map((m) => `${m[1] ?? ""}${m[2]}`);
    expect(internalLocations).toEqual(["= /internal/hosts/ws"]);
  });
});
