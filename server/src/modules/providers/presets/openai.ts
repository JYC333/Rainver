import type { ProviderPreset } from "./types.js";

export const OPENAI_PRESETS: ProviderPreset[] = [
  {
    id: "openai_embedding",
    mode: "embedding",
    label: "OpenAI Embeddings",
    description: "OpenAI text-embedding models for retrieval embeddings.",
    name: "OpenAI Embeddings",
    provider_type: "openai",
    base_url: "https://api.openai.com/v1",
    default_model: "text-embedding-3-large",
    available_models: ["text-embedding-3-large", "text-embedding-3-small"],
    embedding_dimensions: 3072,
    embedding_dimension_options: [3072, 2560, 1536, 1024, 512, 256],
    api_key_required: true,
    task: "retrieval_embedding",
  },
];

