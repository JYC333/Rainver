import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Queryable } from "../routeUtils/common";
import { HttpError } from "../routeUtils/common";

export interface PublicationImportContext {
  targetSpaceId: string;
  ownerUserId: string;
}

export interface PublicationImportResult {
  resource_type: string;
  resource_id: string;
}

export interface PublicationSnapshot {
  schema_version: number;
  resource_type: string;
  title: string;
  payload: Record<string, unknown>;
}

export interface PublicationAdapter {
  resourceType: string;
  schemaVersion: number;
  serialize(db: Queryable, sourceSpaceId: string, resourceId: string): Promise<PublicationSnapshot>;
  importSnapshot(
    db: Queryable,
    context: PublicationImportContext,
    snapshot: unknown,
  ): Promise<PublicationImportResult>;
}

const nullableString = z.string().nullable();

const artifactSnapshotSchema = z.object({
  schema_version: z.literal(1),
  resource_type: z.literal("artifact"),
  title: z.string(),
  payload: z.object({
    artifact_type: z.string(),
    title: z.string(),
    content: z.string(),
    mime_type: nullableString,
    exportable: z.boolean(),
    export_formats_json: z.unknown(),
    canonical_format: nullableString,
    preview: z.boolean(),
    relevant_period_start: nullableString,
    relevant_period_end: nullableString,
    trust_level: nullableString,
  }).strict(),
}).strict();

const taskSnapshotSchema = z.object({
  schema_version: z.literal(1),
  resource_type: z.literal("task"),
  title: z.string(),
  payload: z.object({
    title: z.string(),
    description: nullableString,
    task_type: z.string(),
    priority: z.string(),
    risk_level: z.string(),
    acceptance_criteria_json: z.unknown(),
    definition_of_done: nullableString,
    required_outputs_json: z.unknown(),
    due_at: nullableString,
    start_after: nullableString,
    estimated_effort: nullableString,
    max_runs: z.number().int().nullable(),
    max_cost: z.number().nullable(),
    max_duration_seconds: z.number().int().nullable(),
    tags: z.unknown(),
  }).strict(),
}).strict();

const memorySnapshotSchema = z.object({
  schema_version: z.literal(1),
  resource_type: z.literal("memory"),
  title: z.string(),
  payload: z.object({
    memory_type: z.string(),
    content: z.string(),
    title: nullableString,
    namespace: nullableString,
    confidence: z.number(),
    importance: z.number(),
    tags: z.unknown(),
    memory_layer: nullableString,
    event_time: nullableString,
    event_type: nullableString,
    source_trust: nullableString,
  }).strict(),
}).strict();

const knowledgeSnapshotSchema = z.object({
  schema_version: z.literal(1),
  resource_type: z.literal("space_object"),
  title: z.string(),
  payload: z.object({
    title: z.string(),
    summary: nullableString,
    knowledge_kind: z.string(),
    slug: nullableString,
    aliases_json: z.unknown(),
    content: z.string(),
    content_json: z.unknown(),
    content_format: z.string(),
    content_schema_version: z.number().int(),
    plain_text: nullableString,
    verification_status: z.string(),
    reflection_status: z.string(),
    tags_json: z.unknown(),
    confidence: z.number().nullable(),
  }).strict(),
}).strict();

