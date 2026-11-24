import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The frontend image's /docker-entrypoint.d hook (apps/web/docker/retain-previous-assets.sh)
// against a temporary store. The nginx entrypoint runs hooks under `set -e`, so
// every case also asserts exit 0: a retention failure must never stop nginx.
const script = join(import.meta.dirname, "..", "..", "apps", "web", "docker", "retain-previous-assets.sh");

let root: string;
let store: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rainver-asset-retention-"));
  store = join(root, "store");
  mkdirSync(store);
});

afterEach(() => {
  chmodSync(store, 0o755);
  rmSync(root, { recursive: true, force: true });
});

function build(id: string): string {
  const html = join(root, `html-${id}`);
  if (!existsSync(html)) {
    mkdirSync(join(html, "assets"), { recursive: true });
    writeFileSync(join(html, "version.json"), JSON.stringify({ id, builtAt: "2026-11-22T00:00:00Z" }));
    writeFileSync(join(html, "assets", `chunk-${id}.js`), `export const build = ${JSON.stringify(id)};\n`);
  }
  return html;
}

interface Start { code: number | null; stderr: string; link: string }

// One container start: its own html root and its own fallback pointer.
function start(id: string, container = id, env: NodeJS.ProcessEnv = {}): Promise<Start> {
  const link = join(root, `run-${container}`, "previous");
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [script], {
      env: { ...process.env, RAINVER_WEB_ROOT: build(id), RAINVER_WEB_ASSET_STORE: store, RAINVER_WEB_PREVIOUS_LINK: link, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, link }));
  });
}

/** Build id served as fallback through a container's pointer, or null. */
function fallback(link: string): string | null {
  if (!existsSync(link)) return null;
  const [file] = readdirSync(join(link, "assets"));
  return file.replace(/^chunk-|\.js$/g, "");
}

const order = () => readFileSync(join(store, "order"), "utf8").trim().split("\n");
const releases = () => readdirSync(join(store, "releases")).sort();
const leftovers = () => readdirSync(store).filter((name) => /^\.(staging|order|trash)\./.test(name));

// A `cp` that copies, then waits, so overlapping starts really overlap.
function slowCp(seconds: number, fail = false): NodeJS.ProcessEnv {
  const bin = join(root, fail ? "bin-failing" : "bin-slow");
  mkdirSync(bin, { recursive: true });
  const body = fail
    ? `#!/bin/sh\nmkdir -p "$3" && echo partial > "$3/partial.js"\nexit 1\n`
    : `#!/bin/sh\nsleep ${seconds}\nexec /bin/cp "$@"\n`;
  writeFileSync(join(bin, "cp"), body, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}` };
}

// Pause the first order read while the start holds the store lock.
function pauseOrderRead(ready: string, release: string): NodeJS.ProcessEnv {
  const bin = join(root, "bin-paused-cat");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "cat"), `#!/bin/sh
: > "$ORDER_READ_READY"
while [ ! -f "$ORDER_READ_RELEASE" ]; do sleep 0.02; done
exec /bin/cat "$@"
`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}`, ORDER_READ_READY: ready, ORDER_READ_RELEASE: release };
}

