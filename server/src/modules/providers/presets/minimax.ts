import type { ProviderPreset } from "./types";

export const MINIMAX_PRESETS: ProviderPreset[] = [
  {
    id: "minimax",
    mode: "chat",
    label: "MiniMax",
    description: "MiniMax Anthropic-compatible chat endpoint with optional CLI bridge URLs.",
    name: "MiniMax",
    provider_type: "minimax",
    base_url: "https://api.minimaxi.com/anthropic",
    claude_compatible_base_url: "https://api.minimaxi.com/anthropic",
    openai_compatible_base_url: "https://api.minimaxi.com/v1",
    default_model: "MiniMax-M3",
    available_models: [
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
    ],
    embedding_dimensions: null,
    embedding_dimension_options: [],
    api_key_required: true,
    task: null,
  },
];
