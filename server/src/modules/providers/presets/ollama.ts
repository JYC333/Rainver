import type { ProviderPreset } from "./types.js";

export const OLLAMA_PRESETS: ProviderPreset[] = [
  {
    id: "ollama_embedding",
    mode: "embedding",
    label: "Ollama Embeddings",
    description: "Local Ollama embedding endpoint.",
    name: "Ollama Embeddings",
    provider_type: "ollama",
    base_url: "http://localhost:11434",
    default_model: "nomic-embed-text",
    available_models: ["nomic-embed-text"],
    embedding_dimensions: 768,
    embedding_dimension_options: [768, 1024, 1536, 2560, 4096],
    api_key_required: false,
    task: "retrieval_embedding",
  },
];

