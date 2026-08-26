import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeOpenCodeProviderConfig } from "../src/modules/runs/opencodeProviderConfig.js";

describe("OpenCode provider configuration", () => {
  it("writes a run-scoped OpenAI-compatible provider without exposing the upstream key", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agent-space-opencode-provider-"));
    try {
      const config = await writeOpenCodeProviderConfig({
        sandboxCwd: sandbox,
        providerName: "Research Provider",
        proxyBaseUrl: "http://provider-proxy/openai/lease-1",
        leaseToken: "lease-token-1",
        model: "gpt-research",
        availableModels: ["gpt-research", "gpt-research-mini"],
      });
      const document = JSON.parse(await readFile(join(sandbox, "opencode.json"), "utf8")) as Record<string, any>;
      expect(config.model).toBe("agent_space_provider/gpt-research");
      expect(document.provider.agent_space_provider).toMatchObject({
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
});
