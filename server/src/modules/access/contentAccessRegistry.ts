export interface ContentResourceDefinition {
  resourceType: string;
  tableName: string;
  ownerColumn: string;
  projectFolderColumn?: string;
  projectColumn?: string;
  activePredicate?: (alias: string) => string;
  publishable: boolean;
}

const definitions = [
  { resourceType: "agent", tableName: "agents", ownerColumn: "owner_user_id", activePredicate: (alias: string) => `${alias}.status <> 'archived'`, publishable: false },
  { resourceType: "artifact", tableName: "artifacts", ownerColumn: "owner_user_id", projectFolderColumn: "project_folder_id", projectColumn: "project_id", publishable: true },
  { resourceType: "activity", tableName: "activity_records", ownerColumn: "owner_user_id", projectFolderColumn: "project_folder_id", projectColumn: "project_id", publishable: false },
  { resourceType: "memory", tableName: "memory_entries", ownerColumn: "owner_user_id", projectFolderColumn: "project_folder_id", projectColumn: "project_id", activePredicate: (alias: string) => `${alias}.deleted_at IS NULL`, publishable: true },
  { resourceType: "proposal", tableName: "proposals", ownerColumn: "owner_user_id", projectFolderColumn: "project_folder_id", projectColumn: "project_id", publishable: false },
  { resourceType: "run", tableName: "runs", ownerColumn: "owner_user_id", projectFolderColumn: "project_folder_id", projectColumn: "project_id", publishable: false },
  { resourceType: "source_connection", tableName: "source_connections", ownerColumn: "owner_user_id", activePredicate: (alias: string) => `${alias}.deleted_at IS NULL`, publishable: false },
  { resourceType: "source_item", tableName: "source_items", ownerColumn: "owner_user_id", activePredicate: (alias: string) => `${alias}.deleted_at IS NULL`, publishable: false },
  { resourceType: "source_snapshot", tableName: "source_snapshots", ownerColumn: "owner_user_id", publishable: false },
  { resourceType: "extracted_evidence", tableName: "extracted_evidence", ownerColumn: "owner_user_id", activePredicate: (alias: string) => `${alias}.deleted_at IS NULL`, publishable: false },
  { resourceType: "space_object", tableName: "space_objects", ownerColumn: "owner_user_id", projectFolderColumn: "project_folder_id", projectColumn: "primary_project_id", activePredicate: (alias: string) => `${alias}.status <> 'deleted'`, publishable: true },
  { resourceType: "task", tableName: "tasks", ownerColumn: "owner_user_id", projectFolderColumn: "project_folder_id", projectColumn: "project_id", activePredicate: (alias: string) => `${alias}.deleted_at IS NULL`, publishable: true },
  { resourceType: "token_usage_event", tableName: "token_usage_events", ownerColumn: "owner_user_id", projectFolderColumn: "project_folder_id", projectColumn: "project_id", publishable: false },
  { resourceType: "reader_annotation", tableName: "reader_annotations", ownerColumn: "owner_user_id", activePredicate: (alias: string) => `${alias}.status = 'active'`, publishable: false },
] as const satisfies readonly ContentResourceDefinition[];

export type ContentResourceType = (typeof definitions)[number]["resourceType"];

export const CONTENT_RESOURCE_DEFINITIONS: readonly ContentResourceDefinition[] = definitions;

export function contentResourceDefinition(resourceType: string): ContentResourceDefinition | null {
  return definitions.find((definition) => definition.resourceType === resourceType) ?? null;
}
