import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setDynamicRuntimeAdapterSpecs } from "../src/modules/runtimeAdapters/dynamicSpecs.js";
import { acpAgentAdapterType, acpAgentRuntimeAdapterSpec } from "../src/modules/acpAgents/service.js";
import { getRuntimeAdapterSpec } from "../src/modules/runtimeAdapters/specs.js";

/**
 * An ACP agent enabled from the registry is a runtime adapter like any other,
 * but it is never in `BUILTIN_RUNTIME_ADAPTER_SPECS` — it is published into
 * the dynamic catalog at boot. Reading the builtin table directly therefore
 * makes it invisible, which is how "Unknown adapter_type" came back for a
 * Cursor agent the operator had enabled and installed on a host.
 */
const CURSOR = {
  id: "cursor",
  name: "Cursor",
  description: "Cursor's coding agent",
  version: "2026.09.02",
  license: "proprietary",
  icon: null,
  repository: null,
  distribution: { kind: "npx", package: "cursor@1", args: [], env: {} },
  enabled_at: "2026-09-07T01:18:48.823Z",
  enabled_by_user_id: null,
} as never;

describe("a registry ACP agent is a runtime adapter everywhere", () => {
  afterEach(() => setDynamicRuntimeAdapterSpecs([]));

  it("resolves through the accessor once published", () => {
    expect(getRuntimeAdapterSpec(acpAgentAdapterType("cursor"))).toBeNull();
    setDynamicRuntimeAdapterSpecs([acpAgentRuntimeAdapterSpec(CURSOR)]);
    expect(getRuntimeAdapterSpec("acp_cursor")?.runtime_kind).toBe("local_cli");
  });

  it("is never looked up through the builtin table outside the spec module", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!path.endsWith(".ts") || path.endsWith("runtimeAdapters/specs.ts")) continue;
        // Subscripting the table is the bug; re-exporting or iterating it is not.
        if (/BUILTIN_RUNTIME_ADAPTER_SPECS\s*\[/.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    walk(join(import.meta.dirname, "..", "src"));
    expect(offenders).toEqual([]);
  });
});
