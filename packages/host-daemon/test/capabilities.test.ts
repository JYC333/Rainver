import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectCapabilities, __clearRuntimeOptionsCache, type RuntimeLookup } from "../src/capabilities.js";

/** What the server names in `hello_ack`; the daemon looks for nothing else but git. */
const VENDORS: RuntimeLookup[] = [
  { adapter_type: "claude_code", runtime: "claude", login: null },
  { adapter_type: "codex_cli", runtime: "codex", login: null },
  { adapter_type: "opencode", runtime: "opencode", login: null },
];

/** The machine's own copy of an adapter, if this machine has the binary. */
function own(capabilities: Awaited<ReturnType<typeof detectCapabilities>>, adapterType: string) {
  return capabilities.installations[adapterType]?.find((entry) => entry.id === "own") ?? null;
}

describe("capability discovery", () => {
  it("detects git, which every environment running this test suite has installed", async () => {
    const capabilities = await detectCapabilities();
    expect(capabilities.runtimes).toContain("git");
    expect(capabilities.versions.git).toMatch(/git version/i);
  });

  it("looks only for the runtimes the server named, plus git", async () => {
    const capabilities = await detectCapabilities(undefined, [{ adapter_type: "x", runtime: "definitely-not-a-binary-on-path", login: null }]);
    expect(capabilities.runtimes).toEqual(["git"]);
    expect(capabilities.installations).toEqual({});
  });

  it("never throws for a binary that is not on PATH — it is simply absent from the result", async () => {
    const capabilities = await detectCapabilities(undefined, VENDORS);
    // claude/codex/opencode are not guaranteed to be installed in a CI
    // environment; the contract under test is "absent, not thrown".
    for (const lookup of VENDORS) {
      if (!capabilities.runtimes.includes(lookup.runtime!)) {
        expect(capabilities.versions[lookup.runtime!]).toBeUndefined();
        expect(capabilities.installations[lookup.adapter_type]).toBeUndefined();
      }
    }
  });
});

// What an unbound run will actually execute on. With no binding the model is
// the CLI's own business, and the control plane has no other way to learn it —
// leaving it unstated is what made "this machine's login" an unanswerable
// answer to "which model am I about to use".
describe("the model each installed CLI is configured to use", () => {
  const dirs: string[] = [];
  const saved = { ...process.env };

  afterEach(async () => {
    process.env = { ...saved };
    __clearRuntimeOptionsCache();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "rainver-model-"));
    dirs.push(dir);
    return dir;
  }

  it("reads Codex's top-level model, not one belonging to a profile", async () => {
    const home = await tempDir();
    await writeFile(
      join(home, "config.toml"),
      // The profile table is the trap: its `model` is that profile's, and
      // reporting it would name a model the default invocation never uses.
      'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n\n[profiles.other]\nmodel = "gpt-5.6-luna"\n',
    );
    process.env.CODEX_HOME = home;

    const capabilities = await detectCapabilities(undefined, VENDORS);
    const copy = own(capabilities, "codex_cli");
    if (!copy) return;
    expect(copy.options).toMatchObject({ current_model: "gpt-5.6-sol", current_effort: "high" });
  });

  it("splits an effort that rides on the model id, which is how both CLIs write it", async () => {
    // `model[effort]` — the same encoding Codex's ModelId uses and Claude's
    // settings file carries. Reporting the whole string as the model would
    // name a model that does not exist.
    const home = await tempDir();
    await writeFile(join(home, "settings.json"), JSON.stringify({ model: "claude-fable-5[1m]" }));
    process.env.CLAUDE_CONFIG_DIR = home;

    const copy = own(await detectCapabilities(undefined, VENDORS), "claude_code");
    if (!copy) return;
    expect(copy.options).toMatchObject({ current_model: "claude-fable-5", current_effort: "1m" });
  });

  it("prefers Codex's own effort key over a bracket suffix", async () => {
    // Codex reads `model_reasoning_effort`; a suffix on the model id is the
    // other spelling of the same thing, and the key is the one that wins.
    const home = await tempDir();
    await writeFile(join(home, "config.toml"), 'model = "gpt-5.6-sol[low]"\nmodel_reasoning_effort = "high"\n');
    process.env.CODEX_HOME = home;

    const copy = own(await detectCapabilities(undefined, VENDORS), "codex_cli");
    if (!copy) return;
    expect(copy.options).toMatchObject({ current_model: "gpt-5.6-sol", current_effort: "high" });
  });

  it("reads Claude's configured model from the settings file it is pointed at", async () => {
    const home = await tempDir();
    await writeFile(join(home, "settings.json"), JSON.stringify({ switchModelsOnFlag: true, model: "claude-sonnet-9" }));
    process.env.CLAUDE_CONFIG_DIR = home;

    const copy = own(await detectCapabilities(undefined, VENDORS), "claude_code");
    if (!copy) return;
    expect(copy.options?.current_model).toBe("claude-sonnet-9");
  });

  it("reports nothing rather than guessing when a CLI pins no model", async () => {
    const home = await tempDir();
    await writeFile(join(home, "config.toml"), 'model_reasoning_effort = "high"\n');
    process.env.CODEX_HOME = home;

    const copy = own(await detectCapabilities(undefined, VENDORS), "codex_cli");
    if (!copy) return;
    expect(copy.options?.current_model ?? null).toBeNull();
  });

  it("costs the model name, never the heartbeat, when a config does not parse", async () => {
    const home = await tempDir();
    await mkdir(join(home, "codex"), { recursive: true });
    await writeFile(join(home, "codex", "config.toml"), "this is not toml {{{");
    process.env.CODEX_HOME = join(home, "codex");
    process.env.CLAUDE_CONFIG_DIR = join(home, "does-not-exist");

    await expect(detectCapabilities(undefined, VENDORS)).resolves.toMatchObject({ runtimes: expect.any(Array) });
  });
});

