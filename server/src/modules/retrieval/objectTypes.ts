import type { RetrievalObjectType } from "./types.js";

// Server-side copy of the fixed retrieval boundary. Keep this closed; per-space
// object schema may define object_profile values under these base object types only.
export const RETRIEVAL_OBJECT_TYPE_VALUES = [
  "knowledge_item",
  "note",
  "source",
  "claim",
  "memory_entry",
  "project_public_summary",
  "source_item",
  "extracted_evidence",
] as const satisfies readonly RetrievalObjectType[];