function observeLockAttempt(attempted: string): NodeJS.ProcessEnv {
  const bin = join(root, "bin-observed-flock");
  mkdirSync(bin);
  writeFileSync(join(bin, "flock"), `#!/bin/sh
PATH="$ORIGINAL_PATH" flock "$@"
result=$?
: > "$LOCK_ATTEMPTED"
exit "$result"
`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}`, ORIGINAL_PATH: process.env.PATH, LOCK_ATTEMPTED: attempted };
}

describe("frontend previous-build asset retention", () => {
  it("records the first build without a fallback, then serves it beside the next", async () => {
    const first = await start("a");
    expect(first.code).toBe(0);
    expect(first.stderr).toContain("no previous build retained beside a");
    expect(fallback(first.link)).toBeNull();

    const second = await start("b");
    expect(second.code).toBe(0);
    expect(fallback(second.link)).toBe("a");
    expect(readlinkSync(second.link)).toBe(join(store, "releases", "a"));

    const restarted = await start("b", "b-restart");
    expect(fallback(restarted.link)).toBe("a");
    expect(order()).toEqual(["a", "b"]);
  });

  it("rolls back to a retained build without copying it and falls back to the build it replaced", async () => {
    await start("a");
    await start("b");
    writeFileSync(join(store, "releases", "a", "assets", "marker"), "kept");
    const rollback = await start("a", "a-rollback");
    expect(rollback.code).toBe(0);
    expect(fallback(rollback.link)).toBe("b");
    expect(readFileSync(join(store, "releases", "a", "assets", "marker"), "utf8")).toBe("kept");
    expect(order()).toEqual(["b", "a"]);
  });

  it("keeps a bounded number of builds and never prunes the fallback of an nginx still serving", async () => {
    await start("a");
    const serving = await start("b");
    await start("c");
    expect(fallback(serving.link)).toBe("a");
    const latest = await start("d");
    expect(fallback(latest.link)).toBe("c");
    expect(releases()).toEqual(["b", "c", "d"]);
    expect(order()).toEqual(["b", "c", "d"]);
    expect(leftovers()).toEqual([]);
  });

  it("serialises overlapping starts on the shared volume", async () => {
    await start("a");
    const env = slowCp(1);
    const [b, c] = await Promise.all([start("b", "b", env), start("c", "c", env)]);
    expect([b.code, c.code]).toEqual([0, 0]);
    expect(b.stderr + c.stderr).not.toContain("WARNING");
    expect(releases()).toEqual(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) {
      expect(readFileSync(join(store, "releases", id, "assets", `chunk-${id}.js`), "utf8")).toContain(id);
    }
    expect(new Set(order()).size).toBe(3);
    expect(order().slice(0, 1)).toEqual(["a"]);
    // Whichever finished first falls back to `a`; the other falls back to it.
    const fallbacks = [fallback(b.link), fallback(c.link)].sort();
    expect(fallbacks[0] === "a" || fallbacks[1] === "a").toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("chooses the fallback under the lock, before an overlapping start can record", async () => {
    await start("a");
    const ready = join(root, "order-read-ready");
    const release = join(root, "order-read-release");
    const attempted = join(root, "next-lock-attempted");
    const paused = start("b", "b", pauseOrderRead(ready, release));
    let next: Promise<Start> | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
      next = start("c", "c", observeLockAttempt(attempted));
      await vi.waitFor(() => expect(existsSync(attempted)).toBe(true));
      writeFileSync(release, "");
      const [b, c] = await Promise.all([paused, next]);
      expect([b.code, c.code]).toEqual([0, 0]);
      expect(fallback(b.link)).toBe("a");
      expect(fallback(c.link)).toBe("b");
      expect(order()).toEqual(["a", "b", "c"]);
    } finally {
      writeFileSync(release, "");
      await Promise.allSettled([paused, next]);
    }
  });

  // Reading /proc/self/mem at offset 0 fails with EIO for any reader, root
  // included: a deterministic, ordinary read error on an `order` that exists.
  it.skipIf(process.platform !== "linux")("keeps order and every snapshot when order exists but cannot be read", async () => {
    await start("a");
    await start("b");
    await start("c");
    rmSync(join(store, "order"));
    symlinkSync("/proc/self/mem", join(store, "order"));
    const result = await start("d");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`WARNING: cannot read ${join(store, "order")}`);
    expect(result.stderr).toContain("WARNING: recording build d");
    expect(readlinkSync(join(store, "order"))).toBe("/proc/self/mem");
    expect(releases()).toEqual(["a", "b", "c"]);
    expect(fallback(result.link)).toBeNull();
    expect(leftovers()).toEqual([]);

    rmSync(join(store, "order"));
    writeFileSync(join(store, "order"), "a\nb\nc\n");
    const recovered = await start("d", "d-recovered");
    expect(fallback(recovered.link)).toBe("c");
    expect(order()).toEqual(["b", "c", "d"]);
    expect(releases()).toEqual(["b", "c", "d"]);
  });

  it("gives up waiting for the lock with a warning and still serves the recorded fallback", async () => {
    await start("a");
    const ready = join(root, "lock-held");
    const holder = spawn("flock", [join(store, ".lock"), "sh", "-c", ': > "$1"; read -r _', "sh", ready], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const closed = once(holder, "close");
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
      const blocked = await start("b", "b", { RAINVER_WEB_ASSET_LOCK_WAIT: "1" });
      expect(blocked.code).toBe(0);
      expect(blocked.stderr).toContain("WARNING: another start held");
      expect(fallback(blocked.link)).toBe("a");
      expect(order()).toEqual(["a"]);
    } finally {
      holder.stdin.end("\n");
      await closed;
    }
  });

  it("warns and keeps the last snapshot when this build's release path is a regular file", async () => {
    await start("a");
    writeFileSync(join(store, "releases", "b"), "placeholder");
    const result = await start("b");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("WARNING: recording build b");
    expect(fallback(result.link)).toBe("a");
    expect(order()).toEqual(["a"]);
  });

  it("warns and serves only the current build when releases/ is a regular file", async () => {
    writeFileSync(join(store, "releases"), "placeholder");
    const result = await start("a");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("WARNING: recording build a");
    expect(fallback(result.link)).toBeNull();
  });

  it("leaves order and snapshots untouched when copying fails, and clears the partial copy next start", async () => {
    await start("a");
    const failed = await start("b", "b", slowCp(0, true));
    expect(failed.code).toBe(0);
    expect(failed.stderr).toContain("WARNING: recording build b");
    expect(fallback(failed.link)).toBe("a");
    expect(order()).toEqual(["a"]);
    expect(releases()).toEqual(["a"]);
    expect(leftovers()).toHaveLength(1);

    const retried = await start("b", "b-retry");
    expect(fallback(retried.link)).toBe("a");
    expect(releases()).toEqual(["a", "b"]);
    expect(leftovers()).toEqual([]);
  });

  it("recovers from an interrupted start: unrecorded snapshots and temporaries are removed", async () => {
    await start("a");
    mkdirSync(join(store, ".staging.dead00", "assets"), { recursive: true });
    writeFileSync(join(store, ".order.dead00"), "x\n");
    mkdirSync(join(store, "releases", "orphan", "assets"), { recursive: true });
    const result = await start("b");
    expect(result.code).toBe(0);
    expect(releases()).toEqual(["a", "b"]);
    expect(leftovers()).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("uses existing snapshots read-only when the store is not writable", async () => {
    await start("a");
    await start("b");
    chmodSync(store, 0o555);
    const result = await start("c");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("WARNING:");
    expect(result.stderr).toContain("is not writable");
    expect(fallback(result.link)).toBe("b");
    expect(order()).toEqual(["a", "b"]);
  });

  it("treats a store whose lock cannot be opened as read-only", async () => {
    await start("a");
    await start("b");
    rmSync(join(store, ".lock"));
    mkdirSync(join(store, ".lock"));
    const result = await start("c");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("WARNING: ");
    expect(result.stderr).toContain("is not writable");
    expect(result.stderr).toContain("serving build b assets beside c");
    expect(order()).toEqual(["a", "b"]);
  });

  it("changes nothing without a mounted store", async () => {
    rmSync(store, { recursive: true });
    const result = await start("a");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("previous build assets are not retained");
    mkdirSync(store);
  });
});
