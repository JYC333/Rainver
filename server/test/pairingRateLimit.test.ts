import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOST_REGISTER_MAX_ATTEMPTS,
  flushHostRegisterRateLimit,
  rateLimitKey,
  __resetHostRegisterRateLimitForTests,
  __persistCountForTests,
  __pruneCountForTests,
  __setMaxTrackedSourcesForTests,
  __trackedSourceCountForTests,
  hostRegisterRateLimited,
} from "../src/modules/hosts/pairingRateLimit.js";

let dir: string | undefined;

afterEach(async () => {
  __setMaxTrackedSourcesForTests(null);
  __resetHostRegisterRateLimitForTests();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("hostRegisterRateLimited", () => {
  it("survives a process-local reset by reading the persisted cache", async () => {
    dir = await mkdtemp(join(tmpdir(), "rainver-pair-limit-"));
    for (let i = 0; i < HOST_REGISTER_MAX_ATTEMPTS; i += 1) {
      expect(hostRegisterRateLimited("203.0.113.9", 1_000 + i, dir)).toBe(false);
    }
    expect(hostRegisterRateLimited("203.0.113.9", 1_000 + HOST_REGISTER_MAX_ATTEMPTS, dir)).toBe(true);
    // The write no longer happens on the request's own stack — it used to be a
    // synchronous `writeFileSync` on the path an unauthenticated caller drives.
    await flushHostRegisterRateLimit();
    __resetHostRegisterRateLimitForTests();
    expect(hostRegisterRateLimited("203.0.113.9", 1_000 + HOST_REGISTER_MAX_ATTEMPTS + 1, dir)).toBe(true);
  });

  /**
   * A /64 is the smallest block an ISP hands out, so counting whole IPv6
   * addresses let one caller take the full quota once per address and walk
   * through a prefix they already control.
   */
  it("counts an IPv6 caller by its /64, and IPv4 by address", () => {
    for (let i = 0; i < HOST_REGISTER_MAX_ATTEMPTS; i += 1) {
      expect(hostRegisterRateLimited(`2001:db8:1:1::${i + 1}`, 1_000 + i)).toBe(false);
    }
    expect(hostRegisterRateLimited("2001:db8:1:1:ffff::9", 1_100)).toBe(true);
    // A different /64 is a different caller.
    expect(hostRegisterRateLimited("2001:db8:1:2::1", 1_100)).toBe(false);
    // And IPv4 is still per address.
    expect(hostRegisterRateLimited("198.51.100.1", 1_100)).toBe(false);
    expect(hostRegisterRateLimited("198.51.100.2", 1_100)).toBe(false);
  });

  /**
   * A proxy that writes `::ffff:` form into `X-Forwarded-For` turns every IPv4
   * caller into a v6 address whose first four hextets are zero, so keying those
   * by /64 put all of them — and `::1`, and `::` — in one 10-attempt bucket.
   */
  it("keys an IPv4-mapped caller by its IPv4 address", () => {
    expect(rateLimitKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitKey("::ffff:198.51.100.5")).toBe("198.51.100.5");
    expect(rateLimitKey("::ffff:203.0.113.9")).not.toBe(rateLimitKey("::ffff:198.51.100.5"));
    // And a real v6 caller still groups by /64, including the unabbreviated
    // form that carries a trailing dotted quad.
    expect(rateLimitKey("2001:db8:1:1::9")).toBe(rateLimitKey("2001:db8:1:1:0:0:192.168.0.1"));
  });

  /**
   * The whole-map sweep is O(buckets) on an unauthenticated request path, so it
   * runs on an interval rather than per call. Evicting only the excess left the
   * map pinned one over the cap, which made the size trigger true on every
   * subsequent request and put the sweep straight back on the hot path — so a
   * saturated map is the case worth asserting, not an empty one.
   */
  it("does not sweep the whole map on every request, even once it is full", () => {
    __setMaxTrackedSourcesForTests(20);
    for (let i = 0; i < 40; i += 1) hostRegisterRateLimited(`198.51.100.${i}`, 1_100);
    const sweptWhileFilling = __pruneCountForTests();
    for (let i = 0; i < 100; i += 1) hostRegisterRateLimited("203.0.113.30", 1_100);
    // Same millisecond throughout, and the map stays under its cap, so nothing
    // should trigger a sweep across those hundred calls.
    expect(__pruneCountForTests()).toBe(sweptWhileFilling);
    expect(__trackedSourceCountForTests()).toBeLessThanOrEqual(20);
  });

  /**
   * The snapshot is written at most once per write already in flight, and the
   * copy is taken when that write runs. A `.then()` chain per call was worse
   * than the synchronous write it replaced: an unbounded queue holding one
   * whole-map copy each, grown by exactly the flood this limiter is for.
   */
  it("coalesces the persisted snapshot instead of queuing one write per attempt", async () => {
    dir = await mkdtemp(join(tmpdir(), "rainver-pair-limit-"));
    for (let i = 0; i < 100; i += 1) {
      hostRegisterRateLimited(`198.51.100.${i}`, 1_100, dir);
    }
    await flushHostRegisterRateLimit();
    expect(__persistCountForTests()).toBeLessThanOrEqual(2);
  });

  /**
   * A write was asked for on every attempt. Coalescing bounded the *queue* at
   * one, but each write still copies and serialises the whole map, so a caller
   * who is already throttled kept that work running continuously — the
   * synchronous cost that moving persistence off the request stack was for.
   */
  it("does not ask for a write on every attempt from a throttled caller", async () => {
    dir = await mkdtemp(join(tmpdir(), "rainver-pair-limit-"));
    // Fill the bucket: that one write is the state a restart must not lose.
    for (let i = 0; i < HOST_REGISTER_MAX_ATTEMPTS; i += 1) {
      hostRegisterRateLimited("203.0.113.40", 1_000 + i, dir);
    }
    await flushHostRegisterRateLimit();
    const afterFilling = __persistCountForTests();
    expect(afterFilling).toBeGreaterThan(0);

    // Two hundred more within the interval ask for none.
    for (let i = 0; i < 200; i += 1) {
      expect(hostRegisterRateLimited("203.0.113.40", 1_100, dir)).toBe(true);
    }
    await flushHostRegisterRateLimit();
    expect(__persistCountForTests()).toBe(afterFilling);
  });

  /**
   * One entry per address, kept forever, is a map an unauthenticated caller
   * grows: a /64 of IPv6 is 18 quintillion keys. The cap is lowered here so it
   * can be reached without ten thousand calls; the behaviour under test is the
   * bound itself, not its production size.
   */
  it("stops growing once the cap is reached", () => {
    __setMaxTrackedSourcesForTests(8);
    for (let i = 0; i < 200; i += 1) {
      hostRegisterRateLimited(`198.51.100.${i}`, 1_100);
    }
    // Cap plus one: pruning runs before this call's own key is inserted.
    expect(__trackedSourceCountForTests()).toBeLessThanOrEqual(9);
  });

  /**
   * And the bound must not be a way to buy a fresh quota: eviction is by last
   * touch, so a throttled bucket is the *last* thing dropped, not the first.
   * Dropping by first-seen let a caller with enough distinct keys push their
   * own throttled bucket out and start over.
   */
  it("does not forgive the caller that filled the map", () => {
    __setMaxTrackedSourcesForTests(8);
    for (let i = 0; i < HOST_REGISTER_MAX_ATTEMPTS; i += 1) {
      expect(hostRegisterRateLimited("203.0.113.20", 1_000 + i)).toBe(false);
    }
    expect(hostRegisterRateLimited("203.0.113.20", 1_100)).toBe(true);
    for (let i = 0; i < 200; i += 1) {
      hostRegisterRateLimited(`198.51.100.${i}`, 1_100);
      // Touching the throttled bucket keeps it at the back of the queue.
      expect(hostRegisterRateLimited("203.0.113.20", 1_100)).toBe(true);
    }
  });

  it("forgets a caller once its window has passed, and drops the bucket with it", () => {
    for (let i = 0; i < HOST_REGISTER_MAX_ATTEMPTS; i += 1) {
      expect(hostRegisterRateLimited("203.0.113.10", 1_000 + i)).toBe(false);
    }
    expect(hostRegisterRateLimited("203.0.113.10", 1_100)).toBe(true);
    // Eleven minutes later the window is empty. The old code filtered by window
    // at read time and would also answer `false` here, so the assertion that
    // separates the two is the *bucket* being gone rather than kept forever.
    expect(hostRegisterRateLimited("203.0.113.10", 1_000 + 11 * 60_000)).toBe(false);
    __resetHostRegisterRateLimitForTests();
    hostRegisterRateLimited("203.0.113.10", 1_000);
    expect(__trackedSourceCountForTests()).toBe(1);
    hostRegisterRateLimited("198.51.100.7", 1_000 + 11 * 60_000);
    expect(__trackedSourceCountForTests()).toBe(1);
  });
});
