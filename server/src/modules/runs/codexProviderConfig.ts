export function renderCodexProviderToml(input: {
  providerName: string;
  proxyBaseUrl: string;
  leaseToken: string;
  model: string;
  catalogPath: string;
}): string {
  return [
    `model = ${tomlString(input.model)}`,
    `model_provider = "rainver_provider"`,
    `model_catalog_json = ${tomlString(input.catalogPath)}`,
    "",
    `[model_providers.rainver_provider]`,
    `name = ${tomlString(input.providerName)}`,
    `base_url = ${tomlString(input.proxyBaseUrl)}`,
    `experimental_bearer_token = ${tomlString(input.leaseToken)}`,
    `wire_api = "responses"`,
    "",
  ].join("\n");
}

export function codexModelCatalog(
  providerName: string,
  selectedModel: string,
  availableModels: string[],
): Record<string, unknown> {
  const models = Array.from(new Set([selectedModel, ...availableModels].filter(Boolean)));
  return {
    models: models.map((model, index) => ({
      slug: model,
      display_name: model,
      description: providerName,
      // Codex encodes effort into the model id it works with (`model[effort]`)
      // and sends it upstream as a request parameter — it is the *model's*
      // reasoning, not a harness behaviour. Declaring only "none" here, which
      // this did, told Codex that every bound provider's model cannot reason
      // at all: `applyModelChange` resolves effort from these levels, so a
      // reasoning model like MiniMax-M3 was pinned to `model[none]` on every
      // bound run.
      //
      // We cannot know which levels a given third-party endpoint honours, so
      // the choice is between deciding "off" on its behalf and letting it
      // answer for itself. It answers for itself. `medium` matches Codex's own
      // fallback, so a provider that ignores the parameter behaves as before.
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Less reasoning, faster and cheaper" },
        { effort: "medium", description: "Balanced reasoning" },
        { effort: "high", description: "More reasoning, slower and costlier" },
      ],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: index,
      base_instructions:
        `You are Codex, a coding agent using ${model} through ${providerName}. ` +
        "You and the user share the same workspace and collaborate to achieve the user's goals.",
      supports_reasoning_summaries: false,
      default_reasoning_summary: "none",
      support_verbosity: false,
      truncation_policy: { mode: "bytes", limit: 10000 },
      supports_parallel_tool_calls: true,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
    })),
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
