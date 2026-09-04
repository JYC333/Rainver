import { afterEach, describe, expect, it } from "vitest";
import {
  clearFailedRuntimeOptionsCache,
  detectCapabilities,
  __clearRuntimeOptionsCache,
  type RuntimeLookup,
} from "../src/capabilities.js";

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
});
