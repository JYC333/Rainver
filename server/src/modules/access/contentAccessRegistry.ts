import { registeredEntities } from "../ontology/entities.js";
import type { ContentProjectShareDeclaration } from "../ontology/entities.js";

export interface ContentResourceDefinition {
  resourceType: string;
  tableName: string;
  ownerColumn: string;
  projectFolderColumn?: string;
  projectColumn?: string;
  contextTaintColumn?: string;
  projectShare?: ContentProjectShareDeclaration;
  activePredicate?: (alias: string) => string;
  publishable: boolean;
}

// Derived from the ontology entity registry (ADR 0012 decision 6): this list
// used to be a third, independently maintained type universe alongside the
// retrieval enum and the graph projection's assumptions, at a granularity that
// made cross-validation impossible. `space_object` appears once and covers
// every ontology subtype, which is the granularity the read gate actually
// works at.
//
// Derived on each read rather than snapshotted at module load: B12F/B12I say
// modules — including plugins — register their own entities, and a plugin that
// registers after this module is first imported would be invisible to a frozen
// array.
function definitions(): readonly ContentResourceDefinition[] {
  return registeredEntities()
    .filter((entity) => entity.contentAccessible)
    .map((entity): ContentResourceDefinition => {
      const declaration = entity.contentAccessible!;
      return {
        resourceType: declaration.resourceType ?? entity.entityType,
        tableName: declaration.tableName,
        ownerColumn: declaration.ownerColumn,
        ...(declaration.projectFolderColumn ? { projectFolderColumn: declaration.projectFolderColumn } : {}),
        ...(declaration.projectColumn ? { projectColumn: declaration.projectColumn } : {}),
        ...(declaration.contextTaintColumn ? { contextTaintColumn: declaration.contextTaintColumn } : {}),
        ...(declaration.projectShare ? { projectShare: declaration.projectShare } : {}),
        ...(declaration.activePredicate ? { activePredicate: declaration.activePredicate } : {}),
        publishable: declaration.publishable,
      };
    });
}

export type ContentResourceType =
  | "space_object"
  | "memory"
  | "task"
  | "artifact"
  | "run"
  | "proposal"
  | "activity"
  | "agent"
  | "source_connection"
  | "source_item"
  | "source_snapshot"
  | "extracted_evidence"
  | "token_usage_event"
  | "reader_annotation"
  | "imported_session";

export const CONTENT_RESOURCE_TYPES: readonly ContentResourceType[] = [
  "space_object", "memory", "task", "artifact", "run", "proposal", "activity",
  "agent", "source_connection", "source_item", "source_snapshot",
  "extracted_evidence", "token_usage_event", "reader_annotation", "imported_session",
];

export function contentResourceDefinitions(): readonly ContentResourceDefinition[] {
  return definitions();
}

export function contentResourceDefinition(resourceType: string): ContentResourceDefinition | null {
  return definitions().find((definition) => definition.resourceType === resourceType) ?? null;
}
