import type { RetrievalObjectType } from "../retrieval/index.js";

export const KNOWLEDGE_RETRIEVAL_OBJECT_TYPES = ["knowledge_item", "note", "source", "claim"] as const satisfies readonly RetrievalObjectType[];
export type KnowledgeRetrievalObjectType = typeof KNOWLEDGE_RETRIEVAL_OBJECT_TYPES[number];

const KNOWLEDGE_RETRIEVAL_OBJECT_TYPE_SET = new Set<string>(KNOWLEDGE_RETRIEVAL_OBJECT_TYPES);

export function isKnowledgeRetrievalObjectType(value: string | null | undefined): value is KnowledgeRetrievalObjectType {
  return typeof value === "string" && KNOWLEDGE_RETRIEVAL_OBJECT_TYPE_SET.has(value);
}

export function isKnowledgeRetrievalProjectedRelation(
  fromObjectType: string | null | undefined,
  toObjectType: string | null | undefined,
): boolean {
  return isKnowledgeRetrievalObjectType(fromObjectType) && isKnowledgeRetrievalObjectType(toObjectType);
}
