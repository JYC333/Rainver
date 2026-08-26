/**
 * The single place that knows the `space_objects` column list.
 *
 * Before this existed there were 11 hand-written `INSERT INTO space_objects`
 * across 7 modules and 10 hand-written `UPDATE space_objects` across 5, each
 * assembling its own column list and its own defaults. Every new domain that
 * joins the ontology would have added another one, and each copy is a place to
 * forget a governance column (B12H).
 *
 * It builds a **SQL fragment plus its parameters** rather than executing a
 * query, because several callers embed the insert in a CTE
 * (`WITH obj AS (INSERT INTO space_objects ...) INSERT INTO <extension> ...`)
 * so that the root row and its extension row are written in one statement.
 * Turning those into two round trips would trade atomicity for tidiness.
 *
 * P2.7 added the B12H rules. They live here rather than at each call site
 * because a rule enforced in eleven places is a rule that will be missed in the
 * twelfth — and the miss is silent, producing an object that is readable by the
 * wrong people or untraceable to whoever made it.
 */

import { entityDefinition } from "../modules/ontology/entities.js";

const TITLE_MAX_LENGTH = 512;
const VISIBILITIES = new Set(["private", "space_shared", "selected_users"]);
const ACCESS_LEVELS = new Set(["full", "summary"]);

export class SpaceObjectWriteError extends Error {}

export interface SpaceObjectInsert {
  id: string;
  spaceId: string;
  objectType: string;
  /** Projection of the domain's own label; the domain field is the truth. */
  title: string;
  summary?: string | null;
  visibility?: string;
  accessLevel?: string;
  ownerUserId?: string | null;
  primaryProjectId?: string | null;
  projectFolderId?: string | null;
  createdByUserId?: string | null;
  createdByAgentId?: string | null;
  createdByRunId?: string | null;
  createdAt: string;
  updatedAt?: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
}

export interface SqlFragment {
  sql: string;
  params: unknown[];
}

/**
 * Builds `INSERT INTO space_objects (...) VALUES (...)`.
 *
 * `paramOffset` is the number of parameters the caller has already bound, so
 * the fragment can be concatenated into a larger statement. The returned
 * `params` are appended to the caller's own array in the same order.
 */
export function buildSpaceObjectInsert(input: SpaceObjectInsert, paramOffset = 0): SqlFragment {
  const entity = entityDefinition(input.objectType);
  if (!entity || (entity.entityType !== "space_object" && entity.rootEntity !== "space_object")) {
    throw new SpaceObjectWriteError(
      `${input.objectType} is not a registered ontology object type`,
    );
  }

  // B12H. The scope predicate reads `(project IS NULL OR projectReadAccess)`,
  // so a null Project on a Project-owned object does not narrow access — it
  // removes the Project gate entirely and leaves only visibility.
  if (entity.requiresProjectScope && !input.primaryProjectId) {
    throw new SpaceObjectWriteError(
      `${input.objectType} is Project-owned and requires primary_project_id`,
    );
  }

  const visibility = input.visibility ?? "space_shared";
  if (!VISIBILITIES.has(visibility)) {
    throw new SpaceObjectWriteError(`Invalid visibility: ${visibility}`);
  }
  const accessLevel = input.accessLevel ?? "full";
  if (!ACCESS_LEVELS.has(accessLevel)) {
    throw new SpaceObjectWriteError(`Invalid access level: ${accessLevel}`);
  }

  // The root title is a projection of the domain's label, so truncating it is
  // correct where failing the insert is not. Callers used to slice at their
  // own widths — one of them at 1024, past this column's 512 — which turned a
  // long label into a write error instead of a shortened display string.
  const title = input.title.trim();
  if (!title) throw new SpaceObjectWriteError("A space object requires a non-empty title");
  const projectedTitle = title.length > TITLE_MAX_LENGTH ? title.slice(0, TITLE_MAX_LENGTH) : title;

  // Provenance is what makes an object attributable after the fact; an object
  // with none is untraceable to any user, agent, or run.
  if (!input.createdByUserId && !input.createdByAgentId && !input.createdByRunId) {
    throw new SpaceObjectWriteError(
      `${input.objectType} requires created-by provenance (user, agent, or run)`,
    );
  }

  const params: unknown[] = [];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${paramOffset + params.length}`;
  };

  const updatedAt = input.updatedAt ?? input.createdAt;
  const columns: [string, string][] = [
    ["id", p(input.id)],
    ["space_id", p(input.spaceId)],
    ["object_type", p(input.objectType)],
    ["title", p(projectedTitle)],
    ["summary", p(input.summary ?? null)],
    ["visibility", p(visibility)],
    ["access_level", p(accessLevel)],
    ["owner_user_id", p(input.ownerUserId ?? null)],
    ["primary_project_id", p(input.primaryProjectId ?? null)],
    ["project_folder_id", p(input.projectFolderId ?? null)],
    ["created_by_user_id", p(input.createdByUserId ?? null)],
    ["created_by_agent_id", p(input.createdByAgentId ?? null)],
    ["created_by_run_id", p(input.createdByRunId ?? null)],
    ["created_at", `${p(input.createdAt)}::timestamptz`],
    ["updated_at", `${p(updatedAt)}::timestamptz`],
    ["archived_at", `${p(input.archivedAt ?? null)}::timestamptz`],
    ["deleted_at", `${p(input.deletedAt ?? null)}::timestamptz`],
  ];

  return {
    sql: `INSERT INTO space_objects (${columns.map(([name]) => name).join(", ")})\n`
      + `     VALUES (${columns.map(([, placeholder]) => placeholder).join(", ")})`,
    params,
  };
}
