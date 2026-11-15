import {
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  unique,
  varchar,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { users } from "./auth.js";
import { projects } from "./projects.js";

/**
 * Which existing Agents a Project works with — its Agent list.
 *
 * A reference, never a copy: one Agent can be linked to several Projects in
 * its Space and keeps a single definition, runtime profiles and memory. The
 * link grants nothing by itself. It does not share a private Agent with
 * anyone (every read still ANDs the Agent's own content ACL), does not put the
 * Agent on any Room roster and does not let it read a Room's history. Room
 * membership stays in `room_agent_members`; removing an Agent from a Room
 * keeps this row.
 */
export const projectAgentLinks = pgTable("project_agent_links", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull(),
  projectId: varchar("project_id", { length: 36 }).notNull(),
  agentId: varchar("agent_id", { length: 36 }).notNull(),
  status: varchar({ length: 32 }).notNull(),
  addedByUserId: varchar("added_by_user_id", { length: 36 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  removedAt: timestamp("removed_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_project_agent_links_project_agent").on(table.spaceId, table.projectId, table.agentId),
  index("ix_project_agent_links_agent").on(table.spaceId, table.agentId, table.status),
  index("ix_project_agent_links_project").on(table.spaceId, table.projectId, table.status, table.createdAt),
  foreignKey({
    columns: [table.projectId, table.spaceId],
    foreignColumns: [projects.id, projects.spaceId],
    name: "project_agent_links_project_scope_fkey",
  }).onDelete("cascade"),
  // Same-Space by construction: an Agent of another Space cannot be linked.
  foreignKey({
    columns: [table.agentId, table.spaceId],
    foreignColumns: [agents.id, agents.spaceId],
    name: "project_agent_links_agent_scope_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.addedByUserId],
    foreignColumns: [users.id],
    name: "project_agent_links_added_by_user_id_fkey",
  }).onDelete("restrict"),
  check("ck_project_agent_links_status", sql`status IN ('active', 'removed')`),
  check("ck_project_agent_links_removed_at", sql`(status = 'removed') = (removed_at IS NOT NULL)`),
]);
