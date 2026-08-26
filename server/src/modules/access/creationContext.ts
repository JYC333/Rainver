import type { Queryable } from "../routeUtils/common.js";
import { HttpError } from "../routeUtils/common.js";
import type { ContentVisibility } from "./contentAccessTypes.js";

export interface ContentCreationContext {
  spaceId: string;
  projectId: string | null;
  visibility: ContentVisibility;
}

type CreationContextResolver = typeof resolveContentCreationContextImpl;
let resolverOverride: CreationContextResolver | null = null;

export function __setContentCreationContextResolverForTests(
  resolver: CreationContextResolver | null,
): void {
  resolverOverride = resolver;
}

/**
 * Resolves the three privacy dimensions for a user-initiated content creation.
 *
 * Project context is the sharing action: the new row stays in that Project's
 * Space, is Project-scoped, and is shared with eligible Project members.
 * Without Project context the action is personal, regardless of the Space the
 * browser happened to be showing when the request was sent.
 */
export async function resolveContentCreationContext(
  db: Queryable,
  input: {
    userId: string;
    requestSpaceId: string;
    projectId?: string | null;
    wholeSpace?: boolean;
  },
): Promise<ContentCreationContext> {
  if (resolverOverride) return resolverOverride(db, input);
  return resolveContentCreationContextImpl(db, input);
}

async function resolveContentCreationContextImpl(
  db: Queryable,
  input: {
    userId: string;
    requestSpaceId: string;
    projectId?: string | null;
    wholeSpace?: boolean;
  },
): Promise<ContentCreationContext> {
  const projectId = normalizedId(input.projectId);
  if (projectId && input.wholeSpace) {
    throw new HttpError(422, "Creation context cannot be both Project-scoped and whole-Space");
  }
  if (projectId) {
    const project = await db.query<{ id: string; space_id: string }>(
      `SELECT p.id, p.space_id
         FROM projects p
         JOIN space_memberships membership
           ON membership.space_id = p.space_id
          AND membership.user_id = $3
          AND membership.status = 'active'
        WHERE p.id = $1
          AND p.space_id = $2
          AND p.deleted_at IS NULL
          AND p.status = 'active'
          AND (
            p.owner_user_id = $3
            OR membership.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1
                FROM project_members project_member
               WHERE project_member.space_id = p.space_id
                 AND project_member.project_id = p.id
                 AND project_member.user_id = $3
                 AND project_member.status = 'active'
                 AND project_member.role IN ('owner', 'member')
            )
          )
        LIMIT 1`,
      [projectId, input.requestSpaceId, input.userId],
    );
    const row = project.rows[0];
    if (!row) throw new HttpError(403, "Project creation requires an active writer role");
    return { spaceId: row.space_id, projectId: row.id, visibility: "space_shared" };
  }

  if (input.wholeSpace) {
    const membership = await db.query<{ id: string }>(
      `SELECT space.id
         FROM spaces space
         JOIN space_memberships membership
           ON membership.space_id = space.id
          AND membership.user_id = $2
          AND membership.status = 'active'
        WHERE space.id = $1
        LIMIT 1`,
      [input.requestSpaceId, input.userId],
    );
    if (!membership.rows[0]) throw new HttpError(422, "Space not found");
    return { spaceId: membership.rows[0].id, projectId: null, visibility: "space_shared" };
  }

  const personal = await db.query<{ id: string }>(
    `SELECT space.id
       FROM spaces space
       JOIN space_memberships membership
         ON membership.space_id = space.id
        AND membership.user_id = $1
        AND membership.status = 'active'
      WHERE space.type = 'personal'
      ORDER BY space.created_at ASC, space.id ASC
      LIMIT 2`,
    [input.userId],
  );
  if (personal.rows.length !== 1) {
    throw new HttpError(409, "A unique Personal Space is required for context-free creation");
  }
  return { spaceId: personal.rows[0]!.id, projectId: null, visibility: "private" };
}

export function applyContentCreationContext(
  body: Record<string, unknown>,
  context: ContentCreationContext,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body, visibility: context.visibility };
  if (context.projectId) next.project_id = context.projectId;
  else {
    delete next.project_id;
    delete next.primary_project_id;
    delete next.project_folder_id;
  }
  return next;
}

function normalizedId(value: string | null | undefined): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  return id || null;
}
