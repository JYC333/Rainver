import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearFailedRuntimeOptionsCache,
  clearRuntimeOptionsCache,
  detectCapabilities,
  __clearRuntimeOptionsCache,
  type RuntimeLookup,
} from "../src/capabilities.js";
import { toolsDir } from "../src/tools.js";

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

  it("does not advertise a vendor runtime until its adapter is ready", async () => {
    const lookup: RuntimeLookup[] = [{ adapter_type: "test_adapter", runtime: "git", login: null }];
    const unavailable = await detectCapabilities(undefined, lookup, async () => false);
    expect(unavailable.installations.test_adapter).toBeUndefined();

    const available = await detectCapabilities(undefined, lookup, async () => true);
    expect(available.installations.test_adapter?.[0]?.id).toBe("own");
  });
});

describe("what a runtime says it can be set to", () => {
  afterEach(() => { __clearRuntimeOptionsCache(); });

  it("preserves the runtime's generic ACP config options on the copy they belong to", async () => {
    __clearRuntimeOptionsCache();
    const capabilities = await detectCapabilities(async () => ({
      config_options: [{
        id: "effort", name: "Effort", description: null, category: "thought_level",
        type: "select" as const, current_value: "high",
        options: ["low", "high", "xhigh"].map(value => ({ value, name: value, description: null, group: null })),
      }],
    }), VENDORS);

    for (const copies of Object.values(capabilities.installations)) {
      for (const copy of copies) {
        expect(copy.options?.config_options[0]).toMatchObject({ id: "effort", current_value: "high" });
      }
    }
  });

  it("reports no options when the ACP runtime cannot be asked", async () => {
    const copy = own(await detectCapabilities(async () => null, VENDORS), "codex_cli");
    if (!copy) return;
    expect(copy.options).toBeNull();
  });

  it("retries failed option probes after a control-plane reconnect", async () => {
    __clearRuntimeOptionsCache();
    const installedLookup: RuntimeLookup[] = [{ adapter_type: "test", runtime: "git", login: null }];
    let available = false;
    let asks = 0;
    const ask = async () => {
      asks += 1;
      return available ? { config_options: [] } : null;
    };
    await detectCapabilities(ask, installedLookup);
    const failedAsks = asks;
    available = true;
    await detectCapabilities(ask, installedLookup);
    expect(asks).toBe(failedAsks);

    clearFailedRuntimeOptionsCache();
    await detectCapabilities(ask, installedLookup);
    expect(asks).toBeGreaterThan(failedAsks);
  }, 15_000);

  it("asks each copy once, not on every heartbeat", async () => {
    // Every ask starts an agent process; the answer changes only when the CLI
    // is reconfigured or upgraded.
    __clearRuntimeOptionsCache();
    let asks = 0;
    const ask = async () => {
      asks += 1;
      return {
        config_options: [],
      };
    };
    const first = await detectCapabilities(ask, VENDORS);
    const asksAfterFirst = asks;
    await detectCapabilities(ask, VENDORS);
    expect(asks).toBe(asksAfterFirst);
    expect(asksAfterFirst).toBeLessThanOrEqual(Object.values(first.installations).flat().length);
  }, 15_000);

  it("reports generic ACP authentication state and refreshes it after login", async () => {
    __clearRuntimeOptionsCache();
    const lookup: RuntimeLookup[] = [{ adapter_type: "test", runtime: "git", login: null }];
    let authenticated = false;
    let asks = 0;
    const ask = async () => {
      asks += 1;
      return {
        config_options: [],
        auth_methods: [{ id: "browser", name: "Browser", description: null, type: "agent" as const, args: [], env: {} }],
        authenticated,
      };
    };
    expect(own(await detectCapabilities(ask, lookup), "test")).toMatchObject({ logged_in: false });
    authenticated = true;
    expect(own(await detectCapabilities(ask, lookup), "test")).toMatchObject({ logged_in: false });
    clearRuntimeOptionsCache("test", "own");
    expect(own(await detectCapabilities(ask, lookup), "test")).toMatchObject({ logged_in: true });
    expect(asks).toBe(2);
  });

  it("keeps an explicit built-in login flow authoritative", async () => {
    __clearRuntimeOptionsCache();
    const login = { command: ["git", "credential"], home_subdir: ".missing", credential_file: "auth" };
    const copy = own(await detectCapabilities(async () => ({
      config_options: [],
      auth_methods: [{ id: "generic", name: "Generic", description: null, type: "agent" as const, args: [], env: {} }],
      authenticated: true,
    }), [{ adapter_type: "test", runtime: "git", login }]), "test");
    expect(copy?.logged_in).toBe(false);
    expect(copy?.options?.auth_methods).toEqual([]);
  });

  it("adds a proven fixed CLI login without hiding ACP auth for a managed copy", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "rainver-cli-login-capability-"));
    const previous = process.env.RAINVER_HOST_CONFIG_DIR;
    process.env.RAINVER_HOST_CONFIG_DIR = configDir;
    try {
      const dir = join(toolsDir(), "cli_login_test", "1.0.0");
      const home = join(dir, "home");
      const script = join(dir, "agent.cjs");
      await mkdir(home, { recursive: true });
      await writeFile(script, "process.exit(process.argv[2] === 'login' && process.argv[3] === '--help' ? 0 : 1)\n");
      await writeFile(join(dir, "manifest.json"), JSON.stringify({
        adapter_type: "cli_login_test", version: "1.0.0", command: process.execPath,
        args: [script, "acp"], entry_args: [script], env: {}, home, login_command: null, login: null, installed_at: "",
      }));
      __clearRuntimeOptionsCache();
      const capabilities = await detectCapabilities(async () => ({
        config_options: [], authenticated: false,
        auth_methods: [{ id: "existing", name: "Existing login", description: null, type: "agent", args: [], env: {} }],
      }), [{ adapter_type: "cli_login_test", runtime: null, login: null }]);
      expect(capabilities.installations.cli_login_test?.[0]?.options).toMatchObject({
        auth_methods: [expect.objectContaining({ id: "existing", name: "Existing login", type: "agent" })],
        cli_login_available: true,
      });
    } finally {
      if (previous === undefined) delete process.env.RAINVER_HOST_CONFIG_DIR;
      else process.env.RAINVER_HOST_CONFIG_DIR = previous;
      await rm(configDir, { recursive: true, force: true });
      __clearRuntimeOptionsCache();
    }
  });
});
