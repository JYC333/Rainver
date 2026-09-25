import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutboundGuard, type PinnedFetch } from "@rainver/outbound-guard";
import {
  downloadRuntimeArtifact,
  MAX_RUNTIME_ARTIFACT_BYTES,
  RUNTIME_ARTIFACT_BODY_IDLE_TIMEOUT_MS,
  RUNTIME_ARTIFACT_DOWNLOAD_DEADLINE_MS,
} from "../src/toolDownload.js";

let tempDir: string | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function interruptedResponse(prefix: string, length: number, etag?: string): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(prefix));
      } else {
        controller.error(new TypeError("connection reset"));
      }
    },
  }, { highWaterMark: 0 });
  return new Response(body, {
    status: 200,
    headers: { "content-length": String(length), ...(etag ? { etag } : {}) },
  });
}

describe("runtime artifact downloads", () => {
  it("uses a long hard deadline plus a renewable progress timeout", () => {
    expect(RUNTIME_ARTIFACT_DOWNLOAD_DEADLINE_MS).toBe(15 * 60_000);
    expect(RUNTIME_ARTIFACT_BODY_IDLE_TIMEOUT_MS).toBe(60_000);
    expect(RUNTIME_ARTIFACT_DOWNLOAD_DEADLINE_MS).toBeGreaterThan(
      RUNTIME_ARTIFACT_BODY_IDLE_TIMEOUT_MS,
    );
  });

  it("pins every HTTPS redirect hop and redacts signed query parameters from logs", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rainver-tool-download-"));
    const lookups: string[] = [];
    const guard = createOutboundGuard({
      lookup: async (hostname) => {
        lookups.push(hostname);
        return [{ address: "93.184.216.34", family: 4 }];
      },
    });
    const requests: string[] = [];
    const fetch: PinnedFetch = async (url) => {
      requests.push(url);
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://objects.example.test/archive?signature=second-secret" } })
        : new Response("runtime archive");
    };
    const logs: string[] = [];
    const destination = join(tempDir, "archive");

    await downloadRuntimeArtifact(
      "https://downloads.example.test/archive?token=first-secret",
      destination,
      null,
      (line) => logs.push(line),
      { guard, fetch },
    );

    expect(lookups).toEqual(["downloads.example.test", "objects.example.test"]);
    expect(requests).toEqual([
      "https://downloads.example.test/archive?token=first-secret",
      "https://objects.example.test/archive?signature=second-secret",
    ]);
    expect(await readFile(destination, "utf8")).toBe("runtime archive");
    expect(logs.join("\n")).not.toContain("first-secret");
    expect(logs.join("\n")).not.toContain("second-secret");
    expect(logs[0]).toContain("https://downloads.example.test/archive?[redacted]");
  });

  it("refuses a private DNS answer before opening a connection", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rainver-tool-download-"));
    const fetch = vi.fn(async () => new Response("private response"));
    const guard = createOutboundGuard({
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    await expect(downloadRuntimeArtifact(
      "https://downloads.example.test/archive?token=secret",
      join(tempDir, "archive"),
      null,
      () => {},
      { guard, fetch },
    )).rejects.toMatchObject({ status: 422 });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an HTTPS downgrade before dialing the redirect target", async () => {
    const guard = createOutboundGuard({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    }));

    await expect(downloadRuntimeArtifact(
      "https://downloads.example.test/archive",
      "/tmp/rainver-never-written-archive",
      null,
      () => {},
      { guard, fetch },
    )).rejects.toThrow("Outbound redirect must use HTTPS");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a private address after the scheme check passes", async () => {
    // Same hop, the other refusal: the target keeps HTTPS, so the downgrade
    // check lets it through and the address decision is what stops it — and it
    // stops it before the connection, not after.
    const guard = createOutboundGuard({
      lookup: async (hostname) => hostname === "downloads.example.test"
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }],
    });
    const fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://metadata.example.test/latest/meta-data" },
    }));

    await expect(downloadRuntimeArtifact(
      "https://downloads.example.test/archive",
      "/tmp/rainver-never-written-archive",
      null,
      () => {},
      { guard, fetch },
    )).rejects.toThrow("Outbound URL is not allowed");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects rather than installs a response that exceeds the artifact limit", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rainver-tool-download-"));
    const guard = createOutboundGuard({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const fetch: PinnedFetch = async () => new Response("small body", {
      headers: { "content-length": String(MAX_RUNTIME_ARTIFACT_BYTES + 1) },
    });
    const destination = join(tempDir, "archive");

    await expect(downloadRuntimeArtifact(
      "https://downloads.example.test/archive",
      destination,
      null,
      () => {},
      { guard, fetch },
    )).rejects.toThrow(/exceeds the .* download limit/);
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes a broken transfer from the received byte and verifies the final file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rainver-tool-download-"));
    const guard = createOutboundGuard({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
    const headers: Record<string, string>[] = [];
    const fetch: PinnedFetch = async (_url, init) => {
      headers.push(init.headers);
      return headers.length === 1
        ? interruptedResponse("hello", 11, '"version-1"')
        : new Response(" world", {
          status: 206,
          headers: {
            "content-range": "bytes 5-10/11",
            "content-length": "6",
            etag: '"version-1"',
          },
        });
    };
    const destination = join(tempDir, "archive");
    const sha256 = createHash("sha256").update("hello world").digest("hex");

    await downloadRuntimeArtifact("https://downloads.example.test/archive", destination, sha256, () => {}, { guard, fetch });

    expect(await readFile(destination, "utf8")).toBe("hello world");
    expect(headers).toHaveLength(2);
    expect(headers[0]).toEqual({ "accept-encoding": "identity" });
    expect(headers[1]).toEqual({
      "accept-encoding": "identity",
      range: "bytes=5-",
      "if-range": '"version-1"',
    });
    expect(await readdir(tempDir)).toEqual(["archive"]);
  });

  it("restarts cleanly when the publisher ignores Range", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rainver-tool-download-"));
    const guard = createOutboundGuard({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
    const requests: Record<string, string>[] = [];
    const fetch: PinnedFetch = async (_url, init) => {
      requests.push(init.headers);
      return requests.length === 1
        ? interruptedResponse("old", 4, '"version-1"')
        : new Response("good", { headers: { "content-length": "4", etag: '"version-2"' } });
    };
    const destination = join(tempDir, "archive");
    const sha256 = createHash("sha256").update("good").digest("hex");

    await downloadRuntimeArtifact("https://downloads.example.test/archive", destination, sha256, () => {}, { guard, fetch });

    expect(requests[1]?.range).toBe("bytes=3-");
    expect(await readFile(destination, "utf8")).toBe("good");
  });

  it("restarts without Range when neither a checksum nor a validator can protect the join", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rainver-tool-download-"));
    const guard = createOutboundGuard({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
    const requests: Record<string, string>[] = [];
    const fetch: PinnedFetch = async (_url, init) => {
      requests.push(init.headers);
      return requests.length === 1
        ? interruptedResponse("old", 4, 'W/"version-1"')
        : new Response("good", { headers: { "content-length": "4" } });
    };
    const destination = join(tempDir, "archive");

    await downloadRuntimeArtifact("https://downloads.example.test/archive", destination, null, () => {}, { guard, fetch });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.range).toBeUndefined();
    expect(await readFile(destination, "utf8")).toBe("good");
  });

  it("rejects an inconsistent resume response and preserves the existing destination", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rainver-tool-download-"));
    const guard = createOutboundGuard({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
    let calls = 0;
    const fetch: PinnedFetch = async () => {
      calls += 1;
      return calls === 1
        ? interruptedResponse("hello", 11, '"version-1"')
        : new Response(" world", {
          status: 206,
          headers: { "content-range": "bytes 4-9/11", "content-length": "6", etag: '"version-1"' },
        });
    };
    const destination = join(tempDir, "archive");
    await writeFile(destination, "previous");
    const sha256 = createHash("sha256").update("hello world").digest("hex");

    await expect(downloadRuntimeArtifact(
      "https://downloads.example.test/archive", destination, sha256, () => {}, { guard, fetch },
    )).rejects.toThrow("inconsistent Content-Range");

    expect(calls).toBe(2);
    expect(await readFile(destination, "utf8")).toBe("previous");
    expect(await readdir(tempDir)).toEqual(["archive"]);
  });

  it("keeps the previous artifact when the completed download fails SHA-256", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rainver-tool-download-"));
    const guard = createOutboundGuard({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
    const fetch: PinnedFetch = async () => new Response("wrong", { headers: { "content-length": "5" } });
    const destination = join(tempDir, "archive");
    await writeFile(destination, "previous");

    await expect(downloadRuntimeArtifact(
      "https://downloads.example.test/archive",
      destination,
      createHash("sha256").update("right").digest("hex"),
      () => {},
      { guard, fetch },
    )).rejects.toThrow("sha256 mismatch");

    expect(await readFile(destination, "utf8")).toBe("previous");
    expect(await readdir(tempDir)).toEqual(["archive"]);
  });

  it("uses the selected TUN route for both release hops without relaxing direct mode", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rainver-tool-download-"));
    const destinations: string[] = [];
    const pinned: string[][] = [];
    const lookup = async (host: string) => [{ address: host === "github.com" ? "198.18.0.66" : "198.18.0.71", family: 4 }];
    const fetch: PinnedFetch = async (url, _init, addresses) => {
      destinations.push(url);
      pinned.push(addresses.map((entry) => entry.address));
      return destinations.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/archive" } })
        : new Response("artifact");
    };
    const destination = join(tempDir, "archive");
    const sha256 = createHash("sha256").update("artifact").digest("hex");
    await expect(downloadRuntimeArtifact(
      "https://github.com/release", destination, sha256, () => {}, { lookup, fetch },
    )).rejects.toThrow("Outbound URL is not allowed");
    await downloadRuntimeArtifact(
      "https://github.com/release", destination, sha256, () => {}, { lookup, fetch }, { mode: "system_tun" },
    );
    expect(destinations).toEqual([
      "https://github.com/release",
      "https://release-assets.githubusercontent.com/archive",
    ]);
    expect(pinned).toEqual([["198.18.0.66"], ["198.18.0.71"]]);
    expect(await readFile(destination, "utf8")).toBe("artifact");
  });

  it("still rejects a private redirect and an unpinned artifact in TUN mode", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rainver-tool-download-"));
    const fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://internal.example/archive" },
    }));
    const lookup = async (host: string) => [{ address: host === "github.com" ? "198.18.0.66" : "10.0.0.5", family: 4 }];
    const destination = join(tempDir, "archive");
    await expect(downloadRuntimeArtifact(
      "https://github.com/release", destination, null, () => {}, { lookup, fetch }, { mode: "system_tun" },
    )).rejects.toThrow("requires a pinned SHA-256");
    expect(fetch).not.toHaveBeenCalled();
    await expect(downloadRuntimeArtifact(
      "https://github.com/release", destination, "a".repeat(64), () => {}, { lookup, fetch }, { mode: "system_tun" },
    )).rejects.toThrow("Outbound URL is not allowed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("uses explicit CONNECT proxy mode and honours its direct exceptions", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rainver-tool-download-"));
    const fetch = vi.fn(async (_url: string, init: RequestInit & { dispatcher?: unknown }) => {
      expect(init.dispatcher?.constructor.name).toBe("ProxyAgent");
      return new Response("artifact");
    });
    vi.stubGlobal("fetch", fetch);
    const lookup = async () => [{ address: "198.18.0.66", family: 4 }];
    const destination = join(tempDir, "archive");
    const sha256 = createHash("sha256").update("artifact").digest("hex");
    await downloadRuntimeArtifact(
      "https://github.com/release", destination, sha256, () => {}, { lookup },
      { mode: "http_proxy", proxy_url: "http://proxy.example:8080", no_proxy: null },
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(await readFile(destination, "utf8")).toBe("artifact");
    await expect(downloadRuntimeArtifact(
      "https://github.com/release", destination, sha256, () => {}, { lookup },
      { mode: "http_proxy", proxy_url: "http://proxy.example:8080", no_proxy: "github.com" },
    )).rejects.toThrow("Outbound URL is not allowed");
    expect(fetch).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

});
