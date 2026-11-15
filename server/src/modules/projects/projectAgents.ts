import { roomAgentUseSql } from "../rooms/agentUsageSql.js";
import { randomUUID } from "node:crypto";
import type { ProjectAgent, ProjectAgentCandidate } from "@rainver/protocol";
import { contentReadSql } from "../access/contentAccessSql.js";
import { escapeLikePattern, type Queryable } from "../routeUtils/common.js";
import { assertProjectReadable, canWriteProject } from "./access.js";

/**
 * A Project's Agent list (`project_agent_links`).
 *
 * The link is a reference to one existing Agent, never a copy, and it grants
 * nothing on its own: the Agent's content ACL still decides who may see or use
 * it, Room rosters still decide which conversations it is in, and a Room's
 * history is never readable through it. Every read here therefore ANDs the
 * viewer's own Agent read gate, and Room names only come from Rooms the viewer
 * is an active member of.
 */

/**
 * Which Agents a person may link to a Project: their own library entries in the
 * Project's Space that they can read, not bound to another Project, and — for
 * an Agent that is not shared with the Space — only their own. Linking a
 * private Agent never shares it; the Project list keeps hiding it from everyone
 * the Agent's own ACL hides it from.
 *
 * Placeholders: `$1` Space, `$2` person, `$3` Project.
 */
function linkableAgentSql(alias: string): string {
  return `${alias}.space_id = $1
      AND ${alias}.agent_kind = 'standard'
      AND ${alias}.status = 'active'
      AND (${alias}.project_id IS NULL OR ${alias}.project_id = $3)
      AND (${alias}.visibility = 'space_shared' OR ${alias}.owner_user_id = $2)
      AND ${contentReadSql("agent", alias, "$2")}`;
}

function searchSql(params: unknown[], alias: string, q: string | null | undefined): string {
  const term = q?.trim();
  if (!term) return "";
  return `AND ${alias}.name ILIKE $${params.push(`%${escapeLikePattern(term)}%`)} ESCAPE '\\'`;
}

export class PgProjectAgentRepository {
  constructor(private readonly db: Queryable) {}