const artifactAdapter: PublicationAdapter = {
  resourceType: "artifact",
  schemaVersion: 1,
  async serialize(db, sourceSpaceId, resourceId) {
    const result = await db.query<Record<string, unknown>>(
      `SELECT artifact_type, title, content, storage_ref, storage_path, mime_type,
              exportable, export_formats_json, canonical_format, preview,
              relevant_period_start::text, relevant_period_end::text,
              trust_level
         FROM artifacts
        WHERE space_id = $1 AND id = $2
        LIMIT 1 FOR SHARE`,
      [sourceSpaceId, resourceId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Content not found");
    if (row.storage_ref != null || row.storage_path != null || typeof row.content !== "string") {
      throw new HttpError(422, "Only inline artifacts can be published");
    }
    return artifactSnapshotSchema.parse({
      schema_version: 1,
      resource_type: "artifact",
      title: row.title,
      payload: withoutKeys(row, ["storage_ref", "storage_path"]),
    });
  },
  async importSnapshot(db, context, snapshot) {
    const parsed = artifactSnapshotSchema.parse(snapshot);
    const id = randomUUID();
    const now = new Date().toISOString();
    const p = parsed.payload;
    await db.query(
      `INSERT INTO artifacts (
         id, space_id, run_id, proposal_id, artifact_type, title, content,
         storage_ref, storage_path, mime_type, exportable, export_formats_json,
         canonical_format, preview, relevant_period_start, relevant_period_end,
         created_at, updated_at, metadata_json, visibility, access_level,
         owner_user_id, trust_level, project_id, project_folder_id
       ) VALUES (
         $1, $2, NULL, NULL, $3, $4, $5,
         NULL, NULL, $6, $7, $8::jsonb,
         $9, $10, $11::timestamptz, $12::timestamptz,
         $13, $13, NULL, 'private', 'full',
         $14, $15, NULL, NULL
       )`,
      [
        id, context.targetSpaceId, p.artifact_type, p.title, p.content,
        p.mime_type, p.exportable, json(p.export_formats_json), p.canonical_format,
        p.preview, p.relevant_period_start, p.relevant_period_end, now,
        context.ownerUserId, p.trust_level,
      ],
    );
    return { resource_type: "artifact", resource_id: id };
  },
};

const taskAdapter: PublicationAdapter = {
  resourceType: "task",
  schemaVersion: 1,
  async serialize(db, sourceSpaceId, resourceId) {
    const result = await db.query<Record<string, unknown>>(
      `SELECT title, description, task_type, priority, risk_level,
              acceptance_criteria_json, definition_of_done, required_outputs_json,
              due_at::text, start_after::text, estimated_effort, max_runs,
              max_cost, max_duration_seconds, tags
         FROM tasks
        WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL
        LIMIT 1 FOR SHARE`,
      [sourceSpaceId, resourceId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Content not found");
    return taskSnapshotSchema.parse({
      schema_version: 1,
      resource_type: "task",
      title: row.title,
      payload: row,
    });
  },
  async importSnapshot(db, context, snapshot) {
    const parsed = taskSnapshotSchema.parse(snapshot);
    const id = randomUUID();
    const now = new Date().toISOString();
    const p = parsed.payload;
    await db.query(
      `INSERT INTO tasks (
         id, space_id, project_folder_id, project_id, board_id, column_id, parent_task_id,
         title, description, task_type, status, priority, risk_level,
         created_by_user_id, assigned_user_id, assigned_agent_id,
         claimed_by_user_id, claimed_by_agent_id, source_activity_id, source_run_id,
         source_proposal_id, source_artifact_id, acceptance_criteria_json,
         definition_of_done, required_outputs_json, due_at, start_after,
         completed_at, cancelled_at, blocked_reason, estimated_effort, actual_effort,
         max_runs, max_cost, max_duration_seconds, policy_json, metadata_json, tags,
         created_at, updated_at, deleted_at, owner_user_id, visibility, access_level
       ) VALUES (
         $1, $2, NULL, NULL, NULL, NULL, NULL,
         $3, $4, $5, 'inbox', $6, $7,
         $8, NULL, NULL,
         NULL, NULL, NULL, NULL,
         NULL, NULL, $9::jsonb,
         $10, $11::jsonb, $12::timestamptz, $13::timestamptz,
         NULL, NULL, NULL, $14, NULL,
         $15, $16, $17, NULL, NULL, $18::jsonb,
         $19, $19, NULL, $8, 'private', 'full'
       )`,
      [
        id, context.targetSpaceId, p.title, p.description, p.task_type, p.priority,
        p.risk_level, context.ownerUserId, json(p.acceptance_criteria_json),
        p.definition_of_done, json(p.required_outputs_json), p.due_at, p.start_after,
        p.estimated_effort, p.max_runs, p.max_cost, p.max_duration_seconds,
        json(p.tags), now,
      ],
    );
    return { resource_type: "task", resource_id: id };
  },
};

const memoryAdapter: PublicationAdapter = {
  resourceType: "memory",
  schemaVersion: 1,
  async serialize(db, sourceSpaceId, resourceId) {
    const result = await db.query<Record<string, unknown>>(
      `SELECT scope_type, memory_type, content, title, namespace, confidence,
              importance, tags, memory_layer, event_time::text, event_type,
              source_trust, sensitivity_level
         FROM memory_entries
        WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL AND status = 'active'
        LIMIT 1 FOR SHARE`,
      [sourceSpaceId, resourceId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Content not found");
    if (row.scope_type !== "user" || row.sensitivity_level !== "normal") {
      throw new HttpError(422, "Only normal-sensitivity user memories can be published");
    }
    return memorySnapshotSchema.parse({
      schema_version: 1,
      resource_type: "memory",
      title: row.title ?? "Memory",
      payload: withoutKeys(row, ["scope_type", "sensitivity_level"]),
    });
  },
  async importSnapshot(db, context, snapshot) {
    const parsed = memorySnapshotSchema.parse(snapshot);
    const id = randomUUID();
    const now = new Date().toISOString();
    const p = parsed.payload;
    await db.query(
      `INSERT INTO memory_entries (
         id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
         valid_from, valid_to, subject_user_id, owner_user_id, sensitivity_level,
         last_confirmed_at, project_folder_id, agent_id, namespace, title, visibility,
         access_level, confidence, importance, source_id, created_by, approved_by,
         deleted_at, version, access_count, last_accessed_at, tags, memory_layer,
         event_time, event_type, last_retrieved_at, root_memory_id,
         supersedes_memory_id, source_trust, created_from_proposal_id, project_id
       ) VALUES (
         $1, $2, 'user', $3, $4, 'active', $5, $5,
         NULL, NULL, $6, $6, 'normal',
         NULL, NULL, NULL, $7, $8, 'private',
         'full', $9, $10, NULL, 'publication_import', $6,
         NULL, 1, 0, NULL, $11::jsonb, $12,
         $13::timestamptz, $14, NULL, $1,
         NULL, $15, NULL, NULL
       )`,
      [
        id, context.targetSpaceId, p.memory_type, p.content, now,
        context.ownerUserId, p.namespace, p.title, p.confidence, p.importance,
        json(p.tags), p.memory_layer, p.event_time, p.event_type, p.source_trust,
      ],
    );
    return { resource_type: "memory", resource_id: id };
  },
};

const knowledgeAdapter: PublicationAdapter = {
  resourceType: "space_object",
  schemaVersion: 1,
  async serialize(db, sourceSpaceId, resourceId) {
    const result = await db.query<Record<string, unknown>>(
      `SELECT so.title, so.summary, so.object_type, ki.knowledge_kind, ki.slug,
              ki.aliases_json, ki.content, ki.content_json, ki.content_format,
              ki.content_schema_version, ki.plain_text, ki.verification_status,
              ki.reflection_status, ki.tags_json, ki.confidence
         FROM space_objects so
         JOIN knowledge_items ki ON ki.object_id = so.id AND ki.space_id = so.space_id
        WHERE so.space_id = $1 AND so.id = $2 AND so.status = 'active'
        LIMIT 1 FOR SHARE OF so, ki`,
      [sourceSpaceId, resourceId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Content not found");
    if (row.object_type !== "knowledge_item") {
      throw new HttpError(422, "Only knowledge items can be published");
    }
    return knowledgeSnapshotSchema.parse({
      schema_version: 1,
      resource_type: "space_object",
      title: row.title,
      payload: withoutKeys(row, ["object_type"]),
    });
  },
  async importSnapshot(db, context, snapshot) {
    const parsed = knowledgeSnapshotSchema.parse(snapshot);
    const id = randomUUID();
    const now = new Date().toISOString();
    const p = parsed.payload;
    await db.query(
      `WITH object_insert AS (
         INSERT INTO space_objects (
           id, space_id, object_type, title, summary, status, visibility, access_level,
           owner_user_id, primary_project_id, project_folder_id, created_by_user_id,
           created_by_agent_id, created_by_run_id, created_at, updated_at,
           archived_at, deleted_at
         ) VALUES (
           $1, $2, 'knowledge_item', $3, $4, 'active', 'private', 'full',
           $5, NULL, NULL, $5,
           NULL, NULL, $6, $6,
           NULL, NULL
         )
       )
       INSERT INTO knowledge_items (
         object_id, space_id, root_item_id, supersedes_item_id, knowledge_kind,
         slug, aliases_json, content, content_json, content_format,
         content_schema_version, plain_text, verification_status, reflection_status,
         tags_json, confidence, created_from_proposal_id, approved_by_user_id,
         redirect_to_item_id, version, deprecated_at
       ) VALUES (
         $1, $2, $1, NULL, $7,
         $8, $9::jsonb, $10, $11::jsonb, $12,
         $13, $14, $15, $16,
         $17::jsonb, $18, NULL, $5,
         NULL, 1, NULL
       )`,
      [
        id, context.targetSpaceId, p.title, p.summary, context.ownerUserId, now,
        p.knowledge_kind, p.slug, json(p.aliases_json), p.content,
        json(p.content_json), p.content_format, p.content_schema_version,
        p.plain_text, p.verification_status, p.reflection_status,
        json(p.tags_json), p.confidence,
      ],
    );
    return { resource_type: "space_object", resource_id: id };
  },
};

const adapters = [artifactAdapter, taskAdapter, memoryAdapter, knowledgeAdapter] as const;

export const PUBLICATION_ADAPTERS: readonly PublicationAdapter[] = adapters;

export function publicationAdapter(resourceType: string): PublicationAdapter | null {
  return adapters.find((adapter) => adapter.resourceType === resourceType) ?? null;
}

function withoutKeys(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy = { ...row };
  for (const key of keys) delete copy[key];
  return copy;
}

function json(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}
