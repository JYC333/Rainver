/** Sliding window for the unauthenticated pairing-code exchange. */
import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";

const WINDOW_MS = 10 * 60 * 1000;
export const HOST_REGISTER_MAX_ATTEMPTS = 10;

/**
 * How many source buckets are kept.
 *
 * One entry per address, kept forever, is a map an unauthenticated caller
 * grows: a /64 of IPv6 is 18 quintillion keys. Pruning on every call bounds it
 * in practice; this bounds it in the case where every key is still inside the
 * window — the oldest are dropped, which costs those callers nothing but a
 * fresh window.
 */
const MAX_TRACKED_SOURCES = 10_000;

/** Lowered by the test so the cap can be reached without ten thousand calls. */
let maxTrackedSources = MAX_TRACKED_SOURCES;

/**
 * How often the whole map is swept.
 *
 * Sweeping on every call was O(buckets) of synchronous work on an
 * unauthenticated request path: at the cap that is milliseconds per call, paid
 * by everyone once an attacker has filled the map. The window each call
 * actually depends on is its own bucket's, which is filtered on read; the sweep
 * only exists to let a bucket nobody touches again be forgotten.
 */
const PRUNE_INTERVAL_MS = 30_000;

/**
 * How often the window is written out.
 *
 * On the same clock as the sweep, and for the same reason. Coalescing bounded
 * the write *queue* at one, but a write was still asked for on every attempt,
 * and each one copies and serialises the whole map — so a throttled caller
 * flooding the endpoint kept that work running continuously. The synchronous
 * cost per attempt was what moving persistence off the request stack was for.
 *
 * The cost is that a restart can lose up to this interval's attempts rather
 * than one snapshot's. Against a ten-minute window, and given that the
 * alternative is unbounded synchronous work driven by an unauthenticated
 * caller, that is the cheaper side.
 */
const PERSIST_INTERVAL_MS = 30_000;

const attempts = new Map<string, number[]>();
let hydratedFrom: string | null = null;
let lastPrunedAt = 0;
let lastPersistRequestedAt = 0;
let pruneCount = 0;
let persisting: Promise<void> = Promise.resolve();
let persistQueued = false;
let persistCount = 0;

function persistPath(persistDir: string): string {
  return join(persistDir, "cache", "host-register-attempts.json");
}

/**
 * The bucket one caller counts against.
 *
 * IPv6 by /64, because that is the smallest block an ISP hands out: counting
 * whole addresses let one caller take the full quota once per address and walk
 * through a prefix they already control. IPv4 is counted per address.
 */
export function rateLimitKey(ip: string): string {
  const raw = ip.trim();
  if (!raw) return "unknown";
  const host = raw.replace(/^\[|\]$/g, "").split("%")[0]!;
  if (isIP(host) !== 6) return host;
  // An IPv4-mapped address is an IPv4 caller wearing a v6 spelling — a proxy
  // that writes `::ffff:` form into `X-Forwarded-For` is how it arrives. Its
  // first four hextets are all zero, so keying it by /64 put *every* such
  // caller, plus `::1` and `::`, into one 10-attempt bucket: one attacker
  // could then deny pairing to everyone behind that proxy.
  const mapped = /^::ffff:(.+)$/i.exec(host)?.[1];
  if (mapped && isIP(mapped) === 4) return mapped;
  const groups = expandIpv6(host);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : host;
}

