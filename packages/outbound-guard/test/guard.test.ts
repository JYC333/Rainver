import { describe, expect, it } from "vitest";
import { createOutboundGuard, parseOutboundHttpUrl } from "../src/guard.js";
import { OUTBOUND_REFUSED_MESSAGE } from "../src/errors.js";
import { pinnedAddressLookup } from "../src/pinnedLookup.js";

const publicAnswer = [{ address: "93.184.216.34", family: 4 }];

describe("parseOutboundHttpUrl", () => {
  it("accepts http and https and refuses everything else", () => {
    expect(parseOutboundHttpUrl("https://example.com/a").hostname).toBe("example.com");
    for (const value of ["file:///etc/passwd", "gopher://example.com", "not a url", "https://user:pw@example.com/"]) {
      expect(() => parseOutboundHttpUrl(value), value).toThrow();
    }
  });
});

describe("createOutboundGuard", () => {
  it("pins the resolved address so nothing resolves the name twice", async () => {
    const guard = createOutboundGuard({ lookup: async () => publicAnswer });
    await expect(guard.pin(new URL("https://example.test/x"))).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  it("refuses a name that resolves into the instance network", async () => {
    const guard = createOutboundGuard({ lookup: async () => [{ address: "10.0.0.8", family: 4 }] });
    await expect(guard.pin(new URL("https://internal.test/x"))).rejects.toMatchObject({
      status: 422,
      message: OUTBOUND_REFUSED_MESSAGE,
    });
  });

  it("refuses a name with one public and one private answer", async () => {
    const guard = createOutboundGuard({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
    });
    await expect(guard.pin(new URL("https://rebind.test/x"))).rejects.toMatchObject({ status: 422 });
  });

  it("answers a blocked host and an unresolvable host with the same message", async () => {
    const blocked = createOutboundGuard({ lookup: async () => publicAnswer });
    const unresolvable = createOutboundGuard({ lookup: async () => { throw new Error("ENOTFOUND db.internal"); } });
    const first = await blocked.pin(new URL("http://127.0.0.1/x")).catch((error: Error) => error.message);
    const second = await unresolvable.pin(new URL("http://db.internal/x")).catch((error: Error) => error.message);
    expect(first).toBe(OUTBOUND_REFUSED_MESSAGE);
    expect(second).toBe(OUTBOUND_REFUSED_MESSAGE);
  });

  it("refuses an IPv6 literal written with brackets", async () => {
    const guard = createOutboundGuard({ lookup: async () => publicAnswer });
    await expect(guard.pin(new URL("http://[::1]:8080/x"))).rejects.toMatchObject({ status: 422 });
  });

  it("refuses a name that resolves to nothing", async () => {
    const guard = createOutboundGuard({ lookup: async () => [] });
    await expect(guard.pin(new URL("https://empty.test/x"))).rejects.toMatchObject({ status: 422 });
  });

  it("times out a resolver that never answers", async () => {
    const guard = createOutboundGuard({ lookup: () => new Promise(() => {}), dnsTimeoutMs: 20 });
    const started = Date.now();
    await expect(guard.pin(new URL("https://slow.test/x"))).rejects.toMatchObject({ status: 422 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("pinnedAddressLookup", () => {
  it("answers with the pinned addresses whatever name it is asked for", () => {
    const lookup = pinnedAddressLookup([{ address: "93.184.216.34", family: 4 }]);
    let answered: unknown;
    lookup("anything.test", { all: true }, (error: Error | null, addresses: unknown) => {
      expect(error).toBeNull();
      answered = addresses;
    });
    expect(answered).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  /** undici asks with `all: true`; `net.connect` reaches the single-answer form. */
  it("answers the single-address form when asked for one", () => {
    const lookup = pinnedAddressLookup([{ address: "93.184.216.34", family: 4 }, { address: "8.8.8.8", family: 4 }]);
    let answered: unknown[] = [];
    lookup("anything.test", { all: false }, (...args: unknown[]) => { answered = args; });
    expect(answered).toEqual([null, "93.184.216.34", 4]);
  });

  it("reports a family it has no pin for as a resolution failure", () => {
    const lookup = pinnedAddressLookup([{ address: "93.184.216.34", family: 4 }]);
    let failure: Error | null = null;
    lookup("anything.test", { all: true, family: 6 }, (error: Error | null) => { failure = error; });
    expect(failure).toMatchObject({ code: "ENOTFOUND" });
  });
});
