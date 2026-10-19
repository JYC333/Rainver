import { z } from "zod";

/**
 * The single Link Type vocabulary. Endpoint constraints and governance are
 * declared per link type in the server-side registry
 * (`modules/ontology/linkTypes.ts`); this module is contracts-only.
 * Do not keep a second list: a hint can then name a type the write rejects,
 * or a real edge type no hint can reference.
 */
export const LINK_TYPE_VALUES = [
  // Generic association
  "related_to",
  "references",
  "same_as",
  // Structure
  "part_of",
  "depends_on",
  "prerequisite_of",
  "decomposes_into",
  // Provenance and derivation
  "source_for",
  "derived_from",
  "cites",
  "authored_by",
  "summarizes",
  // Aboutness and explanation
  "about",
  "explains",
  "example_of",
  "applies_to",
  // Assertion relations
  "supports",
  "contradicts",
  "proposes",
  // Versioning
  "supersedes",
  "refines",
  "updates",
  // Affiliation
  "affiliated_with",
] as const;

export const LinkTypeSchema = z.enum(LINK_TYPE_VALUES);
export type LinkType = z.infer<typeof LinkTypeSchema>;

export const LINK_STATUS_VALUES = ["candidate", "active", "rejected", "archived"] as const;
export const LinkStatusSchema = z.enum(LINK_STATUS_VALUES);

export function isLinkType(value: string): value is LinkType {
  return (LINK_TYPE_VALUES as readonly string[]).includes(value);
}