/** The eight hextets of an IPv6 address, or null if it cannot be read as one. */
function expandIpv6(raw: string): string[] | null {
  // A trailing dotted quad is two hextets — `2001:db8:1:1:0:0:192.168.0.1` is
  // a valid, unabbreviated address, and reading it as seven groups lost its
  // /64 and silently fell back to per-address keying.
  const address = raw.replace(/(\d{1,3}(?:\.\d{1,3}){3})$/, (quad) => {
    const parts = quad.split(".").map(Number);
    return `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  });
  const [head, tail] = address.split("::");
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = tail !== undefined && tail ? tail.split(":").filter(Boolean) : [];
  if (tail === undefined) return left.length === 8 ? left.map(pad) : null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left, ...Array.from({ length: fill }, () => "0"), ...right].map(pad);
}

function pad(group: string): string {
  return group.toLowerCase().padStart(4, "0");
}

function hydrate(persistDir: string, now: number): void {
  if (hydratedFrom === persistDir) return;
  hydratedFrom = persistDir;
  try {
    const parsed = JSON.parse(readFileSync(persistPath(persistDir), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [key, stamps] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(stamps)) continue;
      const recent = stamps.filter((stamp): stamp is number => typeof stamp === "number" && now - stamp < WINDOW_MS);
      if (recent.length > 0) attempts.set(key, recent);
    }
  } catch {
    // Missing or unreadable cache is a cold start, not a reason to fail open.
  }
}

/** Drops every bucket whose window has passed, and caps what is left. */
function prune(now: number): void {
  pruneCount += 1;
  for (const [key, stamps] of attempts) {
    const recent = stamps.filter((stamp) => now - stamp < WINDOW_MS);
    if (recent.length === 0) attempts.delete(key);
    else attempts.set(key, recent);
  }
  if (attempts.size <= maxTrackedSources) return;
  // Down to a fraction of the cap, not to the cap. Evicting only the excess
  // left the map pinned one over the cap, so the size term in
  // `hostRegisterRateLimited` was true on *every* subsequent request and this
  // sweep ran on every one of them — the O(buckets) cost on an unauthenticated
  // path that `PRUNE_INTERVAL_MS` exists to avoid, and reachable by one
  // already-throttled caller once the map is full.
  //
  // Map iteration is insertion-ordered and `hostRegisterRateLimited` re-inserts
  // on every touch, so this drops the least recently *used* buckets first.
  const excess = attempts.size - Math.floor(maxTrackedSources * 0.9);
  let dropped = 0;
  for (const key of attempts.keys()) {
    attempts.delete(key);
    if (++dropped >= excess) break;
  }
}

/**
 * Writes the window out without holding the request.
 *
 * This ran as a synchronous `writeFileSync` on every attempt, on the path an
 * unauthenticated caller drives — so the cheapest way to stall the event loop
 * was to pair repeatedly.
 *
 * At most one write is queued behind the one in flight, and the snapshot is
 * taken when that write runs rather than when it is asked for. A plain
 * `.then()` chain per call was worse than what it replaced: `writeFileSync`
 * at least supplied backpressure, while an unbounded chain grows one
 * whole-map copy per request under exactly the flood this limiter exists for.
 * Coalescing is safe because every write carries the complete window — the
 * skipped ones would only have written a prefix of what the next one does.
 * Serialized rather than parallel so two writes cannot interleave into a
 * half-written file.
 */
function persist(persistDir: string): void {
  if (persistQueued) return;
  persistQueued = true;
  persisting = persisting.then(async () => {
    persistQueued = false;
    persistCount += 1;
    const data: Record<string, number[]> = {};
    for (const [key, stamps] of attempts) data[key] = [...stamps];
    try {
      const path = persistPath(persistDir);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    } catch {
      // A read-only instance root must not fail pairing; the in-memory window still holds.
    }
  });
}

export function hostRegisterRateLimited(ip: string, now = Date.now(), persistDir?: string): boolean {
  if (persistDir) hydrate(persistDir, now);
  // On an interval, or whenever the map is over its bound — not on every call.
  if (now - lastPrunedAt >= PRUNE_INTERVAL_MS || attempts.size > maxTrackedSources) {
    lastPrunedAt = now;
    prune(now);
  }
  const key = rateLimitKey(ip);
  // This caller's own window, filtered here rather than relied on from the
  // sweep: the sweep is periodic, and a decision must never count a stamp that
  // has already expired.
  const recent = (attempts.get(key) ?? []).filter((stamp) => now - stamp < WINDOW_MS);
  // Deleted and re-set so Map order is last-touch: the cap evicts from the
  // front, and without this it dropped the buckets that had been under the
  // limit longest — so a caller with enough distinct keys could push their own
  // throttled bucket out and earn a fresh quota.
  attempts.delete(key);
  const throttled = recent.length >= HOST_REGISTER_MAX_ATTEMPTS;
  if (!throttled) recent.push(now);
  attempts.set(key, recent);
  // On the interval, and always at the moment a bucket fills. The second half
  // is what persistence is *for*: a restart must not hand a caller who has
  // just spent their quota a fresh one. Everything after that — the flood from
  // an already-throttled caller — is what the interval is for, since the
  // window it would write is the one already on disk.
  const justFilled = !throttled && recent.length >= HOST_REGISTER_MAX_ATTEMPTS;
  if (persistDir && (justFilled || now - lastPersistRequestedAt >= PERSIST_INTERVAL_MS)) {
    lastPersistRequestedAt = now;
    persist(persistDir);
  }
  return throttled;
}

/**
 * Awaits whatever persistence is in flight.
 *
 * Called by the tests. Nothing calls it on shutdown, and writes are on an
 * interval, so a restart can lose up to `PERSIST_INTERVAL_MS` of attempts —
 * against a ten-minute window, and against the alternative of synchronous
 * whole-map work on every unauthenticated request.
 */
export async function flushHostRegisterRateLimit(): Promise<void> {
  await persisting;
}

export function __resetHostRegisterRateLimitForTests(): void {
  attempts.clear();
  hydratedFrom = null;
  lastPrunedAt = 0;
  lastPersistRequestedAt = 0;
  pruneCount = 0;
  persistCount = 0;
  maxTrackedSources = MAX_TRACKED_SOURCES;
}

/** How many full sweeps have run. For the interval's own test. */
export function __pruneCountForTests(): number {
  return pruneCount;
}

/** How many snapshots have actually been written. For the queue's own test. */
export function __persistCountForTests(): number {
  return persistCount;
}

/** How many source buckets are held right now. For the bound's own test. */
export function __trackedSourceCountForTests(): number {
  return attempts.size;
}

export function __setMaxTrackedSourcesForTests(value: number | null): void {
  maxTrackedSources = value ?? MAX_TRACKED_SOURCES;
}
