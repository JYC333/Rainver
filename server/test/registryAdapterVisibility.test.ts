import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setDynamicRuntimeAdapterSpecs } from "../src/modules/runtimeAdapters/dynamicSpecs.js";
import { acpAgentRuntimeKey, acpAgentRuntimeAdapterSpec } from "../src/modules/acpAgents/service.js";
import { getRuntimeAdapterSpec } from "../src/modules/runtimeAdapters/specs.js";
import { acpRuntimeProbes, ownCopyCandidates } from "../src/modules/hosts/runtimeProbes.js";
import { MAX_REGISTRY_ID_LENGTH, parseEntry } from "../src/modules/acpAgents/registry.js";
import { buildUnboundRuntimeProfile } from "../src/modules/runs/remoteProviderBinding.js";
import { RuntimeKeySchema } from "@rainver/protocol";
import type { EnabledAcpAgent } from "../src/modules/acpAgents/settings.js";

/**
 * An ACP agent enabled from the registry is a runtime adapter like any other,
 * but it is never in `BUILTIN_RUNTIME_ADAPTER_SPECS` — it is published into
 * the dynamic catalog at boot. Do not read the builtin table for it. The
 * agent is invisible there, and dispatch answers "Unknown runtime_key".
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
} satisfies EnabledAcpAgent;

describe("a registry ACP agent is a runtime adapter everywhere", () => {
  afterEach(() => setDynamicRuntimeAdapterSpecs([]));

  it("drops a registry entry whose id would not fit the wire's runtime_key", () => {
    const entry = (id: string) => ({
      id,
      name: "Long",
      version: "1.0.0",
      distribution: { kind: "npx", package: "long@1", args: [], env: {} },
    });
    const longest = "a".repeat(MAX_REGISTRY_ID_LENGTH);
    expect(parseEntry(entry(longest))?.id).toBe(longest);
    expect(RuntimeKeySchema.safeParse(acpAgentRuntimeKey(longest)).success).toBe(true);
    // One over, and every daemon would refuse the hello_ack carrying its probe.
    expect(parseEntry(entry(`${longest}a`))).toBeNull();
  });

  it("resolves through the accessor once published", () => {
    expect(getRuntimeAdapterSpec(acpAgentRuntimeKey("cursor"))).toBeNull();
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
        // Do not subscript the table. Re-exporting or iterating it is fine.
        if (/BUILTIN_RUNTIME_ADAPTER_SPECS\s*\[/.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    walk(join(import.meta.dirname, "..", "src"));
    expect(offenders).toEqual([]);
  });

  it("installs a registry agent at the version its entry names, whatever its distribution kind", () => {
    // The version lives on the registry entry, never inside the distribution:
    // only an npm package string happens to repeat it. Parsing it from there
    // left every binary (and uvx) agent with no version, which the install
    // route reads as "no distribution to install from".
    const binary = {
      ...CURSOR,
      id: "antigravity-acp",
      version: "1.4.3",
      distribution: {
        kind: "binary",
        platforms: { "linux-x86_64": { archive: "https://x/agy.zip", cmd: "./agy", args: [], sha256: null, env: {} } },
      },
    } satisfies EnabledAcpAgent;
    const uvx = { ...CURSOR, id: "pyagent", version: "0.9.0", distribution: { kind: "uvx", package: "pyagent", args: [], env: {} } } satisfies EnabledAcpAgent;
    const npx = { ...CURSOR, id: "cursor", version: "2026.09.02", distribution: { kind: "npx", package: "cursor@2026.09.01", args: [], env: {} } } satisfies EnabledAcpAgent;
    setDynamicRuntimeAdapterSpecs([binary, uvx, npx].map(acpAgentRuntimeAdapterSpec));
    const probes = acpRuntimeProbes();
    const probe = (key: string) => probes.find((candidate) => candidate.runtime_key === key);
    expect(probe("acp_antigravity_acp")).toMatchObject({ version: "1.4.3", distribution: { kind: "binary" } });
    expect(probe("acp_pyagent")).toMatchObject({ version: "0.9.0", distribution: { kind: "uvx" } });
    // The entry's version wins over the package string's: it is what the snapshot was taken at.
    expect(probe("acp_cursor")).toMatchObject({ version: "2026.09.02" });
  });

  it("tells the daemon where a registry agent's own copy might be, from its distribution", () => {
    // ACP has no discovery; the registry's launch description is the only
    // hint of what an owner-installed copy is called. The daemon verifies
    // each candidate by handshake, so a wrong guess costs nothing.
    expect(ownCopyCandidates({
      kind: "binary",
      platforms: {
        "linux-x86_64": { archive: "https://x/l.zip", cmd: "./dist-package/cursor-agent", args: ["acp"], sha256: null, env: {} },
        "darwin-aarch64": { archive: "https://x/d.zip", cmd: "./dist-package/cursor-agent", args: ["acp"], sha256: null, env: {} },
        "windows-x86_64": { archive: "https://x/w.zip", cmd: ".\\cursor-agent.exe", args: ["acp"], sha256: null, env: {} },
      },
    })).toEqual([
      { kind: "binary", command: "cursor-agent", args: ["acp"] },
      { kind: "binary", command: "cursor-agent.exe", args: ["acp"] },
    ]);
    expect(ownCopyCandidates({ kind: "npx", package: "@google/gemini-cli@0.65.0", args: ["--acp"], env: {} }))
      .toEqual([{ kind: "npm", package: "@google/gemini-cli", args: ["--acp"] }]);
    expect(ownCopyCandidates({ kind: "uvx", package: "fast-agent-acp==0.10.1", args: [], env: {} }))
      .toEqual([{ kind: "binary", command: "fast-agent-acp", args: [] }]);

    // A registry agent's probe carries them; a builtin names its PATH binary instead.
    setDynamicRuntimeAdapterSpecs([acpAgentRuntimeAdapterSpec(CURSOR)]);
    const probes = acpRuntimeProbes();
    expect(probes.find((probe) => probe.runtime_key === "acp_cursor")).toMatchObject({
      runtime: null,
      own_candidates: [{ kind: "npm", package: "cursor", args: [] }],
    });
    expect(probes.find((probe) => probe.runtime_key === "claude_code")?.own_candidates).toBeUndefined();
  });

  it("isolates a registry agent's state by Agent once its state boundary is known, and fails closed until then", () => {
    // The registry says how to obtain and launch an agent, never where it
    // keeps its state or credential; that comes from the boundary table. With
    // it, an unbound Run gets a per-Agent profile whose state-root variable
    // points inside and whose credential is linked from the login home —
    // the same contract the builtins declare beside their CLI login command.
    const antigravity = { ...CURSOR, id: "antigravity-acp", name: "Google Antigravity" } satisfies EnabledAcpAgent;
    setDynamicRuntimeAdapterSpecs([acpAgentRuntimeAdapterSpec(CURSOR), acpAgentRuntimeAdapterSpec(antigravity)]);
    const scope = { agent_id: "agent-1", container_kind: "conversation" as const, container_id: "conv-1" };

    expect(getRuntimeAdapterSpec("acp_antigravity_acp")?.credentials.state).toEqual({
      env: { GEMINI_HOME: ".gemini" },
      home_subdir: ".gemini/antigravity-acp",
      credential_file: "acp_token.json",
    });
    expect(getRuntimeAdapterSpec("acp_antigravity_acp")?.credentials.login).toBeUndefined();
    expect(buildUnboundRuntimeProfile("acp_antigravity_acp", scope)).toMatchObject({
      profile_env: { GEMINI_HOME: ".gemini" },
      credential_source: "host_login",
      login_link: { home_subdir: ".gemini/antigravity-acp", credential_file: "acp_token.json" },
    });
    // Login is ACP Agent Auth here, so the probe carries the boundary without a CLI command.
    expect(acpRuntimeProbes().find((probe) => probe.runtime_key === "acp_antigravity_acp")).toMatchObject({
      login: null,
      state: { env: { GEMINI_HOME: ".gemini" }, home_subdir: ".gemini/antigravity-acp", credential_file: "acp_token.json" },
    });

    // An agent nobody has described keeps failing closed rather than sharing one home across Agents.
    expect(getRuntimeAdapterSpec("acp_cursor")?.credentials.state).toBeUndefined();
    expect(() => buildUnboundRuntimeProfile("acp_cursor", scope)).toThrow(/state boundary/);
  });

  it("names every probe by runtime_key alone", () => {
    const probes = acpRuntimeProbes();
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((probe) => typeof probe.runtime_key === "string" && probe.runtime_key.length > 0)).toBe(true);
    expect(probes.some((probe) => "adapter_type" in probe)).toBe(false);
  });
});
