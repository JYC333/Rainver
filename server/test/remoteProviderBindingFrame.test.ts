import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { __setProvidersDbPortForTests } from "../src/modules/providers/dbReader.js";
import {
  ProviderProxyLeaseRegistry,
  setProviderProxyBaseUrlForProcess,
} from "../src/modules/providers/proxy/lease.js";
import {
  buildRemoteProviderBinding,
  PROFILE_ROOT_PLACEHOLDER,
  RemoteProviderBindingError,
  type RuntimeProfileScope,
} from "../src/modules/runs/remoteProviderBinding.js";
import type { AgentRunRecord } from "../src/modules/runs/repository.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";

/**
 * The provider binding frame is what a bound Run's runtime actually reads on
 * the execution host. Two of its invariants are live — a wrong value produces
 * a runtime that silently ignores the bound provider rather than an error —
 * and neither had a test:
 *
 *  - Codex's `config.toml` must point `model_catalog_json` at the catalog file
 *    the same frame writes. They are two entries in one `files` array, related
 *    only by a shared path string.
 *  - A bound Codex or OpenCode Run refuses without a model, *before* a lease
 *    is minted, so a Run the runtime would have executed on a built-in default
 *    never gets a token that can spend the server-held key. Claude is exempt:
 *    its model comes from the environment the frame sets.
 */

/** The Run executor's policy seam, allowing: these tests cover the frame. */
const allowCredentialSpend = async () => ({ status: "allow" as const, policy_decision_record_id: null });

const hostRow = {
  query: async () => ({ rows: [{ provider_proxy_base_url: null, kind: "remote" }], rowCount: 1 }),
} as unknown as Queryable;

const scope: RuntimeProfileScope = {
  agent_id: "agent-1",
  container_kind: "agent",
  container_id: "agent-1",
};

function run(): AgentRunRecord {
  return {
    id: "run-1",
    space_id: "space-1",
    agent_id: "agent-1",
    agent_version_id: "agent-version-1",
    execution_kind: "agent",
    status: "queued",
    mode: "live",
    prompt: "do the thing",
    instruction: null,
    project_folder_id: null,
    session_id: null,
    project_id: null,
    model_provider_id: null,
    required_sandbox_level: "none",
    trigger_origin: "manual",
    instructed_by_user_id: "user-1",
    owner_user_id: "user-1",
    started_at: null,
    ended_at: null,
  } as AgentRunRecord;
}

function bind(input: {
  runtimeKey: string;
  model: string | null;
  provider: Record<string, unknown>;
  leaseRegistry: ProviderProxyLeaseRegistry;
}) {
  __setProvidersDbPortForTests({ async getProvider() { return input.provider; } } as never);
  return buildRemoteProviderBinding({
    config: loadConfig({ PROVIDER_PROXY_PORT: "8021", FRONTEND_URL: "http://192.168.1.5:3000" }),
    run: run(),
    hostId: "host-1",
    runtimeKey: input.runtimeKey,
    binding: { provider_id: "prov-1", model: input.model },
    scope,
    ttlSeconds: 60,
    leaseRegistry: input.leaseRegistry,
    db: hostRow,
    enforcer: allowCredentialSpend,
  });
}

afterEach(() => {
  __setProvidersDbPortForTests(null);
});

describe("remote provider binding frame", () => {
  it("points Codex's config at the catalog the same frame writes", async () => {
    setProviderProxyBaseUrlForProcess("http://server:8021", null);
    const leases = new ProviderProxyLeaseRegistry();
    const binding = await bind({
      runtimeKey: "codex_cli",
      model: "MiniMax-M3",
      provider: {
        id: "prov-1",
        name: "MiniMax",
        provider_type: "openai",
        openai_compatible_base_url: "https://api.minimaxi.com/v1",
        available_models: ["MiniMax-M3", "MiniMax-M2"],
      },
      leaseRegistry: leases,
    });
    try {
      const files = binding.frame.files ?? [];
      const catalog = files.find((file) => file.relative_path.endsWith("rainver-provider.json"));
      const toml = files.find((file) => file.relative_path === ".codex/config.toml");
      expect(catalog).toBeTruthy();
      expect(toml).toBeTruthy();
      // The one relationship that cannot be checked by reading either file
      // alone: the path Codex is told to load is the path that was written.
      expect(toml!.contents).toContain(
        `model_catalog_json = "${PROFILE_ROOT_PLACEHOLDER}/${catalog!.relative_path}"`,
      );
      // Substituted by the daemon, which is the only side that knows the
      // profile root — so it must still be a placeholder here, not a path.
      expect(toml!.escape).toBe("toml_basic_string");
      expect(toml!.contents).toContain('model = "MiniMax-M3"');
      expect(toml!.contents).toContain('model_provider = "rainver_provider"');
      // Codex's OpenAI-compatible transport, on the lease the proxy minted.
      expect(toml!.contents).toContain('wire_api = "responses"');
      expect(toml!.contents).toMatch(/base_url = "http:\/\/192\.168\.1\.5:8021\/openai\/[^"]+"/);
      expect(toml!.contents).toContain(`experimental_bearer_token = "${leaseTokenOf(toml!.contents)}"`);
      // The selected model has to be in the catalog Codex resolves against.
      const models = (JSON.parse(catalog!.contents) as { models: Array<{ slug: string }> }).models;
      expect(models.map((model) => model.slug)).toContain("MiniMax-M3");
      // The upstream key never leaves the server.
      expect(JSON.stringify(binding.frame)).not.toContain("api.minimaxi.com");
      expect(binding.used_model).toBe("MiniMax-M3");
    } finally {
      binding.revoke();
    }
  });

  it("refuses a bound Codex or OpenCode Run with no model, before minting a lease", async () => {
    setProviderProxyBaseUrlForProcess("http://server:8021", null);
    for (const [runtimeKey, code] of [
      ["codex_cli", "codex_model_required"],
      ["opencode", "opencode_model_required"],
    ] as const) {
      const leases = new ProviderProxyLeaseRegistry();
      await expect(bind({
        runtimeKey,
        model: null,
        provider: {
          id: "prov-1",
          name: "MiniMax",
          provider_type: "openai",
          openai_compatible_base_url: "https://api.minimaxi.com/v1",
          // No default and no available models: nothing to fall back to.
        },
        leaseRegistry: leases,
      })).rejects.toMatchObject({ code } satisfies Partial<RemoteProviderBindingError>);
      // A lease is what lets the proxy spend the server-held key. A Run that
      // was refused must never have held one, not even briefly.
      expect(leases.size()).toBe(0);
    }
  });

  it("exempts Claude, whose model comes from the environment the frame sets", async () => {
    setProviderProxyBaseUrlForProcess("http://server:8021", null);
    const leases = new ProviderProxyLeaseRegistry();
    const binding = await bind({
      runtimeKey: "claude_code",
      model: null,
      provider: {
        id: "prov-1",
        name: "MiniMax",
        provider_type: "anthropic",
        claude_compatible_base_url: "https://api.minimaxi.com/anthropic",
      },
      leaseRegistry: leases,
    });
    try {
      expect(binding.used_model).toBeNull();
      expect(binding.frame.env?.ANTHROPIC_BASE_URL).toContain("/anthropic/");
      expect(binding.frame.env?.ANTHROPIC_MODEL).toBeUndefined();
      expect(binding.frame.files ?? []).toEqual([]);
      expect(leases.size()).toBe(1);
    } finally {
      binding.revoke();
    }
  });
});

function leaseTokenOf(toml: string): string {
  return toml.match(/experimental_bearer_token = "([^"]+)"/)?.[1] ?? "";
}
