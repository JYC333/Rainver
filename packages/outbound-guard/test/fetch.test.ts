import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_OUTBOUND_DEADLINE_MS,
  guardedFetch,
  type PinnedFetch,
} from "../src/fetch.js";
import { createOutboundGuard, type OutboundGuard, type PinnedAddress } from "../src/guard.js";

const PUBLIC: PinnedAddress[] = [{ address: "93.184.216.34", family: 4 }];
const publicGuard: OutboundGuard = { pin: async () => PUBLIC };

type Hop = { url: string; headers: Record<string, string>; pinned: readonly PinnedAddress[] };

function recorder(responses: Array<Response | ((hop: Hop) => Response)>): { hops: Hop[]; fetch: PinnedFetch } {
  const hops: Hop[] = [];
  let index = 0;
  const fetch: PinnedFetch = async (url, init, pinned) => {
    const hop = { url, headers: init.headers, pinned };
    hops.push(hop);
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return typeof next === "function" ? next(hop) : next;
  };
  return { hops, fetch };
}

describe("guardedFetch", () => {
  it("connects only to the address the guard pinned", async () => {
    const { hops, fetch } = recorder([new Response("body", { status: 200 })]);
    const result = await guardedFetch({ url: "https://example.test/a", maxDownloadBytes: 1024 }, { guard: publicGuard, fetch });
    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(result.bytes)).toBe("body");
    expect(hops[0]?.pinned).toEqual(PUBLIC);
  });

  it("checks every redirect hop rather than the first URL only", async () => {
    const guard = createOutboundGuard({ lookup: async (hostname) =>
      hostname === "example.test" ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "169.254.169.254", family: 4 }] });
    const { fetch } = recorder([
      new Response(null, { status: 302, headers: { location: "http://metadata.test/latest/meta-data" } }),
      new Response("secrets", { status: 200 }),
    ]);
    await expect(guardedFetch({ url: "https://example.test/go", maxDownloadBytes: 1024 }, { guard, fetch }))
      .rejects.toMatchObject({ status: 422 });
  });

  it("drops a credential header as soon as the chain leaves the first origin", async () => {
    const { hops, fetch } = recorder([
      new Response(null, { status: 302, headers: { location: "https://elsewhere.test/landing" } }),
      new Response("ok", { status: 200 }),
    ]);
    await guardedFetch({
      url: "https://example.test/a",
      headers: { "if-none-match": "etag-1" },
      credentialHeaders: { "x-api-key": "secret" },
      maxDownloadBytes: 1024,
    }, { guard: publicGuard, fetch });

    expect(hops[0]?.headers).toEqual({ "if-none-match": "etag-1", "x-api-key": "secret" });
    expect(hops[1]?.headers).toEqual({ "if-none-match": "etag-1" });
  });

  it("drops authorization and cookie even when a caller puts them in plain headers", async () => {
    const { hops, fetch } = recorder([
      new Response(null, { status: 302, headers: { location: "https://elsewhere.test/landing" } }),
      new Response("ok", { status: 200 }),
    ]);
    await guardedFetch({
      url: "https://example.test/a",
      headers: { Authorization: "Bearer t", Cookie: "sid=1", accept: "*/*" },
      maxDownloadBytes: 1024,
    }, { guard: publicGuard, fetch });
    expect(hops[1]?.headers).toEqual({ accept: "*/*" });
  });

  it("keeps credentials on a same-origin redirect", async () => {
    const { hops, fetch } = recorder([
      new Response(null, { status: 302, headers: { location: "https://example.test/b" } }),
      new Response("ok", { status: 200 }),
    ]);
    await guardedFetch({
      url: "https://example.test/a",
      credentialHeaders: { "x-api-key": "secret" },
      maxDownloadBytes: 1024,
    }, { guard: publicGuard, fetch });
    expect(hops[1]?.headers).toEqual({ "x-api-key": "secret" });
  });

  it("refuses an https to http downgrade on a credentialed fetch", async () => {
    const { fetch } = recorder([
      new Response(null, { status: 302, headers: { location: "http://example.test/b" } }),
      new Response("ok", { status: 200 }),
    ]);
    await expect(guardedFetch({
      url: "https://example.test/a",
      credentialHeaders: { "x-api-key": "secret" },
      maxDownloadBytes: 1024,
    }, { guard: publicGuard, fetch })).rejects.toMatchObject({ status: 502 });
  });

  it("allows an https to http hop when nothing credential-bearing is sent", async () => {
    const { hops, fetch } = recorder([
      new Response(null, { status: 302, headers: { location: "http://example.test/b" } }),
      new Response("ok", { status: 200 }),
    ]);
    const result = await guardedFetch({ url: "https://example.test/a", maxDownloadBytes: 1024 }, { guard: publicGuard, fetch });
    expect(result.ok).toBe(true);
    expect(hops).toHaveLength(2);
  });

  it("caps the body and reports that it was cut", async () => {
    const { fetch } = recorder([new Response("0123456789", { status: 200 })]);
    const result = await guardedFetch({ url: "https://example.test/a", maxDownloadBytes: 4 }, { guard: publicGuard, fetch });
    expect(new TextDecoder().decode(result.bytes)).toBe("0123");
    expect(result.truncated).toBe(true);
  });

  /**
   * A declared oversize body is cut exactly like an undeclared one. Returning
   * nothing for the declared case would make a truncating caller's result
   * depend on whether the upstream sent `content-length` — a whole page from a
   * chunked response, an empty string from a declared one, both reported as
   * success.
   */
  it("cuts a declared-oversize body to the cap rather than discarding it", async () => {
    const { fetch } = recorder([new Response("0123456789", { status: 200, headers: { "content-length": "99999" } })]);
    const result = await guardedFetch({ url: "https://example.test/a", maxDownloadBytes: 4 }, { guard: publicGuard, fetch });
    expect(new TextDecoder().decode(result.bytes)).toBe("0123");
    expect(result.truncated).toBe(true);
  });

  it("marks a lying content-length truncated even when the body fits", async () => {
    const { fetch } = recorder([new Response("short", { status: 200, headers: { "content-length": "99999" } })]);
    const result = await guardedFetch({ url: "https://example.test/a", maxDownloadBytes: 1024 }, { guard: publicGuard, fetch });
    expect(new TextDecoder().decode(result.bytes)).toBe("short");
    expect(result.truncated).toBe(true);
  });

  it("uses its documented defaults when the caller names no budget", async () => {
    expect(DEFAULT_OUTBOUND_DEADLINE_MS).toBe(120_000);
    expect(DEFAULT_MAX_REDIRECTS).toBe(5);
    const { hops, fetch } = recorder([(hop) => new Response(null, {
      status: 302,
      headers: { location: `https://example.test/${hop.url.length}` },
    })]);
    await expect(guardedFetch({ url: "https://example.test/a", maxDownloadBytes: 1024 }, { guard: publicGuard, fetch }))
      .rejects.toMatchObject({ message: "Outbound URL redirected too many times" });
    expect(hops).toHaveLength(DEFAULT_MAX_REDIRECTS + 1);
  });

  it("gives up on name resolution once the chain's budget has passed", async () => {
    // The guard's own DNS timeout is longer than the deadline here: without the
    // budget reaching `pin`, a redirect chain could spend one full DNS timeout
    // per hop after the deadline had already passed.
    const guard = createOutboundGuard({ lookup: () => new Promise(() => {}), dnsTimeoutMs: 10_000 });
    const fetch: PinnedFetch = async () => new Response("never", { status: 200 });
    const started = Date.now();
    const error = await guardedFetch(
      { url: "https://slow-dns.test/a", maxDownloadBytes: 1024, deadlineMs: 60 },
      { guard, fetch },
    ).catch((thrown: Error) => thrown);
    expect(Date.now() - started).toBeLessThan(2_000);
    // Reported as the timeout it is, not as an address refusal: a caller that
    // records "could not be reached" for a deadline loses the one distinction
    // that says whether to wait longer or to look at connectivity.
    expect((error as Error).name).toBe("TimeoutError");
  });

  it("cancels the body of a non-OK response", async () => {
    const { fetch } = recorder([new Response("an error page", { status: 500 })]);
    const result = await guardedFetch({ url: "https://example.test/a", maxDownloadBytes: 1024 }, { guard: publicGuard, fetch });
    expect(result.status).toBe(500);
    expect(result.ok).toBe(false);
    expect(result.bytes).toHaveLength(0);
  });

  it("returns 304 as an answer rather than following it as a redirect", async () => {
    const { hops, fetch } = recorder([new Response(null, { status: 304 })]);
    const result = await guardedFetch({ url: "https://example.test/a", maxDownloadBytes: 1024 }, { guard: publicGuard, fetch });
    expect(result.status).toBe(304);
    expect(hops).toHaveLength(1);
  });

  it("stops after the redirect limit", async () => {
    const { fetch } = recorder([(hop) => new Response(null, {
      status: 302,
      headers: { location: `https://example.test/${hop.url.length}` },
    })]);
    await expect(guardedFetch({ url: "https://example.test/a", maxDownloadBytes: 1024, maxRedirects: 2 }, { guard: publicGuard, fetch }))
      .rejects.toMatchObject({ status: 502, message: "Outbound URL redirected too many times" });
  });

  it("refuses a redirect to a non-HTTP scheme", async () => {
    const { fetch } = recorder([new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } })]);
    await expect(guardedFetch({ url: "https://example.test/a", maxDownloadBytes: 1024 }, { guard: publicGuard, fetch }))
      .rejects.toMatchObject({ status: 422 });
  });

  it("gives up on the whole chain when the deadline passes", async () => {
    const guard: OutboundGuard = { pin: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return PUBLIC; } };
    const fetch: PinnedFetch = async (_url, init) => {
      if (init.signal.aborted) throw new Error("aborted before dispatch");
      return new Response(null, { status: 302, headers: { location: "https://example.test/next" } });
    };
    await expect(guardedFetch(
      { url: "https://example.test/a", maxDownloadBytes: 1024, maxRedirects: 20, deadlineMs: 80 },
      { guard, fetch },
    )).rejects.toThrow();
  });
});
