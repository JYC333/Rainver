import { randomUUID } from "node:crypto";
import type { PoolClient } from "../../db/pool";

const SYSTEM_MEMORY_SEEDS = [
  {
    title: "Memory Policy",
    namespace: "system.memory_policy",
    importance: 1.0,
    content:
      "Core memory rules:\n" +
      "1. Agents may NOT write to long-term memory directly.\n" +
      "2. All long-term memory writes must go through the proposal -> approval workflow.\n" +
      "3. Proposals must include a rationale.\n" +
      "4. Users must explicitly accept or reject each proposal.\n" +
      "5. Rejected proposals are never promoted to active memory.\n" +
      "6. Memory scopes: system > space > user > workspace > capability > agent.\n" +
      "7. Private memories are visible only to their owner.\n" +
      "8. Workspace and project scopes are checked independently from visibility.\n" +
      "9. space_shared memories are visible to eligible members in the same space.\n" +
      "10. selected_users memory is visible only to its owner and explicit grantees.\n" +
      "11. Memory never crosses space boundaries.",
  },
  {
    title: "Context Policy",
    namespace: "system.context_policy",
    importance: 1.0,
    content:
      "Context builder rules:\n" +
      "1. Context must be scoped - never dump all memories.\n" +
      "2. Sort by importance, confidence, then recency.\n" +
      "3. Respect space, user, and workspace boundaries.\n" +
      "4. Episodic memories are capped separately from semantic/preference.\n" +
      "5. System policy is always included.\n" +
      "6. Context packages are read-only snapshots - agents cannot modify them.\n" +
      "7. space_id and user_id are always required to build context.",
  },
  {
    title: "Capability Policy",
    namespace: "system.capability_policy",
    importance: 0.9,
    content:
      "Capability rules:\n" +
      "1. Capabilities are code-defined and version-controlled.\n" +
      "2. Each capability declares its memory access (read/write scopes and types).\n" +
      "3. Capability writes always require proposals unless scope is 'agent'.\n" +
      "4. Capabilities may not access memories outside their declared access.\n" +
      "5. New capabilities must be registered before they can be executed.\n" +
      "6. Disabled capabilities cannot be run.",
  },
] as const;

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

export async function seedSpaceDefaults(client: PoolClient, spaceId: string): Promise<void> {
  await seedSystemMemories(client, spaceId);
  await seedNoteCollections(client, spaceId);
}

async function seedSystemMemories(client: PoolClient, spaceId: string): Promise<void> {
  for (const seed of SYSTEM_MEMORY_SEEDS) {
    await client.query(
      `INSERT INTO memory_entries
         (id, space_id, scope_type, memory_type, content, status,
          created_at, updated_at, subject_user_id, owner_user_id, sensitivity_level,
          namespace, title, visibility, confidence, importance, created_by,
          version, access_count)
       SELECT $1::varchar(36), $2::varchar(36), 'system', 'semantic',
              $3::text, 'active',
              now(), now(), NULL, NULL, 'normal',
              $4::varchar(128), $5::varchar(256), 'space_shared', 1.0,
              $6::double precision, 'system_seed',
              1, 0
       WHERE NOT EXISTS (
         SELECT 1 FROM memory_entries
          WHERE space_id = $2::varchar(36)
            AND namespace = $4::varchar(128)
            AND scope_type = 'system'
            AND deleted_at IS NULL
       )`,
      [randomUUID(), spaceId, seed.content, seed.namespace, seed.title, seed.importance],
    );
  }
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