  /** The Agent if this person may link it to this Project; `lock` holds it for the linking transaction. */
  async linkableAgent(input: { spaceId: string; userId: string; projectId: string; agentId: string; lock?: boolean }) {
    const result = await this.db.query<{ id: string }>(
      `SELECT a.id FROM agents a
        WHERE ${linkableAgentSql("a")} AND a.id = $4
        ${input.lock ? "FOR SHARE OF a" : ""}`,
      [input.spaceId, input.userId, input.projectId, input.agentId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Add, or reactivate, one link. Idempotent: an active link is left as it
   * is, so a repeated add (or a Room add of an Agent already on the list)
   * changes nothing.
   */
  async upsertActive(input: { spaceId: string; projectId: string; agentId: string; userId: string }): Promise<{ id: string; created: boolean }> {
    const result = await this.db.query<{ id: string; created: boolean }>(
      `INSERT INTO project_agent_links
              (id, space_id, project_id, agent_id, status, added_by_user_id, created_at, updated_at, removed_at)
       VALUES ($1, $2, $3, $4, 'active', $5, now(), now(), NULL)
       ON CONFLICT (space_id, project_id, agent_id) DO UPDATE
          SET status = 'active',
              removed_at = NULL,
              added_by_user_id = CASE WHEN project_agent_links.status = 'removed'
                                      THEN EXCLUDED.added_by_user_id ELSE project_agent_links.added_by_user_id END,
              created_at = CASE WHEN project_agent_links.status = 'removed'
                                THEN EXCLUDED.created_at ELSE project_agent_links.created_at END,
              updated_at = CASE WHEN project_agent_links.status = 'removed'
                                THEN EXCLUDED.updated_at ELSE project_agent_links.updated_at END
       RETURNING id, (xmax = 0) AS created`,
      [randomUUID(), input.spaceId, input.projectId, input.agentId, input.userId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("project_agent_links upsert returned no row");
    return row;
  }

  /** Locks and returns the active link, if any. */
  async activeLink(input: { spaceId: string; projectId: string; agentId: string; lock?: boolean }) {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM project_agent_links
        WHERE space_id = $1 AND project_id = $2 AND agent_id = $3 AND status = 'active'
        ${input.lock ? "FOR UPDATE" : ""}`,
      [input.spaceId, input.projectId, input.agentId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Whether this Agent may start new work placed in this Project: it is on the
   * Project's Agent list, or it is the Project's own managed Assistant.
   */
  async projectUsesAgent(input: { spaceId: string; projectId: string; agentId: string; lock?: boolean }): Promise<boolean> {
    // `lock`: the admitting transaction holds the link, so a concurrent removal waits for it.
    if (input.lock) {
      const link = await this.db.query(
        `SELECT link.id FROM project_agent_links link
           JOIN agents a ON a.id = link.agent_id AND a.space_id = link.space_id
          WHERE link.space_id = $1 AND link.project_id = $2 AND link.agent_id = $3 AND link.status = 'active'
          FOR SHARE OF link`,
        [input.spaceId, input.projectId, input.agentId],
      );
      if (link.rows.length > 0) return true;
    }
    const result = await this.db.query(
      `SELECT 1 FROM agents a
        WHERE a.space_id = $1 AND a.id = $3
          AND (
            (a.agent_kind = 'system_assistant' AND a.project_id = $2)
            OR EXISTS (
              SELECT 1 FROM project_agent_links link
               WHERE link.space_id = a.space_id AND link.project_id = $2
                 AND link.agent_id = a.id AND link.status = 'active'
            )
          )`,
      [input.spaceId, input.projectId, input.agentId],
    );
    return result.rows.length > 0;
  }

  async markRemoved(input: { spaceId: string; linkId: string }): Promise<void> {
    await this.db.query(
      `UPDATE project_agent_links
          SET status = 'removed', removed_at = now(), updated_at = now()
        WHERE space_id = $1 AND id = $2 AND status = 'active'`,
      [input.spaceId, input.linkId],
    );
  }

  /** Whether the person can read this Agent at all — the gate a removal answers 404 behind. */
  async agentReadable(input: { spaceId: string; userId: string; agentId: string }): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM agents a WHERE a.space_id = $1 AND a.id = $3 AND ${contentReadSql("agent", "a", "$2")}`,
      [input.spaceId, input.userId, input.agentId],
    );
    return result.rows.length > 0;
  }

  /** One Agent on the Project's list, under the same viewer gates as `list`; `null` when it is not on it for them. */
  async get(input: { spaceId: string; userId: string; projectId: string; agentId: string }): Promise<ProjectAgent | null> {
    const page = await this.list({ ...input, limit: 1, offset: 0 });
    return page.items[0] ?? null;
  }

  async list(input: { spaceId: string; userId: string; projectId: string; agentId?: string; q?: string | null; limit: number; offset: number }): Promise<{ items: ProjectAgent[]; total: number }> {
    const params: unknown[] = [input.spaceId, input.userId, input.projectId];
    const search = searchSql(params, "a", input.q);
    const only = input.agentId ? `AND link.agent_id = $${params.push(input.agentId)}` : "";
    const readable = contentReadSql("agent", "a", "$2");
    const usableInRoom = `EXISTS (SELECT 1 FROM rooms usage_project_room
      WHERE usage_project_room.space_id=a.space_id AND usage_project_room.project_id=$3
        AND ${roomAgentUseSql("a", "$2", "usage_project_room.id")})`;
    const from = `
         FROM project_agent_links link
         JOIN agents a ON a.id = link.agent_id AND a.space_id = link.space_id
        WHERE link.space_id = $1 AND link.project_id = $3 AND link.status = 'active'
          AND a.status <> 'archived'
          AND (${readable} OR ${usableInRoom})
          ${only}
          ${search}`;
    const total = await this.db.query<{ total: string }>(`SELECT count(*)::text AS total ${from}`, params);
    const limitIndex = params.push(input.limit);
    const offsetIndex = params.push(input.offset);
    const rows = await this.db.query<Omit<ProjectAgent, "added_at"> & { added_at: string | Date }>(
      `SELECT a.id AS agent_id, a.name,
              CASE WHEN ${readable} THEN a.description ELSE NULL END AS description,
              NOT ${readable} AS room_only,
              a.agent_kind, a.visibility, a.status,
              (a.visibility <> 'space_shared' OR (a.access_project_id IS NOT NULL AND a.access_project_id <> $3)) AS private,
              (a.owner_user_id IS NOT NULL AND a.owner_user_id = $2) AS viewer_is_owner,
              link.created_at AS added_at,
              -- Only Rooms the viewer is itself an active member of: the list must not
              -- become a way to learn that a limited Room exists (ADR 0018 decision 3).
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object('room_id', room.id, 'title', room.title, 'is_mainline', room.is_mainline)
                                 ORDER BY room.is_mainline DESC, room.created_at ASC, room.id ASC)
                  FROM room_agent_members member
                  JOIN rooms room ON room.id = member.room_id AND room.space_id = member.space_id
                  JOIN room_user_members viewer
                    ON viewer.room_id = room.id AND viewer.space_id = room.space_id
                   AND viewer.user_id = $2 AND viewer.status = 'active'
                 WHERE member.space_id = link.space_id AND member.agent_id = a.id
                   AND member.status = 'active' AND room.project_id = link.project_id
                   AND room.status = 'active'
              ), '[]'::jsonb) AS rooms
        ${from}
        ORDER BY link.created_at ASC, link.id ASC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params,
    );
    return {
      items: rows.rows.map((row) => ({ ...row, description: row.description ?? null, added_at: new Date(row.added_at).toISOString() })),
      total: Number(total.rows[0]?.total ?? 0),
    };
  }

  async candidates(input: { spaceId: string; userId: string; projectId: string; q?: string | null; limit: number; offset: number }): Promise<{ items: ProjectAgentCandidate[]; total: number }> {
    const params: unknown[] = [input.spaceId, input.userId, input.projectId];
    const search = searchSql(params, "a", input.q);
    const from = `FROM agents a WHERE ${linkableAgentSql("a")} ${search}`;
    const total = await this.db.query<{ total: string }>(`SELECT count(*)::text AS total ${from}`, params);
    const limitIndex = params.push(input.limit);
    const offsetIndex = params.push(input.offset);
    const rows = await this.db.query<ProjectAgentCandidate>(
      `SELECT a.id AS agent_id, a.name, a.description, a.visibility,
              (a.visibility <> 'space_shared' OR (a.access_project_id IS NOT NULL AND a.access_project_id <> $3)) AS private,
              EXISTS (
                SELECT 1 FROM project_agent_links link
                 WHERE link.space_id = a.space_id AND link.project_id = $3
                   AND link.agent_id = a.id AND link.status = 'active'
              ) AS linked
        ${from}
        ORDER BY linked ASC, a.name ASC, a.id ASC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params,
    );
    return { items: rows.rows.map((row) => ({ ...row, description: row.description ?? null })), total: Number(total.rows[0]?.total ?? 0) };
  }
}

/** Project-read gated reads of the Project's Agent list and of what may be added to it. */
export class ProjectAgentReadService {
  constructor(private readonly db: Queryable) {}

  async list(identity: { spaceId: string; userId: string }, projectId: string, input: { q?: string | null; limit: number; offset: number }) {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const page = await new PgProjectAgentRepository(this.db).list({ ...identity, projectId, ...input });
    const viewerCanWrite = await canWriteProject(this.db, identity.spaceId, projectId, identity.userId);
    return { ...page, limit: input.limit, offset: input.offset, viewer_can_write: viewerCanWrite };
  }

  /**
   * One Agent on the Project's list for this viewer — the single-link check a
   * direct-chat page uses, independent of how long the list is.
   */
  async get(identity: { spaceId: string; userId: string }, projectId: string, agentId: string): Promise<ProjectAgent | null> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    return new PgProjectAgentRepository(this.db).get({ ...identity, projectId, agentId });
  }

  async candidates(identity: { spaceId: string; userId: string }, projectId: string, input: { q?: string | null; limit: number; offset: number }) {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const page = await new PgProjectAgentRepository(this.db).candidates({ ...identity, projectId, ...input });
    return { ...page, limit: input.limit, offset: input.offset };
  }
}
