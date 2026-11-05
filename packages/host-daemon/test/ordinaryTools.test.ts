import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOutboundGuard, type PinnedFetch } from "@rainver/outbound-guard";
import {
  HostServerFrameSchema,
  ORDINARY_TOOL_CATALOG,
  type OrdinaryToolCatalogEntry,
  type OrdinaryToolId,
} from "@rainver/protocol";
import {
  __clearOrdinaryToolVersionCache,
  handleOrdinaryToolAction,
  ordinaryToolsReport,
  ordinaryToolsRoot,
} from "../src/ordinaryTools.js";
import { detectCapabilities } from "../src/capabilities.js";
import { platformKey } from "../src/tools.js";

let root: string;
let bin: string;
let savedPath: string | undefined;
const log = () => {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rainver-ordinary-tools-"));
  bin = join(root, "bin");
  await mkdir(bin);
  process.env.RAINVER_HOST_CONFIG_DIR = join(root, "config");
  savedPath = process.env.PATH;
  // Only the fake tools: a real jq/rg on the test machine must not answer.
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  __clearOrdinaryToolVersionCache();
});

afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  process.env.PATH = savedPath;
  await rm(root, { recursive: true, force: true });
});

async function script(path: string, body: string): Promise<string> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/** A tarball whose `lark-cli` prints the given version, as the official archive's root does. */
async function larkArchive(reported: string): Promise<Buffer> {
  const dir = await mkdtemp(join(root, "archive-"));
  await script(join(dir, "lark-cli"), `echo "lark-cli version ${reported}"`);
  const archive = join(root, `lark-${reported}-${Math.random()}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", dir, "lark-cli"]);
  return readFile(archive);
}

function catalogWith(version: string, bytes: Buffer, sha = createHash("sha256").update(bytes).digest("hex")) {
  const lark: OrdinaryToolCatalogEntry = {
    ...ORDINARY_TOOL_CATALOG.lark_cli,
    managed: {
      version,
      release_url: "https://downloads.example.test/release",
      platforms: { [platformKey()]: { archive: `https://downloads.example.test/lark-${version}.tar.gz`, sha256: sha, cmd: "lark-cli" } },
    },
  };
  const fetch: PinnedFetch = async () => new Response(new Uint8Array(bytes));
  const guard = createOutboundGuard({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
  return {
    catalog: { ...ORDINARY_TOOL_CATALOG, lark_cli: lark } as Record<OrdinaryToolId, OrdinaryToolCatalogEntry>,
    download: { guard, fetch },
  };
}

async function reported(id: OrdinaryToolId) {
  return (await ordinaryToolsReport()).tools.find((tool) => tool.tool_id === id)!;
}

describe("ordinary tool inventory", () => {
  it("reports each catalog command as available, broken or missing without any shell", async () => {
    await script(join(bin, "jq"), 'echo "jq-1.7.1"');
    await script(join(bin, "rg"), "exit 3");
    const report = await ordinaryToolsReport();
    expect(report.protocol).toBe("ordinary-tools-v1");
    expect(report.tools.map((tool) => tool.tool_id)).toEqual(["git", "curl", "jq", "rg", "lark_cli"]);
    expect(await reported("jq")).toMatchObject({ status: "available", source: "path", version: "1.7.1", version_text: "jq-1.7.1" });
    expect(await reported("rg")).toMatchObject({ status: "broken", source: "path", version: null });
    expect(await reported("lark_cli")).toMatchObject({
      status: "missing", source: null, managed_version: null,
      managed_catalog_version: ORDINARY_TOOL_CATALOG.lark_cli.managed!.version,
    });
  });
});

describe("registering the machine's own command", () => {
  it("accepts only the catalog executable that answers its version command", async () => {
    const elsewhere = join(root, "opt");
    await mkdir(elsewhere);
    await script(join(elsewhere, "lark-cli"), 'echo "lark-cli version 1.0.42"');
    await script(join(elsewhere, "evil"), 'echo "1.0.0"');
    await writeFile(join(elsewhere, "plain-lark"), "not executable");

    const wrongName = await handleOrdinaryToolAction({ action: "register", tool_id: "lark_cli", path: join(elsewhere, "evil") }, log);
    expect(wrongName).toMatchObject({ ok: false, error: expect.stringMatching(/must name the lark-cli executable/) });
    const relative = await handleOrdinaryToolAction({ action: "register", tool_id: "lark_cli", path: "opt/lark-cli" }, log);
    expect(relative).toMatchObject({ ok: false, error: expect.stringMatching(/absolute path/) });
    const shellish = await handleOrdinaryToolAction({ action: "register", tool_id: "lark_cli", path: `${elsewhere}/lark-cli; rm -rf /` }, log);
    expect(shellish.ok).toBe(false);
    const notOnPath = await handleOrdinaryToolAction({ action: "register", tool_id: "lark_cli", path: null }, log);
    expect(notOnPath).toMatchObject({ ok: false, error: expect.stringMatching(/not found on this Host's PATH/) });

    const registered = await handleOrdinaryToolAction({ action: "register", tool_id: "lark_cli", path: join(elsewhere, "lark-cli") }, log);
    expect(registered).toMatchObject({ ok: true, tool: { status: "available", source: "registered", version: "1.0.42", registered: true } });

    await script(join(bin, "jq"), "exit 1");
    const silent = await handleOrdinaryToolAction({ action: "register", tool_id: "jq", path: null }, log);
    expect(silent).toMatchObject({ ok: false, error: expect.stringMatching(/did not answer its version command/) });
    expect((await reported("jq")).registered).toBe(false);

    const removed = await handleOrdinaryToolAction({ action: "remove", tool_id: "lark_cli", source: "registered" }, log);
    expect(removed).toMatchObject({ ok: true, tool: { status: "missing", registered: false } });
  });
});

describe("shared registration file", () => {
  async function installFakes() {
    for (const [name, line] of [["git", "git version 2.43.0"], ["curl", "curl 8.5.0"], ["jq", "jq-1.7.1"], ["rg", "ripgrep 14.1.0"]]) {
      await script(join(bin, name), `echo "${line}"`);
    }
  }
  async function registeredIds() {
    const parsed = JSON.parse(await readFile(join(ordinaryToolsRoot(), "registrations.json"), "utf8")) as Record<string, unknown>;
    return Object.keys(parsed).sort();
  }
  async function strayTempFiles() {
    return (await readdir(ordinaryToolsRoot())).filter((name) => name.endsWith(".tmp"));
  }

  it("keeps every registration when different tools register at once", async () => {
    await installFakes();
    const results = await Promise.all((["git", "curl", "jq", "rg"] as const).map((tool_id) =>
      handleOrdinaryToolAction({ action: "register", tool_id, path: null }, log)));
    expect(results.map((result) => result.ok)).toEqual([true, true, true, true]);
    expect(await registeredIds()).toEqual(["curl", "git", "jq", "rg"]);
    expect(await strayTempFiles()).toEqual([]);
  });

  it("interleaves registrations and removals without dropping an unrelated entry, and recovers after a refusal", async () => {
    await installFakes();
    for (const tool_id of ["git", "curl"] as const) {
      expect((await handleOrdinaryToolAction({ action: "register", tool_id, path: null }, log)).ok).toBe(true);
    }
    const [removeGit, addJq, removeMissing, addRg] = await Promise.all([
      handleOrdinaryToolAction({ action: "remove", tool_id: "git", source: "registered" }, log),
      handleOrdinaryToolAction({ action: "register", tool_id: "jq", path: null }, log),
      // Refused inside the queue: it must not block or undo the others.
      handleOrdinaryToolAction({ action: "remove", tool_id: "lark_cli", source: "registered" }, log),
      handleOrdinaryToolAction({ action: "register", tool_id: "rg", path: null }, log),
    ]);
    expect([removeGit.ok, addJq.ok, removeMissing.ok, addRg.ok]).toEqual([true, true, false, true]);
    expect(await registeredIds()).toEqual(["curl", "jq", "rg"]);
    expect(await strayTempFiles()).toEqual([]);
  });

  it("releases the queue and removes its staged file after a failed write", async () => {
    await installFakes();
    // A directory where the file belongs: the rename over it fails.
    await mkdir(join(ordinaryToolsRoot(), "registrations.json", "blocker"), { recursive: true });
    const failed = await handleOrdinaryToolAction({ action: "register", tool_id: "git", path: null }, log);
    expect(failed.ok).toBe(false);
    expect(await strayTempFiles()).toEqual([]);
    await rm(join(ordinaryToolsRoot(), "registrations.json"), { recursive: true, force: true });
    const [git, jq] = await Promise.all([
      handleOrdinaryToolAction({ action: "register", tool_id: "git", path: null }, log),
      handleOrdinaryToolAction({ action: "register", tool_id: "jq", path: null }, log),
    ]);
    expect([git.ok, jq.ok]).toEqual([true, true]);
    expect(await registeredIds()).toEqual(["git", "jq"]);
  });
});

describe("managed installation", () => {
  it("installs only the pinned verified archive, keeps the usable copy on failure, and never becomes an ACP Runtime", async () => {
    const good = catalogWith("9.9.9", await larkArchive("9.9.9"));
    const installed = await handleOrdinaryToolAction({ action: "install", tool_id: "lark_cli", version: "9.9.9" }, log, undefined, good);
    expect(installed).toMatchObject({ ok: true, tool: { status: "available", source: "managed", version: "9.9.9", managed_version: "9.9.9" } });

    // An archive whose executable reports another version is refused.
    const lying = catalogWith("9.9.10", await larkArchive("9.9.9"));
    const refused = await handleOrdinaryToolAction({ action: "install", tool_id: "lark_cli", version: "9.9.10" }, log, undefined, lying);
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/reported 9\.9\.9 instead of 9\.9\.10/) });
    expect(refused.tool).toMatchObject({ status: "available", source: "managed", version: "9.9.9" });

    // A checksum mismatch is refused before anything is extracted.
    const tampered = catalogWith("9.9.11", await larkArchive("9.9.11"), "0".repeat(64));
    const mismatch = await handleOrdinaryToolAction({ action: "install", tool_id: "lark_cli", version: "9.9.11" }, log, undefined, tampered);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.tool).toMatchObject({ version: "9.9.9" });

    // A same-version reinstall that fails puts the previous tree back.
    const broken = catalogWith("9.9.9", await larkArchive("9.9.9"), "f".repeat(64));
    expect((await handleOrdinaryToolAction({ action: "install", tool_id: "lark_cli", version: "9.9.9" }, log, undefined, broken)).ok).toBe(false);
    expect(await reported("lark_cli")).toMatchObject({ status: "available", version: "9.9.9" });

    // A version the daemon's catalog does not carry asks for a Host update.
    const unpinned = await handleOrdinaryToolAction({ action: "install", tool_id: "lark_cli", version: "9.9.12" }, log, undefined, good);
    expect(unpinned).toMatchObject({ ok: false, error: expect.stringMatching(/update the Host first/) });
    const basic = await handleOrdinaryToolAction({ action: "install", tool_id: "jq", version: "1.7.1" }, log);
    expect(basic).toMatchObject({ ok: false, error: expect.stringMatching(/no managed installation/) });

    // Separate from the ACP tree: nothing here is a Runtime installation.
    expect((await detectCapabilities(undefined, [])).installations).toEqual({});
    expect(await readdir(join(ordinaryToolsRoot(), "managed", "lark_cli"))).toEqual(["9.9.9"]);

    // Removing the managed copy leaves personal tool state alone.
    const personal = join(process.env.RAINVER_HOST_CONFIG_DIR!, "ordinary-tool-state", "lark_cli", "user-a");
    await mkdir(personal, { recursive: true });
    await writeFile(join(personal, "config.json"), "{}");
    expect(await handleOrdinaryToolAction({ action: "remove", tool_id: "lark_cli", source: "managed" }, log)).toMatchObject({
      ok: true, tool: { status: "missing", managed_version: null },
    });
    expect(await readFile(join(personal, "config.json"), "utf8")).toBe("{}");
    expect(await handleOrdinaryToolAction({ action: "remove", tool_id: "lark_cli", source: "managed" }, log)).toMatchObject({ ok: false });
  });

  it("refuses a second operation on the same tool while one is running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bytes = await larkArchive("9.9.9");
    const slow = catalogWith("9.9.9", bytes);
    slow.download.fetch = async () => { await gate; return new Response(new Uint8Array(bytes)); };
    const first = handleOrdinaryToolAction({ action: "install", tool_id: "lark_cli", version: "9.9.9" }, log, undefined, slow);
    const second = await handleOrdinaryToolAction({ action: "remove", tool_id: "lark_cli", source: "registered" }, log);
    expect(second).toMatchObject({ ok: false, error: expect.stringMatching(/already has an operation in progress/) });
    release();
    expect((await first).ok).toBe(true);
  });
});

