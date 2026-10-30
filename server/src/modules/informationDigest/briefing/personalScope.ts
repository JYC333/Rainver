import type { Queryable } from "../../routeUtils/common.js";
import { goalCollectionReadableSql } from "../../sources/goals/itemVisibility.js";
import { contentChangedInWindowSql, everyReader, hydrateCandidates, sharedItems, type CandidateSignal } from "./candidates.js";
import { signalKey, signalRevision, type BriefingScopeAdapter, type BriefingSignalDep, type BriefingWindow } from "./contract.js";

const FOLLOWING_LABEL = `COALESCE(NULLIF(g.compatibility_json->>'display_title',''), g.intent_json->>'intent', 'Following')`;

/**
 * Personal scope: one reader in the current Space only; the result is theirs
 * alone. P1 offers only this reader's own personal Following (topics with no
 * Project) through the shared kernel, to prove the contract with a second
 * audience. Subscriptions, Projects opted into personal reading and the
 * reading surface are P2. No personal context is read yet, and nothing here
 * writes back to the interest profile or Memory.
 */
export function personalBriefingScope(spaceId: string, userId: string): BriefingScopeAdapter {
  const audience = [userId];
  return {
    scope: { type: "personal", spaceId, projectId: null, ownerUserId: userId, key: `personal:${userId}` },
    audience: async () => audience,
    canRead: async (_db, viewer) => viewer === userId,
    canGenerate: async (_db, viewer) => viewer === userId,

    async candidates(db: Queryable, window: BriefingWindow) {
      const signals = await db.query<CandidateSignal>(
        `SELECT * FROM (
           SELECT gi.source_item_id, 'following'::text AS lens_kind, ${FOLLOWING_LABEL} AS lens_label,
                  gi.selection_reason AS signal, GREATEST(gi.associated_at, gi.updated_at) AS activity_at,
                  (SELECT max(c.detected_at) FROM source_goal_item_changes c
                    WHERE c.goal_id = gi.goal_id AND c.source_item_id = gi.source_item_id
                      AND c.delivery_kind = 'evidenced_change' AND c.selection_status <> 'not_selected'
                      AND c.detected_at <= $5::timestamptz) AS change_at,
                  'goal_item'::text AS analysis_kind, gi.id AS analysis_id, b.source_connection_id AS connection_id
             FROM source_goal_items gi
             JOIN source_goals g ON g.id = gi.goal_id AND g.space_id = gi.space_id
             LEFT JOIN source_goal_bindings b ON b.id = gi.binding_id AND b.space_id = gi.space_id
             JOIN LATERAL (SELECT gi.binding_id, gi.space_id, gi.associated_at AS detected_at) membership ON true
            WHERE g.space_id = $1 AND g.project_id IS NULL AND g.owner_user_id = $2 AND g.status <> 'deleted'
              AND gi.selection_status IN ('important', 'unjudged') AND gi.associated_at <= $5::timestamptz
              AND ${everyReader("$3", (user) => goalCollectionReadableSql("membership", user))}
         ) rows
         WHERE (rows.activity_at > $4::timestamptz AND rows.activity_at <= $5::timestamptz)
            OR (rows.change_at > $4::timestamptz AND rows.change_at <= $5::timestamptz)
            OR rows.source_item_id = ANY($6::varchar[])
            OR ${contentChangedInWindowSql("rows.source_item_id", "$4", "$5")}`,
        [spaceId, userId, audience, window.since, window.cutoff, window.pinnedItemIds],
      );
      return hydrateCandidates(db, spaceId, audience, signals.rows);
    },

    context: async () => [],
    allowedItems: (db, itemIds) => sharedItems(db, spaceId, audience, itemIds),
    async signalState(db: Queryable, signals: BriefingSignalDep[]) {
      const ids = signals.filter((dep) => dep.kind === "goal_item").map((dep) => dep.id);
      if (ids.length === 0) return new Map();
      const rows = await db.query<{ id: string; label: string; text: string | null }>(
        `SELECT gi.id, ${FOLLOWING_LABEL} AS label, gi.selection_reason AS text
           FROM source_goal_items gi
           JOIN source_goals g ON g.id = gi.goal_id AND g.space_id = gi.space_id
           JOIN LATERAL (SELECT gi.binding_id, gi.space_id, gi.associated_at AS detected_at) membership ON true
          WHERE gi.space_id = $1 AND g.project_id IS NULL AND g.owner_user_id = $2 AND g.status <> 'deleted'
            AND gi.id = ANY($4::varchar[])
            AND ${everyReader("$3", (user) => goalCollectionReadableSql("membership", user))}`,
        [spaceId, userId, audience, ids],
      );
      return new Map(rows.rows.map((row) => [signalKey({ kind: "goal_item", id: row.id }), signalRevision(row.label, row.text?.trim() || null)]));
    },
    contextState: async () => ({ allowed: new Set<string>(), outdated: false }),
  };
}
