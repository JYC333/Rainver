import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import {
  projectAttentionRegistry,
  type ProjectAttentionAdapter,
  type ProjectAttentionItem,
} from "../projects/attentionRegistry.js";

/**
 * The one thing memory asks a person for (ADR 0003 §2).
 *
 * A session that hit the direct-write circuit breaker stopped writing, and
 * that is a fault to look at, not a queue to approve — so it is `uncertain`,
 * one item per session, and it never carries an Accept. Everything else an
 * Agent remembers is on the Memory page, where it can be corrected after the
 * fact.
 *
 * Derived on demand from the entries themselves: a paused session is a count,
 * and storing a "paused" flag would be a second place for it to be wrong.
 */
let directWritesPerSession = 50;

/** Set from `ServerConfig` at module registration. */
export function registerMemoryProjectIntegration(limit: number): void {
  directWritesPerSession = limit;
  projectAttentionRegistry.replace(memoryAttentionAdapter);
}

interface PausedSessionRow {
  session_id: string;
  in_session: boolean;
  total: string;
  last_at: string;
}

const memoryAttentionAdapter: ProjectAttentionAdapter = {
  areaKind: "memory",
  async listAttentionItems(
    db: Queryable,
    identity: SpaceUserIdentity,
    projectId: string,
  ): Promise<ProjectAttentionItem[]> {
    // Counted the way the breaker counts — space-wide per session, active
    // entries plus pending proposals — and only then attributed to a Project
    // the session actually worked in. Counting per Project instead would let
    // a session split across two Projects trip the breaker and raise no item
    // in either.
    const rows = await db.query<PausedSessionRow>(
      `WITH session_writes AS (
         -- Keyed the way the breaker counts: by session where there is one,
         -- and by Run where there is not. A conversation outside a Room has
         -- no session, and a pause nobody can see is not the fault report
         -- ADR 0003 §2 asks for.
         SELECT COALESCE(p.evidence_json->>'session_id', p.source_id) AS session_id,
                p.evidence_json->>'session_id' IS NOT NULL AS in_session,
                m.id AS memory_id, m.created_at, p.source_id AS run_id
           FROM memory_entries m
           JOIN provenance_links p
             ON p.space_id = m.space_id AND p.target_type = 'memory' AND p.target_id = m.id
            AND p.source_type = 'run'
          WHERE m.space_id = $1 AND m.created_from_proposal_id IS NULL
            AND m.status = 'active'
            -- Only the reader's own entries. A direct write is private to the
            -- person in the turn, so nobody learns from this list that
            -- someone else's session looped.
            AND m.owner_user_id = $3
       ),
       session_proposals AS (
         SELECT COALESCE(r.session_id, r.id) AS session_id,
                r.session_id IS NOT NULL AS in_session,
                pr.created_at
           FROM proposals pr
           JOIN runs r ON r.id = pr.created_by_run_id AND r.space_id = pr.space_id
          WHERE pr.space_id = $1 AND pr.status = 'pending'
            AND pr.proposal_type IN ('memory_create', 'memory_update')
            AND pr.created_by_user_id = $3
       ),
       totals AS (
         SELECT session_id, bool_or(in_session) AS in_session,
                count(*)::int AS total, max(created_at) AS last_at
           FROM (SELECT session_id, in_session, created_at FROM session_writes
                 UNION ALL
                 SELECT session_id, in_session, created_at FROM session_proposals) all_writes
          GROUP BY session_id
       )
       SELECT t.session_id, t.in_session, t.total::text AS total, t.last_at::text AS last_at
         FROM totals t
        WHERE t.total >= $4::int
          AND EXISTS (
            SELECT 1 FROM runs r
             WHERE r.space_id = $1 AND r.project_id = $2
               AND (CASE WHEN t.in_session THEN r.session_id ELSE r.id END) = t.session_id
          )`,
      [identity.spaceId, projectId, identity.userId, directWritesPerSession],
    );
    return rows.rows.map((row): ProjectAttentionItem => ({
      id: `memory_session_paused:${row.session_id}`,
      attention_class: "uncertain",
      project_id: projectId,
      area_kind: "memory",
      source_type: "memory_session",
      source_id: row.session_id,
      severity: "normal",
      title: `${row.in_session ? "A session" : "One turn"} wrote ${row.total} memories and was paused`,
      summary: row.in_session
        ? "Memory writing stopped for that session. Read what it recorded before letting it continue."
        : "Memory writing stopped for that turn. Read what it recorded before letting it continue.",
      reason: "An unusual number of memory writes in one stretch usually means the Agent is looping",
      due_at: null,
      blocking_refs: [],
      action_descriptors: [{ label: "Review what it wrote", href: memoryHref(row) }],
      href: memoryHref(row),
    }));
  },
};

/** The Memory page filtered to what that session — or that one turn — wrote. */
function memoryHref(row: PausedSessionRow): string {
  return row.in_session ? `/memory?session=${row.session_id}` : `/memory?run=${row.session_id}`;
}
