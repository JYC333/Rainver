import { MyAgentsPageSchema, type MyAgent, type MyAgentPluginState, type MyAgentsPage, type MyAgentsQuery } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import type { Queryable } from "../routeUtils/common.js";
import { contentOwnerFilterSql, contentReadSql, projectReadAccessSql } from "../access/contentAccessSql.js";
import { roomAgentUseSql } from "../rooms/agentUsageSql.js";
import { operationPluginEnabled } from "../plugins/operationEnablement.js";
import { isPluginProjectBound, projectBoundManifest } from "../plugins/projectBindings.js";
import { pluginOfAgentRole } from "../plugins/agentRoleAdmission.js";

interface AgentRow {
  agent_id: string; space_id: string; space_name: string; name: string; description: string | null; status: string;
  readable: boolean; owned: boolean; can_manage: boolean; unowned: boolean; source_role_id: string | null;
  home_project_id: string | null; home_project_name: string | null;
  access: MyAgent["access"]; management: MyAgent["management"]; plugin_id: string | null;
}
interface RoomRow { agent_id: string; project_id: string; project_name: string; room_id: string; title: string; is_mainline: boolean }

/**
 * One person's Agents across every Space they are an active member of
 * (`GET /api/v1/me/agents`, [agents guide](../../../../.agent/modules/agents.md), "My Agents").
 *
 * Nothing here is a new authority. An Agent is listed through the ordinary
 * Agent content gate (`contentReadSql`) or through the Room execution gate
 * (`roomAgentUseSql`) in one of its Space's Rooms; a Room-only entry shows its
 * name and those Rooms only. Management is `canChangeAgent`'s rule. The Rooms
 * named are those `roomAgentUseSql` admits for this person now, so each is a
 * Room they are an active member of in a Project they read; a plugin Agent's
 * Room counts as usable only where its plugin is enabled for them and, for a
 * Project-bound package, bound to that Project — the companion admission's
 * conditions (`plugins/agentRoleAdmission.ts`), which still decide every Run.
 */