describe("what a runtime says it can be set to", () => {
  afterEach(() => { __clearRuntimeOptionsCache(); });

  it("prefers the runtime's own answer over anything read from a config, on the copy it belongs to", async () => {
    // Guessing was wrong in both directions: Claude's effort levels include
    // `default`, `xhigh` and `max`, and its model ids carry their own brackets
    // (`claude-fable-5[1m]`), so a model and an effort cannot be recovered by
    // splitting one string. Only the runtime knows.
    __clearRuntimeOptionsCache();
    const capabilities = await detectCapabilities(async () => ({
      models: [
        { value: "default", name: "Default (recommended)", description: "Opus (1M context)" },
        { value: "claude-fable-5[1m]", name: "Fable", description: null },
        { value: "sonnet", name: "Sonnet", description: null },
      ],
      current_model: "claude-fable-5[1m]",
      efforts: ["default", "low", "medium", "high", "xhigh", "max"]
        .map((value) => ({ value, name: value, description: null })),
      current_effort: "high",
    }), VENDORS);

    for (const copies of Object.values(capabilities.installations)) {
      for (const copy of copies) {
        expect(copy.options?.efforts.map((e) => e.value)).toContain("xhigh");
        // The model id keeps its own brackets — they are part of its name.
        expect(copy.options?.current_model).toBe("claude-fable-5[1m]");
        expect(copy.options?.current_effort).toBe("high");
      }
    }
  });

  it("falls back to the config when a runtime cannot be asked", async () => {
    // Not installed, not logged in, or too slow — a probe that cannot answer
    // costs the option list, never the heartbeat carrying it.
    __clearRuntimeOptionsCache();
    const home = await mkdtemp(join(tmpdir(), "rainver-model-"));
    await writeFile(join(home, "config.toml"), 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n');
    process.env.CODEX_HOME = home;
    try {
      const copy = own(await detectCapabilities(async () => null, VENDORS), "codex_cli");
      if (!copy) return;
      expect(copy.options).toEqual({ models: [], current_model: "gpt-5.6-sol", efforts: [], current_effort: "high" });
    } finally {
      process.env.CODEX_HOME = undefined;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("asks each copy once, not on every heartbeat", async () => {
    // Every ask starts an agent process; the answer changes only when the CLI
    // is reconfigured or upgraded.
    __clearRuntimeOptionsCache();
    let asks = 0;
    const ask = async () => {
      asks += 1;
      return {
        models: [{ value: "m", name: null, description: null }],
        current_model: "m",
        efforts: [{ value: "high", name: null, description: null }],
        current_effort: "high",
      };
    };
    const first = await detectCapabilities(ask, VENDORS);
    const asksAfterFirst = asks;
    await detectCapabilities(ask, VENDORS);
    expect(asks).toBe(asksAfterFirst);
    expect(asksAfterFirst).toBeLessThanOrEqual(Object.values(first.installations).flat().length);
  });
});
