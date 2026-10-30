import type { Queryable } from "../../routeUtils/common.js";
import { canReadProject } from "../../projects/access.js";
import { goalCollectionReadableSql } from "../../sources/goals/itemVisibility.js";
import { ReadingPreferences } from "../readingPreferences.js";
import { contentChangedInWindowSql, everyReader, hydrateCandidates, sharedItems, type CandidateSignal } from "./candidates.js";
import {
  BRIEFING_LIMITS, contextSourceKey, signalKey, signalRevision,
  type BriefingContextEntry, type BriefingScopeAdapter, type BriefingSignalDep, type BriefingWindow,
} from "./contract.js";

const TOPIC = (goal: string) => `COALESCE(NULLIF(${goal}.compatibility_json->>'display_title',''), ${goal}.intent_json->>'intent', 'Following')`;
/** A lens label names its Project, so one item seen from a topic and from a Project keeps both views. */
const PROJECT_LABEL = (project: string, what: string) => `'Project "' || left(${project}.name, 120) || '": ' || ${what}`;

/**
 * Personal scope: one reader in the current Space; the result is theirs
 * alone. Its material is what their own Reading already draws on:
 * - their personal Following (topics with no Project);
 * - items their subscribed channels delivered (an existing analysis makes
 *   them ready; without one they wait, carried);
 * - the Following, deliverable monitoring and Corpus of each Project they
 *   explicitly opted into their Reading (`ReadingPreferences`) and may still
 *   read — never a Project merely because they could read it.
 * Every item, and every collecting Source, is gated for this reader alone
 * (full access, no Space oversight); nothing about another member is read.
 * Its only context is their own Following topics, so a reader with none
 * still gets a briefing; no Memory or interest profile is read or written.
 * Leaving a Project's Reading, losing access to it or deleting it withdraws
 * every signal that came through it (`signalState`), and with them whatever
 * a briefing rested on them, through the kernel's one authorization rule.
 */
