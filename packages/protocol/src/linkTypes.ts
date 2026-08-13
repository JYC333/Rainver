import { z } from "zod";

/**
 * The single Link Type vocabulary.
 *
 * Before this file there were four overlapping lists that nothing reconciled:
 * `OBJECT_RELATION_TYPE_VALUES` (12), the `object_relations` CHECK (15, adding
 * `affiliated_with` / `cites` / `authored_by`), `OBJECT_SCHEMA_RELATION_TYPE_VALUES`
 * (18, adding `explains` / `prerequisite_of` / `example_of` / `applies_to` /
 * `summarizes` / `updates`), and `inquiry_thread_relations` (7, adding
 * `decomposes_into` / `proposes`). The gaps were live defects: a relation hint
 * could be declared for a type `object_relations` would reject on write, and
 * `authored_by` was a real edge type no hint could reference.
 *
 * This is the union. Endpoint constraints and governance are declared per link
 * type in the server-side registry (`modules/ontology/linkTypes.ts`); this
 * module is contracts-only, so it carries the vocabulary and nothing else.
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
