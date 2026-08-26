import type { ProviderPreset } from "./types.js";

export const COHERE_PRESETS: ProviderPreset[] = [
  {
    id: "cohere_embedding",
    mode: "embedding",
    label: "Cohere Embed",
    description: "Cohere embed-v4.0 for retrieval embeddings.",
    name: "Cohere Embeddings",
    provider_type: "cohere",
    base_url: "https://api.cohere.com",
    default_model: "embed-v4.0",
    available_models: ["embed-v4.0"],
    embedding_dimensions: 1536,
    embedding_dimension_options: [1536, 1024, 512, 256],
    api_key_required: true,
    task: "retrieval_embedding",
  },
  {
    id: "cohere_rerank",
    mode: "rerank",
    label: "Cohere Rerank",
    description: "Cohere rerank-v4.0-pro for native retrieval rerank.",
    name: "Cohere Rerank",
    provider_type: "cohere",
    base_url: "https://api.cohere.com",
    default_model: "rerank-v4.0-pro",
    available_models: ["rerank-v4.0-pro"],
    embedding_dimensions: null,
    embedding_dimension_options: [],
    api_key_required: true,
    task: "retrieval_rerank",
  },
];

