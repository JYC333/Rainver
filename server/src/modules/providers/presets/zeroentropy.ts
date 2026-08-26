import type { ProviderPreset } from "./types.js";

export const ZEROENTROPY_PRESETS: ProviderPreset[] = [
  {
    id: "zeroentropy_embedding",
    mode: "embedding",
    label: "ZeroEntropy Embed",
    description: "ZeroEntropy zembed-1 for retrieval embeddings.",
    name: "ZeroEntropy Embeddings",
    provider_type: "zeroentropy",
    base_url: "https://api.zeroentropy.dev/v1",
    default_model: "zembed-1",
    available_models: ["zembed-1"],
    embedding_dimensions: 2560,
    embedding_dimension_options: [2560],
    api_key_required: true,
    task: "retrieval_embedding",
  },
  {
    id: "zeroentropy_rerank",
    mode: "rerank",
    label: "ZeroEntropy Rerank",
    description: "ZeroEntropy zerank models for native retrieval rerank.",
    name: "ZeroEntropy Rerank",
    provider_type: "zeroentropy",
    base_url: "https://api.zeroentropy.dev/v1",
    default_model: "zerank-2",
    available_models: ["zerank-2", "zerank-1", "zerank-1-small"],
    embedding_dimensions: null,
    embedding_dimension_options: [],
    api_key_required: true,
    task: "retrieval_rerank",
  },
];

