import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutboundGuard, type PinnedFetch } from "@rainver/outbound-guard";
import { downloadRuntimeArtifact, MAX_RUNTIME_ARTIFACT_BYTES } from "../src/toolDownload.js";

let tempDir: string | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("runtime artifact downloads", () => {
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
});