export function personalBriefingScope(spaceId: string, userId: string): BriefingScopeAdapter {
  const audience = [userId];
  /** Projects this reader opted into their Reading and may read now. */
  const optedProjects = async (db: Queryable) => {
    const enabled = await new ReadingPreferences(db).enabled({ spaceId, userId });
    const readable = await Promise.all(enabled.map(async (projectId) => (await canReadProject(db, spaceId, projectId, userId)) ? projectId : null));
    return readable.filter((projectId): projectId is string => Boolean(projectId));
  };
  return {
    scope: { type: "personal", spaceId, projectId: null, ownerUserId: userId, key: `personal:${userId}` },
    audience: async () => audience,
    canRead: async (_db, viewer) => viewer === userId,
    canGenerate: async (_db, viewer) => viewer === userId,

    async candidates(db: Queryable, window: BriefingWindow) {
      const projects = await optedProjects(db);
      const inWindow = (column: string) => `(${column} > $4::timestamptz AND ${column} <= $5::timestamptz)`;
      const signals = await db.query<CandidateSignal>(
        `WITH following AS (
           SELECT gi.source_item_id, 'following'::text AS lens_kind,
                  CASE WHEN g.project_id IS NULL THEN ${TOPIC("g")} ELSE ${PROJECT_LABEL("gp", TOPIC("g"))} END AS lens_label,
                  gi.selection_reason AS signal, GREATEST(gi.associated_at, gi.updated_at) AS activity_at,
                  (SELECT max(c.detected_at) FROM source_goal_item_changes c
                    WHERE c.goal_id = gi.goal_id AND c.source_item_id = gi.source_item_id
                      AND c.delivery_kind = 'evidenced_change' AND c.selection_status <> 'not_selected'
                      AND c.detected_at <= $5::timestamptz) AS change_at,
                  'goal_item'::text AS analysis_kind, gi.id AS analysis_id, b.source_connection_id AS connection_id
             FROM source_goal_items gi
             JOIN source_goals g ON g.id = gi.goal_id AND g.space_id = gi.space_id
             LEFT JOIN projects gp ON gp.id = g.project_id AND gp.space_id = g.space_id
             LEFT JOIN source_goal_bindings b ON b.id = gi.binding_id AND b.space_id = gi.space_id
             JOIN LATERAL (SELECT gi.binding_id, gi.space_id, gi.associated_at AS detected_at) membership ON true
            WHERE g.space_id = $1 AND g.status <> 'deleted'
              AND ((g.project_id IS NULL AND g.owner_user_id = $2) OR g.project_id = ANY($7::varchar[]))
              AND gi.selection_status IN ('important', 'unjudged') AND gi.associated_at <= $5::timestamptz
              AND ${everyReader("$3", (user) => goalCollectionReadableSql("membership", user))}
         ), monitoring AS (
           SELECT d.source_item_id, 'monitoring'::text, ${PROJECT_LABEL("mp", "'monitoring'")}, d.reason,
                  GREATEST(pl.created_at, d.updated_at), NULL::timestamptz, 'decision'::text, d.id, dc.source_connection_id
             FROM source_post_processing_item_decisions d
             JOIN project_information_monitoring_versions v ON v.rule_id = d.rule_id AND v.space_id = d.space_id
             JOIN project_source_item_links pl
               ON pl.source_item_id = d.source_item_id AND pl.space_id = d.space_id AND pl.project_id = v.project_id AND pl.status = 'active'
             JOIN projects mp ON mp.id = v.project_id AND mp.space_id = v.space_id
             LEFT JOIN source_channels dc ON dc.id = d.source_channel_id AND dc.space_id = d.space_id
            WHERE d.space_id = $1 AND v.project_id = ANY($7::varchar[])
              AND d.relevance = 'relevant' AND d.review_status NOT IN ('ignored', 'dismissed')
              AND GREATEST(pl.created_at, d.updated_at) <= $5::timestamptz
         ), corpus AS (
           SELECT COALESCE(pci.source_item_id, pcis.source_item_id), 'corpus'::text, ${PROJECT_LABEL("cp", "'Corpus'")}, pci.reason,
                  pci.created_at, NULL::timestamptz, 'corpus_item'::text, pci.id, pci.source_connection_id
             FROM project_corpus_items pci
             JOIN projects cp ON cp.id = pci.project_id AND cp.space_id = pci.space_id
             LEFT JOIN project_corpus_item_sources pcis ON pcis.corpus_item_id = pci.id AND pcis.space_id = pci.space_id
            WHERE pci.space_id = $1 AND pci.project_id = ANY($7::varchar[]) AND pci.status = 'active'
              AND pci.triage_status <> 'excluded' AND COALESCE(pci.source_item_id, pcis.source_item_id) IS NOT NULL
              AND pci.created_at <= $5::timestamptz
         ), subscription AS (
           SELECT l.source_item_id, 'subscription'::text, left(ch.name, 160), NULL::text,
                  l.matched_at, NULL::timestamptz, 'subscription'::text, l.id, ch.source_connection_id
             FROM source_channel_item_links l
             JOIN source_channels ch ON ch.id = l.source_channel_id AND ch.space_id = l.space_id
             JOIN source_channel_user_subscriptions s
               ON s.source_channel_id = ch.id AND s.space_id = ch.space_id AND s.user_id = $2 AND s.status = 'subscribed'
            WHERE l.space_id = $1 AND l.status = 'active' AND l.matched_at <= $5::timestamptz
         )
         SELECT * FROM (SELECT * FROM following UNION ALL SELECT * FROM monitoring UNION ALL SELECT * FROM corpus UNION ALL SELECT * FROM subscription) rows
          WHERE ${inWindow("rows.activity_at")} OR ${inWindow("rows.change_at")} OR rows.source_item_id = ANY($6::varchar[])
             OR ${contentChangedInWindowSql("rows.source_item_id", "$4", "$5")}`,
        [spaceId, userId, audience, window.since, window.cutoff, window.pinnedItemIds, projects],
      );
      return hydrateCandidates(db, spaceId, audience, signals.rows);
    },

    async context(db: Queryable) {
      // Only what this reader stated: their own personal Following topics.
      const goals = await db.query<{ id: string; title: string; intent: string | null; updated_at: string }>(
        `SELECT g.id, ${TOPIC("g")} AS title, g.intent_json->>'intent' AS intent, g.updated_at::text
           FROM source_goals g
          WHERE g.space_id = $1 AND g.owner_user_id = $2 AND g.project_id IS NULL AND g.status <> 'deleted'
          ORDER BY g.updated_at DESC, g.id LIMIT $3`,
        [spaceId, userId, BRIEFING_LIMITS.maxContextTasks],
      );
      return goals.rows.map((goal): BriefingContextEntry => ({
        kind: "personal_focus",
        label: `Following: ${goal.title}`.slice(0, 200),
        text: (goal.intent && goal.intent !== goal.title ? `${goal.title} — ${goal.intent}` : goal.title).slice(0, 1200),
        source: { type: "goal", id: goal.id, revision: new Date(goal.updated_at).toISOString() },
      }));
    },

    allowedItems: (db, itemIds) => sharedItems(db, spaceId, audience, itemIds),

    async signalState(db: Queryable, signals: BriefingSignalDep[]) {
      if (signals.length === 0) return new Map();
      const projects = await optedProjects(db);
      const ids = (kind: BriefingSignalDep["kind"]) => signals.filter((dep) => dep.kind === kind).map((dep) => dep.id);
      // Permission and current text only. A Project's signals stand only while it is opted in and readable.
      const rows = await db.query<{ kind: BriefingSignalDep["kind"]; id: string; label: string; text: string | null }>(
        `SELECT 'goal_item' AS kind, gi.id,
                CASE WHEN g.project_id IS NULL THEN ${TOPIC("g")} ELSE ${PROJECT_LABEL("gp", TOPIC("g"))} END AS label,
                gi.selection_reason AS text
           FROM source_goal_items gi
           JOIN source_goals g ON g.id = gi.goal_id AND g.space_id = gi.space_id
           LEFT JOIN projects gp ON gp.id = g.project_id AND gp.space_id = g.space_id
           JOIN LATERAL (SELECT gi.binding_id, gi.space_id, gi.associated_at AS detected_at) membership ON true
          WHERE gi.space_id = $1 AND g.status <> 'deleted' AND gi.id = ANY($4::varchar[])
            AND ((g.project_id IS NULL AND g.owner_user_id = $2) OR g.project_id = ANY($8::varchar[]))
            AND ${everyReader("$3", (user) => goalCollectionReadableSql("membership", user))}
         UNION ALL
         SELECT 'decision', d.id, ${PROJECT_LABEL("mp", "'monitoring'")}, d.reason
           FROM source_post_processing_item_decisions d
           JOIN project_information_monitoring_versions v ON v.rule_id = d.rule_id AND v.space_id = d.space_id
           JOIN project_source_item_links pl
             ON pl.source_item_id = d.source_item_id AND pl.space_id = d.space_id AND pl.project_id = v.project_id AND pl.status = 'active'
           JOIN projects mp ON mp.id = v.project_id AND mp.space_id = v.space_id
          WHERE d.space_id = $1 AND d.id = ANY($5::varchar[]) AND v.project_id = ANY($8::varchar[])
         UNION ALL
         SELECT 'corpus_item', pci.id, ${PROJECT_LABEL("cp", "'Corpus'")}, pci.reason
           FROM project_corpus_items pci JOIN projects cp ON cp.id = pci.project_id AND cp.space_id = pci.space_id
          WHERE pci.space_id = $1 AND pci.id = ANY($6::varchar[]) AND pci.project_id = ANY($8::varchar[])
         UNION ALL
         SELECT 'subscription', l.id, left(ch.name, 160), NULL::text
           FROM source_channel_item_links l JOIN source_channels ch ON ch.id = l.source_channel_id AND ch.space_id = l.space_id
          WHERE l.space_id = $1 AND l.id = ANY($7::varchar[])`,
        [spaceId, userId, audience, ids("goal_item"), ids("decision"), ids("corpus_item"), ids("subscription"), projects],
      );
      return new Map(rows.rows.map((row) => [signalKey(row), signalRevision(row.label, row.text?.trim() || null)]));
    },

    async contextState(db: Queryable, sources: BriefingContextEntry["source"][]) {
      const goals = sources.filter((source) => source.type === "goal");
      const allowed = new Set<string>();
      let outdated = false;
      if (goals.length === 0) return { allowed, outdated };
      const rows = await db.query<{ id: string; updated_at: string }>(
        `SELECT id, updated_at::text FROM source_goals
          WHERE space_id = $1 AND owner_user_id = $2 AND project_id IS NULL AND status <> 'deleted' AND id = ANY($3::varchar[])`,
        [spaceId, userId, goals.map((source) => source.id)],
      );
      const current = new Map(rows.rows.map((row) => [row.id, new Date(row.updated_at).toISOString()]));
      for (const source of goals) {
        if (!current.has(source.id)) continue;
        allowed.add(contextSourceKey(source));
        if (current.get(source.id) !== source.revision) outdated = true;
      }
      return { allowed, outdated };
    },
  };
}
