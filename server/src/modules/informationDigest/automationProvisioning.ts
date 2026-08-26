import type { Queryable } from "../routeUtils/common.js";
import { withQueryableTransaction } from "../routeUtils/common.js";
import { PgAutomationRepository } from "../automations/repository.js";

interface DigestScope {
  space_id: string;
  owner_user_id: string;
  project_id: string | null;
  agent_id: string;
}

/**
 * Provisions the hidden native target for eligible scopes.
 *
 * Users never pick `information_digest` from the generic Automation target
 * list. A subscribed reader and every active Project receive one default daily
 * schedule as soon as a scheduler sweep sees them. Existing schedules are
 * left untouched, so later user-owned cadence/timezone controls do not get
 * reset by reconciliation.
 */
export async function reconcileInformationDigestAutomations(db: Queryable): Promise<number> {
  const scopes = await eligibleScopes(db);
  let created = 0;
  for (const scope of scopes) {
    const operations = scope.project_id ? ["daily"] as const : ["daily", "probe"] as const;
    for (const operation of operations) {
      const inserted = await withQueryableTransaction(db, async (tx) => {
        const scopeType = scope.project_id ? "project" : "personal";
        const scopeKey = scope.project_id ?? scope.owner_user_id;
        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `information-digest-automation:${scope.space_id}:${scopeType}:${scopeKey}:${operation}`,
        ]);
        const existing = await tx.query<{ id: string; agent_id: string }>(
          `SELECT id, agent_id FROM automations
          WHERE space_id = $1 AND status <> 'archived'
            AND config_json->>'target_type' = 'information_digest'
            AND config_json->>'scope' = $2
            AND COALESCE(config_json->>'operation','daily') = $4
            AND (($2 = 'personal' AND owner_user_id = $3)
              OR ($2 = 'project' AND project_id = $3))
          LIMIT 1`,
        [scope.space_id, scopeType, scopeKey, operation],
      );
        if (existing.rows[0]) {
          // Older reconciliation could bind a native digest to the managed
          // Personal Assistant when no annotator existed yet. That Assistant
          // is Room-only, so repair the attribution binding instead of letting
          // every schedule fail before an Automation Run can be created.
          if (existing.rows[0].agent_id !== scope.agent_id) {
            await tx.query(
              `UPDATE automations
                  SET agent_id = $1::uuid,
                      preflight_snapshot_json = jsonb_set(
                        COALESCE(preflight_snapshot_json, '{}'::jsonb),
                        '{information_digest_preflight,attribution_agent_id}',
                        to_jsonb(($1::uuid)::text), true
                      ),
                      updated_at = $2
                WHERE id = $3 AND space_id = $4`,
              [scope.agent_id, new Date().toISOString(), existing.rows[0].id, scope.space_id],
            );
          }
          return false;
        }
        const configJson = {
          target_type: "information_digest",
          scope: scopeType,
          operation,
          ...(scope.project_id ? { project_id: scope.project_id } : {}),
          cron: operation === "probe" ? "0 6 * * 1" : "0 7 * * *",
          timezone: "UTC",
        };
        await new PgAutomationRepository(tx).create({
          spaceId: scope.space_id,
          ownerUserId: scope.owner_user_id,
          agentId: scope.agent_id,
          projectId: scope.project_id,
          name: operation === "probe" ? "Personal weekly discovery" : scope.project_id ? "Project daily digest" : "Personal daily digest",
          description: operation === "probe" ? "System-managed bounded serendipity standby-pool probe." : "System-managed cross-source Library digest.",
          triggerType: "schedule",
          configJson,
          preflightSnapshot: {
            executable: true,
            target_type: "information_digest",
            information_digest_preflight: {
              executable: true,
              scope: scopeType,
              operation,
              project_id: scope.project_id,
              attribution_agent_id: scope.agent_id,
              deterministic_ranking: true,
              errors: [],
            },
          },
        });
        return true;
      });
      if (inserted) created += 1;
    }
  }
  return created;
}

async function eligibleScopes(db: Queryable): Promise<DigestScope[]> {
  const result = await db.query<DigestScope>(
    `WITH eligible_spaces AS (
       SELECT s.id AS space_id,
              (SELECT a.id FROM agents a
                WHERE a.space_id = s.id AND a.status = 'active' AND a.current_version_id IS NOT NULL
                  AND a.agent_kind <> 'system_assistant'
                ORDER BY (a.agent_kind = 'system_source_annotator') DESC, a.created_at ASC LIMIT 1) AS agent_id
         FROM spaces s
     ), personal AS (
       SELECT DISTINCT sub.space_id, sub.user_id AS owner_user_id,
              NULL::varchar AS project_id, es.agent_id
         FROM source_channel_user_subscriptions sub
         JOIN space_memberships sm
           ON sm.space_id = sub.space_id AND sm.user_id = sub.user_id AND sm.status = 'active'
         JOIN eligible_spaces es ON es.space_id = sub.space_id AND es.agent_id IS NOT NULL
        WHERE sub.status = 'subscribed' AND sub.digest_enabled = true AND sm.role <> 'guest'
     ), project_scopes AS (
       SELECT p.space_id, p.owner_user_id, p.id AS project_id, es.agent_id
         FROM projects p
         JOIN eligible_spaces es ON es.space_id = p.space_id AND es.agent_id IS NOT NULL
        WHERE p.deleted_at IS NULL AND p.status = 'active' AND p.owner_user_id IS NOT NULL
     )
     SELECT space_id, owner_user_id, project_id, agent_id FROM personal
     UNION ALL
     SELECT space_id, owner_user_id, project_id, agent_id FROM project_scopes`,
  );
  return result.rows;
}
