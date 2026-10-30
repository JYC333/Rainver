import type { Queryable } from "../../routeUtils/common.js";
import { canReadProject, canWriteProject, projectReaderIds } from "../../projects/access.js";
import { contentAccessLevelSql } from "../../access/contentAccessSql.js";
import { contentResourceDefinition } from "../../access/contentAccessRegistry.js";
import { goalCollectionReadableSql } from "../../sources/goals/itemVisibility.js";
import { contentChangedInWindowSql, everyReader, hydrateCandidates, liveScopeMembers, sharedItems, type CandidateSignal } from "./candidates.js";
import {
  BRIEFING_LIMITS, contextSourceKey, signalKey, signalRevision,
  type BriefingContextEntry, type BriefingScopeAdapter, type BriefingSignalDep, type BriefingWindow,
} from "./contract.js";

const TASK_ACCESS = contentResourceDefinition("task")!;

/**
 * Project scope: the Project's Following, its deliverable monitoring decisions
 * and its Corpus, shared with every current Project reader. Material is
 * offered only when every current reader has full access (no Space
 * oversight), and Following material only when every reader may also read
 * its collecting Source. No member's private reading state is read.
 */
export function projectBriefingScope(spaceId: string, projectId: string): BriefingScopeAdapter {
  /**
   * The scope's signals: one row per (item, lens). `gated` applies the
   * Following collecting-Source gate for the whole audience. Without it the
   * query answers membership alone (`scopeMembers`): the same conditions of
   * selection, and no other reader-dependent filter exists here.
   */
  const signals = async (db: Queryable, audience: string[], window: BriefingWindow, gated: boolean) => {
    const inWindow = (column: string) => `(${column} > $4::timestamptz AND ${column} <= $5::timestamptz)`;
      // One row per (item, lens); the kernel merges lenses and reading families.
      const rows = await db.query<CandidateSignal>(
        `WITH following AS (
           SELECT gi.source_item_id, 'following'::text AS lens_kind,
                  COALESCE(NULLIF(g.compatibility_json->>'display_title',''), g.intent_json->>'intent', 'Following') AS lens_label,
                  gi.selection_reason AS signal,
                  GREATEST(gi.associated_at, gi.updated_at) AS activity_at,
                  (SELECT max(c.detected_at) FROM source_goal_item_changes c
                    WHERE c.goal_id = gi.goal_id AND c.source_item_id = gi.source_item_id
                      AND c.delivery_kind = 'evidenced_change' AND c.selection_status <> 'not_selected'
                      AND c.detected_at <= $5::timestamptz) AS change_at,
                  'goal_item'::text AS analysis_kind, gi.id AS analysis_id, b.source_connection_id AS connection_id
             FROM source_goal_items gi
             JOIN source_goals g ON g.id = gi.goal_id AND g.space_id = gi.space_id
             LEFT JOIN source_goal_bindings b ON b.id = gi.binding_id AND b.space_id = gi.space_id
             JOIN LATERAL (SELECT gi.binding_id, gi.space_id, gi.associated_at AS detected_at) membership ON true
            WHERE g.space_id = $1 AND g.project_id = $2 AND g.status <> 'deleted'
              AND gi.selection_status IN ('important', 'unjudged')
              AND gi.associated_at <= $5::timestamptz
              AND ${gated ? everyReader("$3", (user) => goalCollectionReadableSql("membership", user)) : "$3::varchar[] IS NOT NULL"}
         ), monitoring AS (
           SELECT d.source_item_id, 'monitoring'::text, 'Project monitoring'::text, d.reason,
                  GREATEST(pl.created_at, d.updated_at), NULL::timestamptz, 'decision'::text, d.id, dc.source_connection_id
             FROM source_post_processing_item_decisions d
             LEFT JOIN source_channels dc ON dc.id = d.source_channel_id AND dc.space_id = d.space_id
             JOIN project_information_monitoring_versions v
               ON v.rule_id = d.rule_id AND v.space_id = d.space_id AND v.project_id = $2
             JOIN project_source_item_links pl
               ON pl.source_item_id = d.source_item_id AND pl.space_id = d.space_id
              AND pl.project_id = $2 AND pl.status = 'active'
            WHERE d.space_id = $1 AND d.relevance = 'relevant' AND d.review_status NOT IN ('ignored', 'dismissed')
              AND GREATEST(pl.created_at, d.updated_at) <= $5::timestamptz
         ), corpus AS (
           SELECT COALESCE(pci.source_item_id, pcis.source_item_id), 'corpus'::text, 'Project corpus'::text, pci.reason,
                  pci.created_at, NULL::timestamptz, 'corpus_item'::text, pci.id, pci.source_connection_id
             FROM project_corpus_items pci
             LEFT JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id = pci.id AND pcis.space_id = pci.space_id
            WHERE pci.space_id = $1 AND pci.project_id = $2 AND pci.status = 'active'
              AND pci.triage_status <> 'excluded' AND COALESCE(pci.source_item_id, pcis.source_item_id) IS NOT NULL
              AND pci.created_at <= $5::timestamptz
         )
         SELECT * FROM (SELECT * FROM following UNION ALL SELECT * FROM monitoring UNION ALL SELECT * FROM corpus) rows
          WHERE ${inWindow("rows.activity_at")} OR ${inWindow("rows.change_at")} OR rows.source_item_id = ANY($6::varchar[])
             OR ${contentChangedInWindowSql("rows.source_item_id", "$4", "$5")}`,
        [spaceId, projectId, audience, window.since, window.cutoff, window.pinnedItemIds],
      );
    return rows.rows;
  };

  return {
    scope: { type: "project", spaceId, projectId, ownerUserId: null, key: `project:${projectId}` },
    audience: (db) => projectReaderIds(db, spaceId, projectId),
    canRead: (db, userId) => canReadProject(db, spaceId, projectId, userId),
    canGenerate: (db, userId) => canWriteProject(db, spaceId, projectId, userId),

    async candidates(db: Queryable, window: BriefingWindow) {
      const audience = await projectReaderIds(db, spaceId, projectId);
      return hydrateCandidates(db, spaceId, audience, await signals(db, audience, window, true));
    },

    async scopeMembers(db: Queryable, itemIds: string[], cutoff: string) {
      return liveScopeMembers(db, spaceId, await signals(db, [], { since: cutoff, cutoff, pinnedItemIds: itemIds }, false));
    },

    async context(db: Queryable) {
      const audience = await projectReaderIds(db, spaceId, projectId);
      const brief = (await db.query<{
        id: string; version: string; goal: string | null; scope_included: string | null; scope_excluded: string | null;
        success_definition: string | null; constraints: string | null; current_focus: string | null;
      }>(
        `SELECT b.id, b.version, b.goal, b.scope_included, b.scope_excluded, b.success_definition, b.constraints, b.current_focus
           FROM projects p JOIN project_brief_versions b ON b.id = p.active_brief_version_id AND b.space_id = p.space_id
          WHERE p.space_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
        [spaceId, projectId],
      )).rows[0];
      const entries: BriefingContextEntry[] = [];
      if (brief) {
        const source = { type: "brief_version" as const, id: brief.id, revision: brief.version };
        const add = (kind: BriefingContextEntry["kind"], label: string, text: string | null) => {
          if (text?.trim()) entries.push({ kind, label, text: text.trim().slice(0, 1200), source });
        };
        add("project_goal", "Project goal", brief.goal);
        add("project_scope", "Project scope", [brief.scope_included && `In scope: ${brief.scope_included}`, brief.scope_excluded && `Out of scope: ${brief.scope_excluded}`].filter(Boolean).join("\n") || null);
        add("project_success", "Success definition", brief.success_definition);
        add("project_constraints", "Constraints", brief.constraints);
        add("project_focus", "Current focus", brief.current_focus);
      }
      const tasks = await db.query<{ id: string; title: string; status: string; priority: string; updated_at: string }>(
        `SELECT t.id, t.title, t.status, t.priority, t.updated_at::text
           FROM tasks t
          WHERE t.space_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL
            AND t.status NOT IN ('done', 'cancelled', 'archived')
            AND ${everyReader("$3", (user) => `${contentAccessLevelSql({ definition: TASK_ACCESS, alias: "t", userExpr: user, includeOversight: false })} = 'full'`)}
          ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC, t.id
          LIMIT $4`,
        [spaceId, projectId, audience, BRIEFING_LIMITS.maxContextTasks],
      );
      for (const task of tasks.rows) {
        entries.push({
          kind: "task",
          label: `Task: ${task.title}`.slice(0, 200),
          text: `${task.title} (status ${task.status}, priority ${task.priority})`,
          source: { type: "task", id: task.id, revision: new Date(task.updated_at).toISOString() },
        });
      }
      return entries;
    },

    async allowedItems(db: Queryable, itemIds: string[]) {
      return sharedItems(db, spaceId, await projectReaderIds(db, spaceId, projectId), itemIds);
    },

    async signalState(db: Queryable, signals: BriefingSignalDep[]) {
      const audience = await projectReaderIds(db, spaceId, projectId);
      const ids = (kind: BriefingSignalDep["kind"]) => signals.filter((dep) => dep.kind === kind).map((dep) => dep.id);
      // Permission and current text only: a later triage change is not a revocation.
      const rows = await db.query<{ kind: BriefingSignalDep["kind"]; id: string; label: string; text: string | null }>(
        `SELECT 'goal_item' AS kind, gi.id,
                COALESCE(NULLIF(g.compatibility_json->>'display_title',''), g.intent_json->>'intent', 'Following') AS label,
                gi.selection_reason AS text
           FROM source_goal_items gi
           JOIN source_goals g ON g.id = gi.goal_id AND g.space_id = gi.space_id
           JOIN LATERAL (SELECT gi.binding_id, gi.space_id, gi.associated_at AS detected_at) membership ON true
          WHERE gi.space_id = $1 AND g.project_id = $2 AND g.status <> 'deleted' AND gi.id = ANY($4::varchar[])
            AND ${everyReader("$3", (user) => goalCollectionReadableSql("membership", user))}
         UNION ALL
         SELECT 'decision', d.id, 'Project monitoring', d.reason
           FROM source_post_processing_item_decisions d
           JOIN project_source_item_links pl
             ON pl.source_item_id = d.source_item_id AND pl.space_id = d.space_id AND pl.project_id = $2 AND pl.status = 'active'
          WHERE d.space_id = $1 AND d.id = ANY($5::varchar[])
         UNION ALL
         SELECT 'corpus_item', pci.id, 'Project corpus', pci.reason
           FROM project_corpus_items pci
          WHERE pci.space_id = $1 AND pci.project_id = $2 AND pci.id = ANY($6::varchar[])`,
        [spaceId, projectId, audience, ids("goal_item"), ids("decision"), ids("corpus_item")],
      );
      return new Map(rows.rows.map((row) => [signalKey(row), signalRevision(row.label, row.text?.trim() || null)]));
    },

    async contextState(db: Queryable, sources: BriefingContextEntry["source"][]) {
      const audience = await projectReaderIds(db, spaceId, projectId);
      const allowed = new Set<string>();
      let outdated = false;
      const briefIds = [...new Set(sources.filter((source) => source.type === "brief_version").map((source) => source.id))];
      if (briefIds.length > 0) {
        const active = (await db.query<{ active_brief_version_id: string | null }>(
          `SELECT active_brief_version_id FROM projects WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [spaceId, projectId],
        )).rows[0];
        // A brief version is Project-level context every reader shares; a newer one makes this outdated, not secret.
        if (active) for (const id of briefIds) {
          allowed.add(`brief_version:${id}`);
          if (active.active_brief_version_id !== id) outdated = true;
        }
      }
      const taskSources = sources.filter((source) => source.type === "task");
      if (taskSources.length > 0) {
        const rows = await db.query<{ id: string; updated_at: string }>(
          `SELECT t.id, t.updated_at::text FROM tasks t
            WHERE t.space_id = $1 AND t.project_id = $2 AND t.id = ANY($3::varchar[]) AND t.deleted_at IS NULL
              AND ${everyReader("$4", (user) => `${contentAccessLevelSql({ definition: TASK_ACCESS, alias: "t", userExpr: user, includeOversight: false })} = 'full'`)}`,
          [spaceId, projectId, taskSources.map((source) => source.id), audience],
        );
        const current = new Map(rows.rows.map((row) => [row.id, new Date(row.updated_at).toISOString()]));
        for (const source of taskSources) {
          if (!current.has(source.id)) continue;
          allowed.add(contextSourceKey(source));
          if (current.get(source.id) !== source.revision) outdated = true;
        }
      }
      return { allowed, outdated };
    },
  };
}
