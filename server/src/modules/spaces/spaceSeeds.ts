import { randomUUID } from "node:crypto";
import type { PoolClient } from "../../db/pool";

const DEFAULT_NOTE_COLLECTIONS: readonly [string, string, number, boolean][] = [
  ["Inbox", "inbox", 0, true],
  // Protected (is_system=true) like Inbox/Archive: every project's
  // auto-created notes folder nests under this one by system_role lookup
  // (see areaService.ts's resolveProjectsParentFolderId), so it must
  // not be renameable-away-from or movable the way Areas/Resources are.
  ["Projects", "projects_root", 100, true],
  ["Areas", "normal", 200, false],
  ["Resources", "normal", 300, false],
  ["Archive", "archive", 400, true],
];

export async function seedSpaceDefaults(client: PoolClient, spaceId: string, userId: string): Promise<void> {
  await seedNoteCollections(client, spaceId);
  await seedRuntimeContextPolicy(client, spaceId, userId);
}

async function seedRuntimeContextPolicy(client: PoolClient, spaceId: string, userId: string): Promise<void> {
  const versionId = randomUUID();
  const auditId = randomUUID();
  const policy = JSON.stringify({ constraints: {}, preferences: {} });
  const diff = JSON.stringify({});
  const reason = "Space bootstrap Runtime Context Policy";
  await client.query(
    `INSERT INTO runtime_context_policy_versions (
       id, space_id, scope_type, scope_id, version, policy_json, base_version_id,
       typed_diff_json, reason, created_by_user_id, created_at
     ) VALUES ($1,$2,'space',$2,1,$3::jsonb,NULL,$4::jsonb,$5,$6,now())`,
    [versionId, spaceId, policy, diff, reason, userId],
  );
  await client.query(
    `INSERT INTO runtime_context_policy_bindings (
       space_id, scope_type, scope_id, active_version_id, updated_by_user_id, updated_at
     ) VALUES ($1,'space',$1,$2,$3,now())`,
    [spaceId, versionId, userId],
  );
  await client.query(
    `INSERT INTO runtime_context_policy_audits (
       id, space_id, scope_type, scope_id, actor_user_id, base_version_id,
       new_version_id, typed_diff_json, reason, created_at
     ) VALUES ($1,$2,'space',$2,$3,NULL,$4,$5::jsonb,$6,now())`,
    [auditId, spaceId, userId, versionId, diff, reason],
  );
}

async function seedNoteCollections(client: PoolClient, spaceId: string): Promise<void> {
  const existing = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM note_collections WHERE space_id = $1::varchar(36)",
    [spaceId],
  );
  const existingCount = Number(existing.rows[0]?.count ?? "0");
  const seeds =
    existingCount === 0
      ? DEFAULT_NOTE_COLLECTIONS
      : DEFAULT_NOTE_COLLECTIONS.filter(([, role]) => role === "inbox" || role === "archive" || role === "projects_root");

  for (const [name, role, sortOrder, isSystem] of seeds) {
    if (existingCount === 0 && role === "normal") {
      await client.query(
        `INSERT INTO note_collections
           (id, space_id, parent_id, name, system_role, sort_order, is_system,
            is_hidden, created_at, updated_at)
         VALUES ($1::varchar(36), $2::varchar(36), NULL, $3::varchar(120),
                 $4::varchar(32), $5::integer, $6::boolean, false, now(), now())`,
        [randomUUID(), spaceId, name, role, sortOrder, isSystem],
      );
    } else {
      await client.query(
        `INSERT INTO note_collections
           (id, space_id, parent_id, name, system_role, sort_order, is_system,
            is_hidden, created_at, updated_at)
         SELECT $1::varchar(36), $2::varchar(36), NULL, $3::varchar(120),
                $4::varchar(32), $5::integer, $6::boolean, false, now(), now()
         WHERE NOT EXISTS (
           SELECT 1 FROM note_collections
            WHERE space_id = $2::varchar(36) AND system_role = $4::varchar(32)
         )`,
        [randomUUID(), spaceId, name, role, sortOrder, isSystem],
      );
    }
  }
}
