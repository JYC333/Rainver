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

const RETRIEVAL_OBJECT_TYPE_SET = new Set<string>(RETRIEVAL_OBJECT_TYPE_VALUES);

export function isRetrievalObjectType(value: string | null | undefined): value is RetrievalObjectType {
  return typeof value === "string" && RETRIEVAL_OBJECT_TYPE_SET.has(value);
}
