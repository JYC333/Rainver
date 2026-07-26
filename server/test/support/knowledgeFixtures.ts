import type { Pool } from "pg";

export async function insertKnowledgeItem(
  pool: Pool,
  input: {
    id: string;
    spaceId: string;
    title: string;
    content: string;
    knowledgeKind?: string;
    slug?: string | null;
    aliases?: string[];
    status?: string;
    visibility?: string;
    ownerUserId?: string | null;
    createdByUserId?: string | null;
    projectFolderId?: string | null;
    projectId?: string | null;
    updatedAt?: string;
  },
): Promise<void> {
  const status = input.status ?? "active";
  const visibility = input.visibility ?? "space_shared";
  const plainText = input.content;
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  await pool.query(
    `WITH obj AS (
       INSERT INTO space_objects (
         id, space_id, object_type, title, summary, status, visibility,
         owner_user_id, primary_project_id, project_folder_id, created_by_user_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'knowledge_item', $3, left($4, 200), $5, $6,
         $7, $8, $9, $10,
         $14::timestamptz, $14::timestamptz
       )
     )
     INSERT INTO knowledge_items (
       object_id, space_id, root_item_id, knowledge_kind, slug, aliases_json,
       content, content_format, content_schema_version, plain_text,
       verification_status, reflection_status, tags_json, version
     ) VALUES (
       $1, $2, $1, $11, $12, $13::jsonb,
       $4, 'markdown', 1, $4,
       'unverified', 'unreviewed', '[]'::jsonb, 1
     )`,
    [
      input.id,
      input.spaceId,
      input.title,
      plainText,
      status,
      visibility,
      input.ownerUserId ?? null,
      input.projectId ?? null,
      input.projectFolderId ?? null,
      input.createdByUserId ?? null,
      input.knowledgeKind ?? "concept",
      input.slug ?? null,
      JSON.stringify(input.aliases ?? []),
      updatedAt,
    ],
  );
}
