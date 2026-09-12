import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The production web image is the only public entrypoint of a hosted
// instance, so what its nginx forwards to the server is a security boundary
// as much as a routing table. Pinned here because the first hosted instance
// found the gap the hard way: the daemon's WebSocket path fell through to the
// SPA fallback and every pairing died with a 1006 before hello.
const webDir = join(import.meta.dirname, "..", "..", "apps", "web");
const nginxConf = readFileSync(join(webDir, "nginx.conf"), "utf8");
const securityHeaders = readFileSync(join(webDir, "security-headers.conf"), "utf8");
const HEADERS_INCLUDE = "include /etc/nginx/security-headers.conf;";

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

  it("never lets the app shell or the service worker be cached", () => {
    expect(locationBlock("= /index.html")).toContain('add_header Cache-Control "no-cache";');
    expect(locationBlock("= /sw.js")).toContain("no-store");
    expect(locationBlock("/assets/")).toContain("immutable");
  });

  it("exposes nothing else under /internal", () => {
    const internalLocations = [...nginxConf.matchAll(/location\s+(=\s+)?(\S*\/internal\S*)\s*\{/g)].map((m) => `${m[1] ?? ""}${m[2]}`);
    expect(internalLocations).toEqual(["= /internal/hosts/ws"]);
  });

  it("sends browser security headers on the public shell", () => {
    expect(securityHeaders).toContain('add_header X-Content-Type-Options "nosniff" always;');
    expect(securityHeaders).toContain('add_header X-Frame-Options "DENY" always;');
    expect(securityHeaders).toContain("Content-Security-Policy");
    expect(securityHeaders).toContain("frame-ancestors 'none'");
    expect(securityHeaders).toContain("Cross-Origin-Opener-Policy");
    expect(securityHeaders).toContain("Permissions-Policy");
  });

  /**
   * nginx *replaces* rather than inherits the `add_header` set as soon as a
   * location adds one of its own, so a location that sets a cache header and
   * forgets the security set serves the app shell with no CSP at all. Five
   * hand-maintained copies is how one of them came to disagree with the
   * others; the rule now is that every such location includes the one file.
   */
  it("repeats that set in every location that sets a header of its own", () => {
    expect(nginxConf).toContain(HEADERS_INCLUDE);
    const locations = [...nginxConf.matchAll(/location\s+(=\s+)?(\S+)\s*\{/g)].map((m) => `${m[1] ?? ""}${m[2]}`);
    for (const matcher of locations) {
      const block = locationBlock(matcher);
      if (!block.includes("add_header")) continue;
      expect(block, matcher).toContain(HEADERS_INCLUDE);
    }
  });

  /**
   * An `<img>` the page did not choose is a zero-click request to whatever host
   * a model named. Chat markdown renders an external image as a link instead
   * (D5), and this is the half that holds if a renderer ever slips.
   */
  it("keeps http and wildcards out of img-src, and every bare scheme out of the rest", () => {
    // `img-src https:` is deliberate and is the one place a bare scheme is
    // allowed. The Library reader renders captured articles with their own
    // remote images, so the *renderer* is the boundary for a model-authored
    // document, not this header — see `safeMarkdown.tsx` and
    // `ReadOnlyTiptapReader`'s `remoteImages`. `http:` stays out: a captured
    // article's images are https or they do not load.
    const imgSrc = (/img-src ([^;]+);/.exec(securityHeaders)?.[1] ?? "").split(/\s+/).filter(Boolean);
    expect(imgSrc.length).toBeGreaterThan(0);
    for (const source of ["http:", "*", "'unsafe-inline'"]) {
      expect(imgSrc, source).not.toContain(source);
    }
    expect(imgSrc).toContain("'self'");
    // And the property the theme script was moved out of `index.html` to
    // preserve: an inline `<script>` must stay unrunnable, or it comes back
    // silently and works in dev while doing nothing in production.
    const scriptSrc = (/script-src ([^;]+);/.exec(securityHeaders)?.[1] ?? "").split(/\s+/).filter(Boolean);
    expect(scriptSrc).toEqual(["'self'"]);
    // Nowhere but img-src may take a bare scheme.
    for (const directive of ["connect-src", "font-src", "frame-src", "object-src", "worker-src"]) {
      const sources = (new RegExp(`${directive} ([^;]+);`).exec(securityHeaders)?.[1] ?? "").split(/\s+/).filter(Boolean);
      for (const bad of ["https:", "http:", "*"]) {
        expect(sources, `${directive} ${bad}`).not.toContain(bad);
      }
    }
  });
});
