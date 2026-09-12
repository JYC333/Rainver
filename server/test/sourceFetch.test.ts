import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createOutboundGuard } from "@rainver/outbound-guard";
import { fetchSource } from "../src/modules/sources/sourceFetch.js";
import { isBlockedAddress } from "../src/modules/sources/outboundUrlSafety.js";
import { fixtureServerGuard, publicAddressGuard } from "./support/outboundGuard.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("outbound URL safety", () => {
  it("blocks loopback, RFC1918, and link-local metadata addresses", () => {
    for (const address of ["10.0.0.5", "172.17.0.2", "192.168.1.1", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1"]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
  });
});

describe("fetchSource", () => {
  it("detects PDF bytes without decoding them as text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]),
      { status: 200, headers: { "content-type": "text/plain" } },
    ));

    const result = await fetchSource("https://example.test/paper", {
      maxDownloadBytes: 1024,
      guard: publicAddressGuard,
    });

    expect(result.isPdf).toBe(true);
    expect(result.isText).toBe(false);
    expect(result.text).toBeNull();
    expect(result.bytes).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]));
  });

  it("uses URL extensions as fallback for generic text responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "<rss><channel /></rss>",
      { status: 200, headers: { "content-type": "application/octet-stream" } },
    ));

    const result = await fetchSource("https://example.test/feed.xml", {
      maxDownloadBytes: 1024,
      guard: publicAddressGuard,
    });

    expect(result.isText).toBe(true);
    expect(result.isPdf).toBe(false);
    expect(result.text).toContain("<rss>");
  });

  it("does not decode unknown binary without content type or text extension", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      new Uint8Array([0, 1, 2, 3]),
      { status: 200 },
    ));

    const result = await fetchSource("https://example.test/download", {
      maxDownloadBytes: 1024,
      guard: publicAddressGuard,
    });

    expect(result.isText).toBe(false);
    expect(result.isPdf).toBe(false);
    expect(result.text).toBeNull();
    expect(result.bytes).toEqual(new Uint8Array([0, 1, 2, 3]));
  });

  it("enforces the configured max download size", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "too large",
      { status: 200, headers: { "content-length": "5242881" } },
    ));

    await expect(fetchSource("https://example.test/read", {
      maxDownloadBytes: 5_242_880,
      guard: publicAddressGuard,
    })).rejects.toMatchObject({
      statusCode: 413,
      message: "Downloaded source exceeds max size (5 MiB)",
    });
  });

  it("refuses loopback and metadata URLs before fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(fetchSource("http://127.0.0.1/secret", { maxDownloadBytes: 1024, guard: publicAddressGuard }))
      .rejects.toMatchObject({ statusCode: 422, message: "Outbound URL is not allowed" });
    await expect(fetchSource("http://169.254.169.254/latest/meta-data", { maxDownloadBytes: 1024, guard: publicAddressGuard }))
      .rejects.toMatchObject({ statusCode: 422, message: "Outbound URL is not allowed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a public URL that redirects onto a private address", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    }));

    await expect(fetchSource("https://example.test/go", {
      maxDownloadBytes: 1024,
      guard: publicAddressGuard,
    })).rejects.toMatchObject({ statusCode: 422, message: "Outbound URL is not allowed" });
  });

  it("refuses a hostname that resolves into the instance network", async () => {
    await expect(fetchSource("https://internal.example.test/item", {
      maxDownloadBytes: 1024,
      guard: createOutboundGuard({ lookup: async () => [{ address: "10.0.0.8", family: 4 }] }),
    })).rejects.toMatchObject({ statusCode: 422, message: "Outbound URL is not allowed" });
  });
});

describe("fetchSource address pinning", () => {
  let server: Server;
  let port = 0;
  const requests: Array<{ url: string; host: string | undefined; auth: string | undefined }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push({ url: req.url ?? "", host: req.headers.host, auth: req.headers["x-api-key"] as string | undefined });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("fixture body");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  });

  afterEach(() => { requests.length = 0; });

  /**
   * The point of pinning: the socket goes to the address the guard decided on,
   * not to whatever the name resolves to when the HTTP client asks again. The
   * name here resolves nowhere, so the request can only arrive if the pinned
   * address was used — and the `Host` header still names it, so TLS and virtual
   * hosting see the real hostname.
   */
  it("connects to the pinned address instead of resolving the name again", async () => {
    const result = await fetchSource(`http://pinned.invalid:${port}/feed.xml`, {
      maxDownloadBytes: 1024,
      guard: fixtureServerGuard,
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe("fixture body");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.host).toBe(`pinned.invalid:${port}`);
  });

  it("sends a credential header to the first origin", async () => {
    await fetchSource(`http://pinned.invalid:${port}/feed.xml`, {
      maxDownloadBytes: 1024,
      credentialHeaders: { "x-api-key": "secret" },
      guard: fixtureServerGuard,
    });
    expect(requests[0]?.auth).toBe("secret");
  });
});

describe("fetchSource credentials across a redirect", () => {
  it("does not replay a credential header onto another origin", async () => {
    const seen: Array<Record<string, string>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://elsewhere.test/landing" } })
        : new Response("landed", { status: 200, headers: { "content-type": "text/plain" } });
    });

    const result = await fetchSource("https://example.test/start", {
      maxDownloadBytes: 1024,
      headers: { "if-none-match": "etag-1" },
      credentialHeaders: { "x-api-key": "secret" },
      guard: publicAddressGuard,
    });

    expect(result.text).toBe("landed");
    expect(seen[0]?.["x-api-key"]).toBe("secret");
    expect(seen[1]?.["x-api-key"]).toBeUndefined();
    expect(seen[1]?.["if-none-match"]).toBe("etag-1");
  });

  it("refuses an https to http downgrade while carrying a credential", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "http://example.test/plain" },
    }));

    await expect(fetchSource("https://example.test/start", {
      maxDownloadBytes: 1024,
      credentialHeaders: { "x-api-key": "secret" },
      guard: publicAddressGuard,
    })).rejects.toMatchObject({ statusCode: 502 });
  });
});
