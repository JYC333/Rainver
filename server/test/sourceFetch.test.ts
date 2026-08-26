import { describe, expect, it, vi } from "vitest";
import { fetchSource } from "../src/modules/sources/sourceFetch.js";

describe("fetchSource", () => {
  it("detects PDF bytes without decoding them as text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]),
      { status: 200, headers: { "content-type": "text/plain" } },
    ));

    const result = await fetchSource("https://example.test/paper", {
      maxDownloadBytes: 1024,
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
    })).rejects.toMatchObject({
      statusCode: 413,
      message: "Downloaded source exceeds max size (5 MiB)",
    });
  });
});