export async function listMyAgents(
  db: Queryable,
  config: ServerConfig | undefined,
  userId: string,
  query: MyAgentsQuery & { limit: number; offset: number },
): Promise<MyAgentsPage> {
  const readable = contentReadSql("agent", "a", "$1");
  const owner = contentOwnerFilterSql("agent", "a", "$1");
  // Same Project condition as the Room list below: an archived Project's Room never admits an entry.
  const roomUse = `EXISTS (SELECT 1 FROM rooms listed_room
    JOIN projects listed_project ON listed_project.id = listed_room.project_id AND listed_project.space_id = listed_room.space_id
         AND listed_project.deleted_at IS NULL AND listed_project.status = 'active'
    WHERE listed_room.space_id = a.space_id AND ${roomAgentUseSql("a", "$1", "listed_room.id", { anyAgentStatus: true })})`;
  const filters: string[] = [];
  if (query.manage === "manageable") filters.push("v.can_manage");
  if (query.source === "mine") filters.push("v.owned");
  if (query.source === "shared") filters.push("v.readable AND NOT v.owned");
  if (query.source === "room_only") filters.push("NOT v.readable");
  // The plugin source is Agent content: a Room-only entry never matches it.
  if (query.source === "plugin") filters.push("v.readable AND position('.' in COALESCE(v.source_role_id, '')) > 1");
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const visible = `
    WITH v AS (
      SELECT a.id AS agent_id, a.space_id, s.name AS space_name, a.name, a.status, a.created_at,
             ${readable} AS readable,
             (a.owner_user_id IS NOT NULL AND a.owner_user_id = $1) AS owned,
             (a.owner_user_id IS NULL) AS unowned,
             CASE WHEN a.owner_user_id IS NOT NULL THEN (${readable} AND ${owner})
                  ELSE sm.role IN ('owner', 'admin') END AS can_manage,
             CASE WHEN ${readable} THEN a.description END AS description,
             a.source_role_id,
             CASE WHEN ${readable} AND home.id IS NOT NULL AND ${projectReadAccessSql("a.space_id", "home.id", "$1")} THEN home.id END AS home_project_id,
             CASE WHEN ${readable} AND home.id IS NOT NULL AND ${projectReadAccessSql("a.space_id", "home.id", "$1")} THEN home.name END AS home_project_name
        FROM agents a
        JOIN space_memberships sm ON sm.space_id = a.space_id AND sm.user_id = $1 AND sm.status = 'active'
        JOIN spaces s ON s.id = a.space_id
        LEFT JOIN projects home ON home.id = a.access_project_id AND home.space_id = a.space_id
             AND home.deleted_at IS NULL AND home.status = 'active'
       WHERE a.agent_kind <> 'system_assistant' AND a.status <> 'archived'
         AND (${readable} OR ${roomUse})
    )`;
  // One statement, so one snapshot: the page, its total and the revision of the whole list agree.
  // The revision digests exactly what the list shows of each entry, already redacted, and where
  // (not its Rooms, read below): `access`, `management` and the plugin id are the response's own
  // values, so a Room-only entry's hidden source, ownership or description never reaches it. Each
  // entry is one JSON array in list order, so a null, an empty string and a field boundary all
  // stay distinct.
  const order = "v.space_name ASC, v.space_id ASC, (v.status = 'active') DESC, lower(v.name) ASC, v.agent_id ASC";
  const result = (await db.query<AgentRow & { list_total: string; list_revision: string; listed: boolean }>(
    `${visible}, f AS (
      SELECT v.*,
             CASE WHEN NOT v.readable THEN 'room_only' WHEN v.owned THEN 'owner' ELSE 'shared' END AS access,
             CASE WHEN v.can_manage THEN 'manage' WHEN NOT v.readable THEN 'room_only'
                  WHEN v.unowned THEN 'space_admin_only' ELSE 'owner_only' END AS management,
             CASE WHEN v.readable AND position('.' in COALESCE(v.source_role_id, '')) > 1
                  THEN split_part(v.source_role_id, '.', 1) END AS plugin_id
        FROM v ${where}),
      meta AS (SELECT count(*)::text AS list_total,
                      encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_array(
                        v.agent_id, v.space_id, v.space_name, v.name, v.status, v.description,
                        v.access, v.management, v.plugin_id, v.home_project_id, v.home_project_name)
                        ORDER BY ${order}), '[]'::jsonb)::text, 'UTF8')), 'hex') AS list_revision
                 FROM f v)
    SELECT meta.list_total, meta.list_revision, page.agent_id IS NOT NULL AS listed, page.*
      FROM meta LEFT JOIN LATERAL (SELECT * FROM f v ORDER BY ${order} LIMIT $2 OFFSET $3) page ON true
     ORDER BY ${order.replaceAll("v.", "page.")}`,
    [userId, query.limit, query.offset],
  )).rows;
  const rows = result.filter((row) => row.listed);
  const listTotal = Number(result[0]?.list_total ?? 0);
  const revision = result[0]?.list_revision ?? "";
  const ids = rows.map((row) => row.agent_id);
  const rooms = ids.length ? (await db.query<RoomRow>(
    `SELECT a.id AS agent_id, project.id AS project_id, project.name AS project_name,
            room.id AS room_id, room.title, room.is_mainline
       FROM agents a
       JOIN rooms room ON room.space_id = a.space_id
       JOIN projects project ON project.id = room.project_id AND project.space_id = room.space_id
            AND project.deleted_at IS NULL AND project.status = 'active'
      WHERE a.id = ANY($2::varchar[]) AND ${roomAgentUseSql("a", "$1", "room.id")}
      ORDER BY lower(project.name) ASC, project.id ASC, room.is_mainline DESC, room.created_at ASC, room.id ASC`,
    [userId, ids],
  )).rows : [];
  const pluginState = pluginStates(db, config, userId);
  const items: MyAgent[] = [];
  for (const row of rows) {
    const pluginId = pluginOfAgentRole(row.source_role_id);
    const locations = new Map<string, MyAgent["locations"][number]>();
    for (const room of rooms.filter((item) => item.agent_id === row.agent_id)) {
      let location = locations.get(room.project_id);
      if (!location) {
        location = { project_id: room.project_id, project_name: room.project_name,
          plugin_state: pluginId ? await pluginState(pluginId, row.space_id, room.project_id) : null, rooms: [] };
        locations.set(room.project_id, location);
      }
      location.rooms.push({ room_id: room.room_id, title: room.title, is_mainline: room.is_mainline });
    }
    // A Room-only entry never reveals its plugin source: only the Rooms that work
    // for the person now are named, with no plugin state.
    const placed = row.readable ? [...locations.values()] : [...locations.values()]
      .filter((location) => location.plugin_state === null || location.plugin_state === "ready")
      .map((location) => ({ ...location, plugin_state: null }));
    items.push({
      agent_id: row.agent_id,
      space_id: row.space_id,
      space_name: row.space_name,
      name: row.name,
      description: row.readable ? row.description ?? null : null,
      status: row.status,
      // The values the revision digests, projected once in SQL.
      access: row.access,
      management: row.management,
      can_open_detail: row.readable,
      // A plugin's Agent works only in its plugin's Project Rooms; its direct chat refuses.
      can_direct_chat: row.readable && row.status === "active" && !pluginId,
      plugin_id: row.plugin_id,
      home_project: row.home_project_id && row.home_project_name !== null ? {
        project_id: row.home_project_id,
        project_name: row.home_project_name,
        plugin_state: pluginId ? await pluginState(pluginId, row.space_id, row.home_project_id) : null,
      } : null,
      usable_room_count: placed
        .filter((location) => location.plugin_state === null || location.plugin_state === "ready")
        .reduce((sum, location) => sum + location.rooms.length, 0),
      locations: placed,
    });
  }
  return MyAgentsPageSchema.parse({ items, total: listTotal, limit: query.limit, offset: query.offset, revision });
}

/** Whether a plugin Agent can work in one Project for this person, memoized per page. */
function pluginStates(db: Queryable, config: ServerConfig | undefined, userId: string) {
  const enabled = new Map<string, Promise<boolean>>();
  const bound = new Map<string, Promise<boolean>>();
  return async (pluginId: string, spaceId: string, projectId: string): Promise<MyAgentPluginState> => {
    const enabledKey = `${pluginId}\u0000${spaceId}`;
    if (!enabled.has(enabledKey)) enabled.set(enabledKey, operationPluginEnabled(db, pluginId, spaceId, userId, config));
    if (!await enabled.get(enabledKey)) return "disabled";
    if (!projectBoundManifest(config, pluginId)) return "ready";
    const boundKey = `${pluginId}\u0000${spaceId}\u0000${projectId}`;
    if (!bound.has(boundKey)) bound.set(boundKey, isPluginProjectBound(db, pluginId, spaceId, projectId));
    return await bound.get(boundKey) ? "ready" : "unbound";
  };
}
