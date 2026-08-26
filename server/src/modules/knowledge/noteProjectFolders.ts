import { randomUUID } from "node:crypto";
import { HttpError, type Queryable } from "../routeUtils/common.js";

/**
 * A Project's notes folder, and the rule that a folder inside one belongs to it.
 *
 * `note_collections` is owned by this module, so the "which Project does this
 * folder belong to" question is answered here rather than in each caller. It has
 * two callers with different reasons for asking: the Project notes surface,
 * which needs the folder to exist before it can show anything, and the note
 * placement path, which needs to know whether filing a note somewhere binds it
 * to a Project.
 */

/**
 * The Project owning a collection — the nearest ancestor (including the
 * collection itself) carrying a `project_id`. Null when the folder sits outside
 * every Project subtree, which is the ordinary case for Inbox, Archive, and any
 * folder a user made.
 *
 * Ancestry rather than a direct column: a Project's folder has subfolders, and
 * "in the Project" has to mean the whole subtree or a note dragged one level
 * deeper would silently leave it (U6).
 */
export async function projectOwningCollection(
  db: Queryable,
  spaceId: string,
  collectionId: string,
): Promise<string | null> {
  const result = await db.query<{ project_id: string | null }>(
    `WITH RECURSIVE ancestry AS (
       SELECT id, parent_id, project_id, 0 AS depth
         FROM note_collections
        WHERE space_id = $1 AND id = $2
       UNION ALL
       SELECT parent.id, parent.parent_id, parent.project_id, ancestry.depth + 1
         FROM note_collections parent
         JOIN ancestry ON ancestry.parent_id = parent.id
        WHERE parent.space_id = $1
          AND ancestry.depth < 64
     )
     SELECT project_id
       FROM ancestry
      WHERE project_id IS NOT NULL
      ORDER BY depth ASC
      LIMIT 1`,
    [spaceId, collectionId],
  );
  return result.rows[0]?.project_id ?? null;
}

/**
 * The Project's notes folder, created on first use.
 *
 * Nested under the space's protected "Projects" PARA folder when one exists, so
 * it turns up where a user following that structure would look. Looked up by
 * `system_role` rather than by name, like Inbox and Archive; a space seeded
 * before that role existed degrades to a root-level folder.
 */
export async function ensureProjectNotesFolder(
  db: Queryable,
  spaceId: string,
  projectId: string,
): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM note_collections WHERE space_id = $1 AND project_id = $2`,
    [spaceId, projectId],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const project = await db.query<{ name: string }>(
    `SELECT name FROM projects WHERE id = $1 AND space_id = $2`,
    [projectId, spaceId],
  );
  if (!project.rows[0]) throw new HttpError(404, "Project not found");
  const parent = await db.query<{ id: string }>(
    `SELECT id FROM note_collections WHERE space_id = $1 AND system_role = 'projects_root' LIMIT 1`,
    [spaceId],
  );
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,project_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'project',0,true,false,$5,$6,$6)
     ON CONFLICT (space_id,project_id) WHERE project_id IS NOT NULL DO NOTHING`,
    [randomUUID(), spaceId, parent.rows[0]?.id ?? null, project.rows[0].name, projectId, now],
  );
  const found = await db.query<{ id: string }>(
    `SELECT id FROM note_collections WHERE space_id = $1 AND project_id = $2`,
    [spaceId, projectId],
  );
  return found.rows[0]!.id;
}
