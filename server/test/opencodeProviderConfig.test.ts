import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyOpenCodeProviderConfig,
  openCodeModelId,
  writeOpenCodeProviderConfig,
} from "../src/modules/runs/opencodeProviderConfig.js";

describe("OpenCode provider configuration", () => {
  it("writes a run-scoped OpenAI-compatible provider without exposing the upstream key", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rainver-opencode-provider-"));
    try {
      const config = await writeOpenCodeProviderConfig({
        sandboxCwd: sandbox,
        route: "openai",
        providerName: "Research Provider",
        proxyBaseUrl: "http://provider-proxy/openai/lease-1",
        leaseToken: "lease-token-1",
        model: "gpt-research",
        availableModels: ["gpt-research", "gpt-research-mini"],
      });
      const document = JSON.parse(await readFile(join(sandbox, "opencode.json"), "utf8")) as Record<string, any>;
      expect(config.model).toBe("rainver_provider/gpt-research");
      expect(document.provider.rainver_provider).toMatchObject({
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "http://provider-proxy/openai/lease-1",
          apiKey: "lease-token-1",
        },
        models: {
          "gpt-research": { name: "gpt-research" },
          "gpt-research-mini": { name: "gpt-research-mini" },
        },
      });
      expect(JSON.stringify(document)).not.toContain("upstream-api-key");
      await config.restore();
      await expect(readFile(join(sandbox, "opencode.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("registers an Anthropic-protocol provider with the Anthropic SDK on the anthropic-route lease", () => {
    const document: Record<string, unknown> = {};
    applyOpenCodeProviderConfig(document, {
      route: "anthropic",
      providerName: "Anthropic",
      proxyBaseUrl: "http://provider-proxy/anthropic/lease-2/",
      leaseToken: "lease-token-2",
      model: "claude-sonnet-4-6",
      availableModels: [],
    });
    const provider = (document.provider as Record<string, any>).rainver_provider;
    // The package that applies Anthropic prompt-cache breakpoints, not the
    // OpenAI-compatible bridge. It posts to `<baseURL>/messages`, so the lease
    // URL gains `/v1` and the proxy forwards `/v1/messages` upstream — the
    // same path Claude Code's `ANTHROPIC_BASE_URL` produces.
    expect(provider).toMatchObject({
      npm: "@ai-sdk/anthropic",
      options: { baseURL: "http://provider-proxy/anthropic/lease-2/v1", apiKey: "lease-token-2" },
      models: { "claude-sonnet-4-6": { name: "claude-sonnet-4-6" } },
    });
    // The provider id does not depend on the protocol, so the model id ACP is
    // told still names the provider this config declares.
    expect(openCodeModelId("claude-sonnet-4-6")).toBe("rainver_provider/claude-sonnet-4-6");
  });
});
