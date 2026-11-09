import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { assertProjectWriter } from "../projects/access.js";
import {
  dbPool,
  HttpError,
  optionalString,
  requiredString,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";

/**
 * Focus areas classify; they never gate. Nothing here touches the content read
 * predicate — the aggregation below reads through `contentReadSql`, the same
 * gate every other reader uses, and the focus area only narrows what that gate
 * already permits. See ADR 0015.
 */

export interface FocusArea {
  id: string;
  space_id: string;
  owner_user_id: string | null;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface FocusAreaContents {
  projects: Array<{ id: string; name: string; status: string }>;
  objects: Array<{ id: string; object_type: string; title: string | null }>;
  /** Continue each list on its own; `null` once that list is complete. */
  projects_next_cursor: string | null;
  objects_next_cursor: string | null;
}

export interface FocusAreaContentsQuery {
  projectsCursor?: string;
  objectsCursor?: string;
  limit?: number;
}

export const FOCUS_AREA_CONTENTS_PAGE_SIZE = 100;
export const FOCUS_AREA_CONTENTS_MAX_PAGE_SIZE = 200;

type ProjectCursor = { area: string; list: "projects"; name: string; id: string };
type ObjectCursor = { area: string; list: "objects"; at: string; id: string };

function encodeCursor(cursor: ProjectCursor | ObjectCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/**
 * A malformed or foreign cursor is refused rather than read as "first page":
 * silently restarting would make "load more" repeat page one forever.
 */
function decodeCursor<T extends ProjectCursor | ObjectCursor>(
  value: string | undefined,
  area: string,
  list: T["list"],
): T | null {
  if (value === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(422, "Invalid contents cursor");
  }
  const cursor = parsed as Record<string, unknown> | null;
  const key = list === "projects" ? "name" : "at";
  if (
    typeof cursor !== "object" || cursor === null
    || typeof cursor.id !== "string" || typeof cursor[key] !== "string"
  ) {
    throw new HttpError(422, "Invalid contents cursor");
  }
  if (cursor.area !== area || cursor.list !== list) {
    throw new HttpError(422, "Cursor belongs to another contents list");
  }
  return cursor as T;
}

interface FocusAreaRow {
  id: string;
  space_id: string;
  owner_user_id: string | null;
  name: string;
  description: string | null;
  created_at: unknown;
  updated_at: unknown;
  archived_at: unknown;
}

const COLUMNS = "id, space_id, owner_user_id, name, description, created_at, updated_at, archived_at";

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

function toOut(row: FocusAreaRow): FocusArea {
  return {
    id: row.id,
    space_id: row.space_id,
    owner_user_id: row.owner_user_id,
    name: row.name,
    description: row.description,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    archived_at: row.archived_at === null ? null : iso(row.archived_at),
  };
}

export class FocusAreaArchivedError extends HttpError {}

export class FocusAreaService {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): FocusAreaService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new FocusAreaService(dbPool(config));
  }

  async list(identity: SpaceUserIdentity, includeArchived: boolean): Promise<FocusArea[]> {
    const rows = await this.db.query<FocusAreaRow>(
      `SELECT ${COLUMNS} FROM focus_areas
        WHERE space_id = $1 ${includeArchived ? "" : "AND archived_at IS NULL"}
        ORDER BY name ASC`,
      [identity.spaceId],
    );
    return rows.rows.map(toOut);
  }

  async get(identity: SpaceUserIdentity, id: string): Promise<FocusArea> {
    const rows = await this.db.query<FocusAreaRow>(
      `SELECT ${COLUMNS} FROM focus_areas WHERE space_id = $1 AND id = $2`,
      [identity.spaceId, id],
    );
    const row = rows.rows[0];
    if (!row) throw new HttpError(404, "Focus area not found");
    return toOut(row);
  }

  async create(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<FocusArea> {
    const name = requiredString(body.name, "name");
    const now = new Date().toISOString();
    try {
      const rows = await this.db.query<FocusAreaRow>(
        `INSERT INTO focus_areas (id, space_id, owner_user_id, name, description, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         RETURNING ${COLUMNS}`,
        [randomUUID(), identity.spaceId, identity.userId, name, optionalString(body.description), now],
      );
      return toOut(rows.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, "A focus area with that name already exists");
      throw error;
    }
  }

  async update(identity: SpaceUserIdentity, id: string, body: Record<string, unknown>): Promise<FocusArea> {
    const current = await this.get(identity, id);
    // Anyone in the Space may read an area; only whoever created it may rename
    // it. Do not let another member rename it. They could take the name they
    // wanted, because the active-name index is unique per Space.
    if (current.owner_user_id !== null && current.owner_user_id !== identity.userId) {
      throw new HttpError(403, "Only the focus area's owner can change it");
    }
    const name = body.name === undefined ? current.name : requiredString(body.name, "name");
    const description = body.description === undefined ? current.description : optionalString(body.description);
    try {
      const rows = await this.db.query<FocusAreaRow>(
        `UPDATE focus_areas SET name = $3, description = $4, updated_at = $5
          WHERE space_id = $1 AND id = $2
          RETURNING ${COLUMNS}`,
        [identity.spaceId, id, name, description, new Date().toISOString()],
      );
      return toOut(rows.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, "A focus area with that name already exists");
      throw error;
    }
  }

  /** Filing into an archived area would hide the content behind a hidden bucket. */
  private async requireActive(identity: SpaceUserIdentity, id: string): Promise<void> {
    const area = await this.get(identity, id);
    if (area.archived_at !== null) throw new HttpError(409, "Focus area is archived");
  }

  /**
   * What points at this area, filtered by the reader's own access. A focus area
   * grants nothing: content the reader could not otherwise see does not appear
   * here, and content they can see is listed whoever classified it.
   *
   * Each list is keyset-paged inside its unchanged read predicate, so a page
   * boundary never decides visibility; `id` breaks ties so no row is skipped
   * or repeated between pages.
   */
  async contents(
    identity: SpaceUserIdentity,
    id: string,
    query: FocusAreaContentsQuery = {},
  ): Promise<FocusAreaContents> {
    await this.get(identity, id);
    const limit = query.limit ?? FOCUS_AREA_CONTENTS_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > FOCUS_AREA_CONTENTS_MAX_PAGE_SIZE) {
      throw new HttpError(422, `limit must be between 1 and ${FOCUS_AREA_CONTENTS_MAX_PAGE_SIZE}`);
    }
    const projectsAfter = decodeCursor<ProjectCursor>(query.projectsCursor, id, "projects");
    const objectsAfter = decodeCursor<ObjectCursor>(query.objectsCursor, id, "objects");
    // Project metadata is space-visible by design — `projects/access.ts` reserves
    // the member ACL for project-scoped *content*. Filtering this list by that
    // ACL would show fewer Projects here than `/projects` already shows.
    const projects = await this.db.query<{ id: string; name: string; status: string }>(
      `SELECT p.id, p.name, p.status
         FROM projects p
        WHERE p.space_id = $1 AND p.focus_area_id = $2 AND p.deleted_at IS NULL
          AND ($3::text IS NULL OR (p.name::text, p.id::text) > ($3::text, $4::text))
        ORDER BY p.name::text ASC, p.id::text ASC
        LIMIT $5::int`,
      [identity.spaceId, id, projectsAfter?.name ?? null, projectsAfter?.id ?? null, limit + 1],
    );
    const objects = await this.db.query<{ id: string; object_type: string; title: string | null; cursor_at: string }>(
      // The cursor keeps the column's own precision; a JS Date would truncate
      // it to milliseconds and skip rows sharing that millisecond.
      `SELECT o.id, o.object_type, o.title, o.updated_at::text AS cursor_at
         FROM space_objects o
        WHERE o.space_id = $1 AND o.focus_area_id = $2 AND o.deleted_at IS NULL
          AND ${contentReadSql("space_object", "o", "$3")}
          AND ($4::timestamptz IS NULL OR (o.updated_at, o.id::text) < ($4::timestamptz, $5::text))
        ORDER BY o.updated_at DESC, o.id::text DESC
        LIMIT $6::int`,
      [identity.spaceId, id, identity.userId, objectsAfter?.at ?? null, objectsAfter?.id ?? null, limit + 1],
    );
    const projectPage = projects.rows.slice(0, limit);
    const objectPage = objects.rows.slice(0, limit);
    const lastProject = projectPage.at(-1);
    const lastObject = objectPage.at(-1);
    return {
      projects: projectPage,
      objects: objectPage.map((row) => ({ id: row.id, object_type: row.object_type, title: row.title })),
      projects_next_cursor: projects.rows.length > limit && lastProject
        ? encodeCursor({ area: id, list: "projects", name: lastProject.name, id: lastProject.id })
        : null,
      objects_next_cursor: objects.rows.length > limit && lastObject
        ? encodeCursor({ area: id, list: "objects", at: lastObject.cursor_at, id: lastObject.id })
        : null,
    };
  }
  /**
   * Classifying content is an owner's act. There is no general write guard for
   * `space_objects`, and inventing one for a classification would be inventing
   * a permission model this concept explicitly does not have (ADR 0015) — so
   * the narrow, already-true rule applies: the owner classifies.
   */
  async setObjectFocusArea(
    identity: SpaceUserIdentity,
    objectId: string,
    focusAreaId: string | null,
  ): Promise<void> {
    if (focusAreaId !== null) await this.requireActive(identity, focusAreaId);
    // Owned content is classified by its owner. Content with no owner —
    // agent-ingested sources and knowledge items — is classified by anyone
    // who can already read it, which the shared gate decides. Readability is
    // required either way, so this never reveals anything, and
    // `ck_space_objects_private_owner` guarantees the ownerless case is always
    // `space_shared`: it can never mean "hidden".
    // Oversight is excluded deliberately — it is a read-only admin capability
    // (ADR 0013) and must not authorize a write.
    const writable = await this.db.query<{ id: string }>(
      `SELECT o.id FROM space_objects o
        WHERE o.id = $1 AND o.space_id = $2 AND o.deleted_at IS NULL
          AND (o.owner_user_id = $3 OR o.owner_user_id IS NULL)
          AND ${contentReadSql("space_object", "o", "$3", { includeOversight: false })}`,
      [objectId, identity.spaceId, identity.userId],
    );
    if (!writable.rows[0]) throw new HttpError(404, "Object not found or not yours to classify");
    await this.db.query(
      `UPDATE space_objects SET focus_area_id = $3 WHERE id = $1 AND space_id = $2`,
      [objectId, identity.spaceId, focusAreaId],
    );
  }

  /** Stable classification admission shared by mutation and receipt replay. */
  async authorizeProjectClassification(identity: SpaceUserIdentity, focusAreaId: string | null): Promise<void> {
    if (focusAreaId === null) return;
    const row = await this.db.query<{archived_at: unknown}>('SELECT archived_at FROM focus_areas WHERE id=$1 AND space_id=$2 FOR SHARE', [focusAreaId,identity.spaceId]);
    if (!row.rows[0]) throw new HttpError(404, 'Focus area not found');
    if (row.rows[0].archived_at !== null) throw new FocusAreaArchivedError(409, 'Focus area is archived');
  }

  async setProjectFocusArea(
    identity: SpaceUserIdentity,
    projectId: string,
    focusAreaId: string | null,
  ): Promise<void> {
    if (focusAreaId !== null) await this.requireActive(identity, focusAreaId);
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    await this.db.query(
      `UPDATE projects SET focus_area_id = $3 WHERE id = $1 AND space_id = $2`,
      [projectId, identity.spaceId, focusAreaId],
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}