describe("version output", () => {
  it("treats a zero exit that prints nothing, or only whitespace, as no version", async () => {
    await script(join(bin, "jq"), "exit 0");
    await script(join(bin, "rg"), 'printf "   \\n\\t\\n"');
    expect(await reported("jq")).toMatchObject({ status: "broken", source: "path", version: null, version_text: null });
    expect(await reported("rg")).toMatchObject({ status: "broken", version: null });
    for (const tool_id of ["jq", "rg"] as const) {
      const refused = await handleOrdinaryToolAction({ action: "register", tool_id, path: null }, log);
      expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/did not answer its version command/) });
      expect(refused.tool).toMatchObject({ status: "broken", registered: false });
    }
    // The same path, once it prints a version, is re-probed and accepted.
    await script(join(bin, "jq"), 'echo "jq-1.7.1"');
    expect(await handleOrdinaryToolAction({ action: "register", tool_id: "jq", path: null }, log)).toMatchObject({
      ok: true, tool: { status: "available", version: "1.7.1" },
    });
  });
});

describe("interrupted replacement", () => {
  const tree = () => join(ordinaryToolsRoot(), "managed", "lark_cli");
  async function installGood() {
    const good = catalogWith("9.9.9", await larkArchive("9.9.9"));
    expect((await handleOrdinaryToolAction({ action: "install", tool_id: "lark_cli", version: "9.9.9" }, log, undefined, good)).ok).toBe(true);
    return {
      manifest: await readFile(join(tree(), "9.9.9", "manifest.json"), "utf8"),
      payload: await readFile(join(tree(), "9.9.9", "lark-cli"), "utf8"),
    };
  }
  /** The state a daemon leaves when it stops after moving the copy aside and before promoting. */
  async function interruptPromotion() {
    await rename(join(tree(), "9.9.9"), join(tree(), "9.9.9.replaced"));
    await mkdir(join(tree(), "9.9.9.installing"), { recursive: true });
    await writeFile(join(tree(), "9.9.9.installing", "archive"), "partial");
  }

  it("restores the set-aside copy on the next report, then keeps it through a failing reinstall", async () => {
    const before = await installGood();
    await interruptPromotion();
    // A restart: the first heartbeat reports before any operation.
    __clearOrdinaryToolVersionCache();
    expect(await reported("lark_cli")).toMatchObject({ status: "available", source: "managed", version: "9.9.9" });
    expect(await readFile(join(tree(), "9.9.9", "manifest.json"), "utf8")).toBe(before.manifest);
    expect((await readdir(tree())).filter((name) => name.endsWith(".replaced"))).toEqual([]);

    // The same interruption, and this time the next thing is an install whose download fails.
    await interruptPromotion();
    const failing = catalogWith("9.9.9", await larkArchive("9.9.9"));
    failing.download.fetch = async () => new Response("unavailable", { status: 503 });
    const result = await handleOrdinaryToolAction({ action: "install", tool_id: "lark_cli", version: "9.9.9" }, log, undefined, failing);
    expect(result.ok).toBe(false);
    expect(result.tool).toMatchObject({ status: "available", source: "managed", version: "9.9.9" });
    expect(await readFile(join(tree(), "9.9.9", "manifest.json"), "utf8")).toBe(before.manifest);
    expect(await readFile(join(tree(), "9.9.9", "lark-cli"), "utf8")).toBe(before.payload);
  });

  it("keeps a completed promotion and removes only its leftover recovery directory", async () => {
    await installGood();
    // The old copy beside a new, valid one: the promotion finished, cleanup did not.
    await mkdir(join(tree(), "9.9.9.replaced"));
    await writeFile(join(tree(), "9.9.9.replaced", "manifest.json"), JSON.stringify({ tool_id: "lark_cli", version: "9.9.9", cmd: "lark-cli", installed_at: "2000-01-01T00:00:00.000Z" }));
    await writeFile(join(tree(), "9.9.9", "marker"), "new");
    expect(await reported("lark_cli")).toMatchObject({ status: "available", version: "9.9.9" });
    expect(await readFile(join(tree(), "9.9.9", "marker"), "utf8")).toBe("new");
    expect(await readdir(tree())).toEqual(["9.9.9"]);
  });

  /** A good copy set aside beside an installed copy whose manifest is valid but whose payload is not. */
  async function damagedBesideGoodAside(damage: (payload: string) => Promise<void>) {
    const before = await installGood();
    await cp(join(tree(), "9.9.9"), join(tree(), "9.9.9.replaced"), { recursive: true });
    await damage(join(tree(), "9.9.9", "lark-cli"));
    __clearOrdinaryToolVersionCache();
    return before;
  }
  const damages: Array<[string, (payload: string) => Promise<void>]> = [
    ["missing", (payload) => rm(payload)],
    ["not executable", (payload) => chmod(payload, 0o644)],
    ["the wrong version", async (payload) => { await script(payload, 'echo "lark-cli version 9.9.8"'); }],
  ];
  for (const [label, damage] of damages) {
    it(`keeps both directories when the installed payload is ${label} and its manifest still reads`, async () => {
      const before = await damagedBesideGoodAside(damage);
      const view = await reported("lark_cli");
      expect(view).toMatchObject({ status: "broken", source: "managed", version: null });
      expect((await readdir(tree())).sort()).toEqual(["9.9.9", "9.9.9.replaced"]);
      let downloads = 0;
      const attempt = catalogWith("9.9.9", await larkArchive("9.9.9"));
      attempt.download.fetch = async () => { downloads += 1; return new Response("x"); };
      const result = await handleOrdinaryToolAction({ action: "install", tool_id: "lark_cli", version: "9.9.9" }, log, undefined, attempt);
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/does not verify; both were kept/), tool: { status: "broken" } });
      expect(downloads).toBe(0);
      // The recoverable copy is intact, payload and manifest.
      expect(await readFile(join(tree(), "9.9.9.replaced", "manifest.json"), "utf8")).toBe(before.manifest);
      expect(await readFile(join(tree(), "9.9.9.replaced", "lark-cli"), "utf8")).toBe(before.payload);
    });
  }

  it("does not restore a recovery source that does not verify", async () => {
    await installGood();
    await rename(join(tree(), "9.9.9"), join(tree(), "9.9.9.replaced"));
    await script(join(tree(), "9.9.9.replaced", "lark-cli"), 'echo "lark-cli version 1.0.0"');
    __clearOrdinaryToolVersionCache();
    expect(await reported("lark_cli")).toMatchObject({ status: "broken", source: "managed" });
    expect(await readdir(tree())).toEqual(["9.9.9.replaced"]);
    await chmod(join(tree(), "9.9.9.replaced", "lark-cli"), 0o644);
    expect(await reported("lark_cli")).toMatchObject({ status: "broken" });
    expect(await readdir(tree())).toEqual(["9.9.9.replaced"]);
  });

  it("reports an unrecoverable state as broken, keeps the evidence, and downloads nothing", async () => {
    await installGood();
    await rename(join(tree(), "9.9.9"), join(tree(), "9.9.9.replaced"));
    await rm(join(tree(), "9.9.9.replaced", "manifest.json"));
    expect(await reported("lark_cli")).toMatchObject({ status: "broken", source: "managed", version: null });
    let downloads = 0;
    const attempt = catalogWith("9.9.9", await larkArchive("9.9.9"));
    attempt.download.fetch = async () => { downloads += 1; return new Response("x"); };
    const result = await handleOrdinaryToolAction({ action: "install", tool_id: "lark_cli", version: "9.9.9" }, log, undefined, attempt);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/kept for inspection/), tool: { status: "broken" } });
    expect(downloads).toBe(0);
    expect(await readFile(join(tree(), "9.9.9.replaced", "lark-cli"), "utf8")).toContain("lark-cli version 9.9.9");
  });
});

describe("ordinary tool wire contract", () => {
  it("carries a catalog tool id and version only", () => {
    const base = { type: "ordinary_tool_request", request_id: "req-1" };
    expect(HostServerFrameSchema.safeParse({ ...base, operation: { action: "install", tool_id: "lark_cli", version: "1.0.99" } }).success).toBe(true);
    expect(HostServerFrameSchema.safeParse({ ...base, operation: { action: "install", tool_id: "lark_cli", version: "latest" } }).success).toBe(false);
    expect(HostServerFrameSchema.safeParse({ ...base, operation: { action: "install", tool_id: "lark_cli", version: "1.0.99", archive: "https://x/y.tgz" } }).success).toBe(false);
    expect(HostServerFrameSchema.safeParse({ ...base, operation: { action: "register", tool_id: "bash", path: null } }).success).toBe(false);
    expect(HostServerFrameSchema.safeParse({ ...base, operation: { action: "register", tool_id: "jq", path: "/usr/bin/jq", command: "sh -c id" } }).success).toBe(false);
  });
});
