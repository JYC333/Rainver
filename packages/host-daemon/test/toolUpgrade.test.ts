import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installedTools, managedVersionsFor, rollbackTargetFor, rollbackTool } from "../src/tools.js";
import { adapterIsBeingReplaced, holdingAdapter, withAdapterDrained } from "../src/execution.js";

/**
 * Upgrading a copy replaces the runtime every Run of that Agent uses, so ADR
 * 0016 §9 keeps exactly one version behind the current one: the
 * previous directory still holds its own login, which is what makes rolling
 * back a step rather than a re-login.
 */
let configDir: string;

async function seed(adapterType: string, version: string, installedAt: string): Promise<void> {
  const tree = join(configDir, "tools", adapterType, version);
  await mkdir(join(tree, "home"), { recursive: true });
  await writeFile(join(tree, "manifest.json"), JSON.stringify({
    adapter_type: adapterType, version, command: "/bin/true", args: [], env: {},
    home: join(tree, "home"), login_command: null, login: null, installed_at: installedAt,
  }));
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "rainver-tool-upgrade-"));
  process.env.RAINVER_HOST_CONFIG_DIR = configDir;
});

afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(configDir, { recursive: true, force: true });
});

describe("one current copy per adapter, with one kept behind it", () => {
  it("orders versions by when they were installed, not by their names", async () => {
    // A vendor's "1.9" can follow its "1.10"; install order is the only thing
    // that says which copy is the current one.
    await seed("codex_cli", "1.10.0", "2026-09-01T00:00:00.000Z");
    await seed("codex_cli", "1.9.0", "2026-09-05T00:00:00.000Z");
    expect(managedVersionsFor("codex_cli").map((manifest) => manifest.version)).toEqual(["1.9.0", "1.10.0"]);
    expect(rollbackTargetFor("codex_cli")?.version).toBe("1.10.0");
  });

  it("reports only the current copy, so the host card shows one Agent", async () => {
    await seed("codex_cli", "1.0.0", "2026-09-01T00:00:00.000Z");
    await seed("codex_cli", "2.0.0", "2026-09-05T00:00:00.000Z");
    const reported = await installedTools();
    expect(reported.get("codex_cli")?.map((manifest) => manifest.version)).toEqual(["2.0.0"]);
  });

  it("promotes the previous copy, with the login it already had", async () => {
    await seed("codex_cli", "1.0.0", "2026-09-01T00:00:00.000Z");
    await seed("codex_cli", "2.0.0", "2026-09-05T00:00:00.000Z");
    await writeFile(join(configDir, "tools", "codex_cli", "1.0.0", "home", "auth.json"), "{}");

    const promoted = await rollbackTool("codex_cli");

    expect(promoted?.version).toBe("1.0.0");
    // The point of keeping the directory: rolling back asks nobody to log in.
    expect(managedVersionsFor("codex_cli").map((manifest) => manifest.version)).toEqual(["1.0.0"]);
    await expect(rm(join(configDir, "tools", "codex_cli", "1.0.0", "home", "auth.json"))).resolves.toBeUndefined();
  });

  it("refuses a rollback with nothing to roll back to rather than removing the only copy", async () => {
    await seed("codex_cli", "1.0.0", "2026-09-01T00:00:00.000Z");
    expect(await rollbackTool("codex_cli")).toBeNull();
    expect(managedVersionsFor("codex_cli")).toHaveLength(1);
    expect(rollbackTargetFor("codex_cli")).toBeNull();
  });
});

describe("a replacement holds the adapter closed, not merely drained", () => {
  it("refuses a launch of the copy being replaced, and reopens afterwards", async () => {
    let observedDuring: boolean | null = null;
    const result = await withAdapterDrained("codex_cli", 5_000, async () => {
      // A drain that reports quiet and then downloads for a minute is a window
      // in which the next dispatch starts against the copy about to be
      // deleted. The door has to stay shut for the whole replacement.
      observedDuring = adapterIsBeingReplaced("codex_cli");
      return "replaced";
    });

    expect(result).toBe("replaced");
    expect(observedDuring).toBe(true);
    expect(adapterIsBeingReplaced("codex_cli")).toBe(false);
  });

  it("leaves other adapters alone", async () => {
    await withAdapterDrained("codex_cli", 5_000, async () => {
      expect(adapterIsBeingReplaced("claude_code")).toBe(false);
    });
  });

  it("reopens the door even when the replacement fails", async () => {
    await expect(withAdapterDrained("codex_cli", 5_000, () => Promise.reject(new Error("download failed"))))
      .rejects.toThrow("download failed");
    // Otherwise one failed upgrade would refuse every later Run of that
    // runtime until the daemon restarted.
    expect(adapterIsBeingReplaced("codex_cli")).toBe(false);
  });

  it("refuses a second concurrent change rather than interleaving two", async () => {
    let release!: () => void;
    const held = withAdapterDrained("codex_cli", 5_000, () => new Promise<void>((resolve) => { release = resolve; }));
    await expect(withAdapterDrained("codex_cli", 5_000, async () => undefined))
      .rejects.toThrow(/already in progress/);
    release();
    await held;
  });
});

describe("a replacement waits for work already running", () => {
  it("drains for a verification command that is in neither run registry", async () => {
    let finishCommand!: () => void;
    const command = holdingAdapter("codex_cli", () => new Promise<void>((resolve) => { finishCommand = resolve; }));

    let replaced = false;
    const replacement = withAdapterDrained("codex_cli", 5_000, async () => { replaced = true; });
    // The order the closed door alone does not cover: the work started first,
    // so only being counted keeps the replacement from deleting the tree it is
    // executing from.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(replaced).toBe(false);

    finishCommand();
    await command;
    await replacement;
    expect(replaced).toBe(true);
  });

  it("gives up rather than killing the work it is waiting for", async () => {
    let finishCommand!: () => void;
    const command = holdingAdapter("codex_cli", () => new Promise<void>((resolve) => { finishCommand = resolve; }));

    await expect(withAdapterDrained("codex_cli", 600, async () => undefined))
      .rejects.toThrow(/still using codex_cli/);

    finishCommand();
    await command;
  });

  it("releases its hold when the work throws", async () => {
    await expect(holdingAdapter("codex_cli", () => Promise.reject(new Error("recipe failed"))))
      .rejects.toThrow("recipe failed");
    // Otherwise one failed recipe would block every later upgrade of that
    // runtime until the daemon restarted.
    await expect(withAdapterDrained("codex_cli", 600, async () => "replaced")).resolves.toBe("replaced");
  });
});
