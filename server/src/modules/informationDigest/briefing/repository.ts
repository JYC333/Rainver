import { randomUUID } from "node:crypto";
import type { BriefingCoverage, BriefingKind, BriefingOutcome, BriefingStatus } from "@rainver/protocol";
import type { Queryable } from "../../routeUtils/common.js";
import type { BriefingScope } from "./contract.js";
import type { BriefingManifest, PreviousInput } from "./manifest.js";

export interface BriefingRow {
  id: string;
  space_id: string;
  scope_type: "project" | "personal";
  project_id: string | null;
  owner_user_id: string | null;
  scope_key: string;
  kind: BriefingKind;
  version: number;
  period_date: string | null;
  digest_id: string | null;
  cutoff_at: string;
  since_at: string | null;
  comparison: "baseline" | "delta";
  previous_briefing_id: string | null;
  protocol_version: string;
  input_hash: string;
  context_hash: string;
  request_key: string;
  request_hash: string | null;
  status: BriefingStatus;
  outcome: BriefingOutcome | null;
  attempt: number;
  run_id: string | null;
  requested_by_user_id: string;
  agent_id: string | null;
  runtime_profile_id: string | null;
  context_json: Array<{ key: string; kind: string; label: string; text: string; source: { type: string; id: string; revision: string } }>;
  /** Comparison texts with their dependency closures (see `authorization.ts`). */
  comparison_json: unknown[];
  /** A reserved day's deferred request. */
  request_json: BriefingDeferredRequest | null;
  coverage_json: BriefingCoverage;
  result_json: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  checked_at: string | null;
}

export interface BriefingDeferredRequest {
  origin: "manual" | "job";
  automation_id: string | null;
  label: string;
  agent_id: string | null;
  runtime_profile_id: string | null;
}

export interface BriefingInputRow {
  ref_key: string | null;
  ref_kind: "source_item" | "context";
  source_item_id: string | null;
  family_key: string | null;
  content_revision: string | null;
  status: string;
  delta_class: string | null;
  analysis_json: { item_ids?: string[]; unverified?: boolean; source_domain?: string | null; lenses?: Array<{ kind: string; label: string }>; deps?: unknown; [key: string]: unknown };
}

const COLUMNS = `id, space_id, scope_type, project_id, owner_user_id, scope_key, kind, version, period_date, digest_id,
  cutoff_at::text, since_at::text, comparison, previous_briefing_id, protocol_version, input_hash, context_hash, request_key, request_hash,
  status, outcome, attempt, run_id, requested_by_user_id, agent_id, runtime_profile_id, context_json, comparison_json, request_json, coverage_json,
  result_json, error_code, error_message, created_at::text, updated_at::text, completed_at::text, checked_at::text`;

/** Storage of briefing versions and their frozen inputs; no policy here. */
export class PgBriefingRepository {
  constructor(private readonly db: Queryable) {}

  /** Serializes every version decision of one scope (creation, retry, ordering). */
  async lockScope(scope: BriefingScope): Promise<void> {
    await this.db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`information-briefing:${scope.spaceId}:${scope.key}`]);
  }

  async get(spaceId: string, id: string, forUpdate = false): Promise<BriefingRow | null> {
    const result = await this.db.query<BriefingRow>(
      `SELECT ${COLUMNS} FROM information_briefings WHERE space_id = $1 AND id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [spaceId, id],
    );
    return result.rows[0] ?? null;
  }

  async findInFlight(scope: BriefingScope): Promise<BriefingRow | null> {
    const result = await this.db.query<BriefingRow>(
      `SELECT ${COLUMNS} FROM information_briefings WHERE space_id = $1 AND scope_key = $2 AND status = 'queued'`,
      [scope.spaceId, scope.key],
    );
    return result.rows[0] ?? null;
  }

  async findByRequestKey(scope: BriefingScope, requestKey: string): Promise<BriefingRow | null> {
    const result = await this.db.query<BriefingRow>(
      `SELECT ${COLUMNS} FROM information_briefings WHERE space_id = $1 AND scope_key = $2 AND request_key = $3`,
      [scope.spaceId, scope.key, requestKey],
    );
    return result.rows[0] ?? null;
  }

  /** The live version of a sealed day (queued, ready or blocked), if any. */
  async findLiveDay(scope: BriefingScope, date: string): Promise<BriefingRow | null> {
    const result = await this.db.query<BriefingRow>(
      `SELECT ${COLUMNS} FROM information_briefings
        WHERE space_id = $1 AND scope_key = $2 AND period_date = $3 AND kind IN ('daily','backfill')
          AND status IN ('queued','ready','blocked')`,
      [scope.spaceId, scope.key, date],
    );
    return result.rows[0] ?? null;
  }

  /** The latest cutoff of a version that is or will be part of the chain (ready or being generated). */
  async latestChainCutoff(scope: BriefingScope, exceptId: string | null = null): Promise<string | null> {
    const result = await this.db.query<{ cutoff: string | null }>(
      `SELECT max(cutoff_at)::text AS cutoff FROM information_briefings
        WHERE space_id = $1 AND scope_key = $2 AND status IN ('ready','queued') AND ($3::varchar IS NULL OR id <> $3::varchar)`,
      [scope.spaceId, scope.key, exceptId],
    );
    return result.rows[0]?.cutoff ?? null;
  }

  /**
   * The version the next one compares with: the latest version with a
   * published briefing at or before the cutoff. "Nothing new" checks are not
   * part of the chain, so repeating one never moves what is compared.
   */
  async latestPublished(scope: BriefingScope, cutoff: string | null = null): Promise<BriefingRow | null> {
    const result = await this.db.query<BriefingRow>(
      `SELECT ${COLUMNS} FROM information_briefings
        WHERE space_id = $1 AND scope_key = $2 AND status = 'ready' AND outcome = 'briefing'
          AND ($3::timestamptz IS NULL OR cutoff_at <= $3::timestamptz)
        ORDER BY cutoff_at DESC, version DESC LIMIT 1`,
      [scope.spaceId, scope.key, cutoff],
    );
    return result.rows[0] ?? null;
  }

  async previousInputs(briefingId: string): Promise<PreviousInput[]> {
    const result = await this.db.query<{ ref_key: string | null; source_item_id: string | null; family_key: string | null; content_revision: string | null; status: string; item_ids: string[] | null }>(
      `SELECT ref_key, source_item_id, family_key, content_revision, status,
              ARRAY(SELECT jsonb_array_elements_text(COALESCE(analysis_json->'item_ids', '[]'::jsonb))) AS item_ids
         FROM information_briefing_inputs WHERE briefing_id = $1 AND ref_kind = 'source_item'`,
      [briefingId],
    );
    return result.rows.map((row) => ({ ...row, item_ids: row.item_ids?.length ? row.item_ids : row.source_item_id ? [row.source_item_id] : [] }));
  }

  /**
   * Material this scope recorded as still to be briefed (`statuses`: not
   * ready, truncated, refused, not shared) and not resolved since, up to
   * `cutoff`. An item counts by its latest state in a settled (`ready`)
   * version — whatever its cutoff, so a later publication never erases an
   * item still unresolved:
   * - an attempt that admitted it (`included`) but failed, was cancelled or
   *   is still running has not processed it;
   * - a published version that sent it (`included`) resolved it;
   * - a version that carried it and found it no longer a member of the scope
   *   (`adapter.scopeMembers`) recorded it withdrawn
   *   (`analysis_json.withdrawn`), which resolves it. An item the audience
   *   only cannot read now stays a member, and stays pending.
   * Oldest first, `limit` ids, with how many more remain: what a version
   * carries and leaves pending again is re-recorded with a newer state and
   * goes to the back, so a backlog larger than one carry is worked through
   * in turn, never dropped. Ids only — the next version re-offers them
   * through the scope's own gates, which re-authorize each.
   */
  async pendingSince(
    scope: BriefingScope,
    cutoff: string,
    statuses: readonly string[],
    limit: number,
  ): Promise<{ itemIds: string[]; overflow: number }> {
    const result = await this.db.query<{ item_id: string; total: number }>(
      `WITH recorded AS (
         SELECT DISTINCT ON (member.item_id) member.item_id, input.status, input.analysis_json->>'withdrawn' = 'true' AS withdrawn,
                briefing.cutoff_at, briefing.version
           FROM information_briefing_inputs input
           JOIN information_briefings briefing ON briefing.id = input.briefing_id AND briefing.space_id = input.space_id
           CROSS JOIN LATERAL (
             SELECT jsonb_array_elements_text(input.analysis_json->'item_ids') AS item_id
              WHERE jsonb_typeof(input.analysis_json->'item_ids') = 'array' AND jsonb_array_length(input.analysis_json->'item_ids') > 0
             UNION ALL
             SELECT input.source_item_id
              WHERE input.source_item_id IS NOT NULL
                AND (jsonb_typeof(input.analysis_json->'item_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(input.analysis_json->'item_ids') = 0)
           ) member
          WHERE briefing.space_id = $1 AND briefing.scope_key = $2 AND briefing.status = 'ready' AND input.ref_kind = 'source_item'
            AND briefing.cutoff_at <= $3::timestamptz
          ORDER BY member.item_id, briefing.cutoff_at DESC, briefing.version DESC, input.status = 'included' DESC
       )
       SELECT item_id, count(*) OVER ()::int AS total FROM recorded
        WHERE status = ANY($4::varchar[]) AND withdrawn IS NOT TRUE
        ORDER BY cutoff_at ASC, version ASC, item_id
        LIMIT $5`,
      [scope.spaceId, scope.key, cutoff, [...statuses], limit],
    );
    const total = result.rows[0]?.total ?? 0;
    return { itemIds: result.rows.map((row) => row.item_id), overflow: Math.max(0, total - result.rows.length) };
  }

  /** Every reading family a published version of this scope already briefed, with its latest briefed revision. */
  async knownFamilies(scope: BriefingScope, cutoff: string): Promise<Map<string, string | null>> {
    const known = await this.db.query<{ family_key: string; content_revision: string | null }>(
      `SELECT DISTINCT ON (input.family_key) input.family_key, input.content_revision
         FROM information_briefing_inputs input
         JOIN information_briefings briefing ON briefing.id = input.briefing_id AND briefing.space_id = input.space_id
        WHERE briefing.space_id = $1 AND briefing.scope_key = $2 AND briefing.status = 'ready' AND briefing.outcome = 'briefing'
          AND briefing.cutoff_at <= $3::timestamptz AND input.status = 'included' AND input.family_key IS NOT NULL
        ORDER BY input.family_key, briefing.cutoff_at DESC, briefing.version DESC`,
      [scope.spaceId, scope.key, cutoff],
    );
    return new Map(known.rows.map((entry) => [entry.family_key, entry.content_revision]));
  }

  /** Bookkeeping: a later request found this version still current. Not an input of anything. */
  async touchChecked(spaceId: string, id: string): Promise<void> {
    await this.db.query(`UPDATE information_briefings SET checked_at = now() WHERE space_id = $1 AND id = $2`, [spaceId, id]);
  }

  /** Model Runs this scope started in the last day, from the Runs themselves. */
  async runsInLastDay(scope: BriefingScope): Promise<number> {
    const result = await this.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM runs
        WHERE space_id = $1 AND created_at > now() - interval '1 day'
          AND contract_snapshot_json->'workflow_input_json'->'information_briefing'->>'scope_key' = $2`,
      [scope.spaceId, scope.key],
    );
    return result.rows[0]?.count ?? 0;
  }

  async insert(input: {
    scope: BriefingScope;
    kind: BriefingKind;
    periodDate: string | null;
    digestId: string | null;
    manifest: BriefingManifest;
    previousId: string | null;
    protocolVersion: string;
    requestKey: string;
    /** Hash of the exact request a queued version froze; null when no Run is needed. */
    requestHash?: string | null;
    status: BriefingStatus;
    outcome: BriefingOutcome | null;
    requestedByUserId: string;
    agentId: string | null;
    runtimeProfileId: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const { scope, manifest } = input;
    await this.db.query(
      `INSERT INTO information_briefings (
         id, space_id, scope_type, project_id, owner_user_id, scope_key, kind, version, period_date, digest_id,
         cutoff_at, since_at, comparison, previous_briefing_id, protocol_version, input_hash, context_hash, request_key,
         status, outcome, attempt, run_id, requested_by_user_id, agent_id, runtime_profile_id,
         context_json, coverage_json, result_json, error_code, error_message, created_at, updated_at, completed_at, request_hash, comparison_json)
       VALUES ($1,$2::varchar,$3,$4,$5,$6::varchar,$7,
         (SELECT COALESCE(max(version), 0) + 1 FROM information_briefings WHERE space_id = $2::varchar AND scope_key = $6::varchar),
         $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::varchar,$19,0,NULL,$20,$21,$22,$23::jsonb,$24::jsonb,NULL,$25,$26,$27::timestamptz,$27::timestamptz,
         CASE WHEN $18::varchar IN ('ready','failed','blocked') THEN $27::timestamptz END, $28, $29::jsonb)`,
      [
        id, scope.spaceId, scope.type, scope.projectId, scope.ownerUserId, scope.key, input.kind,
        input.periodDate, input.digestId, manifest.cutoff, manifest.since, manifest.comparison, input.previousId,
        input.protocolVersion, manifest.input_hash, manifest.context_hash, input.requestKey, input.status, input.outcome,
        input.requestedByUserId, input.agentId, input.runtimeProfileId,
        JSON.stringify(manifest.context.map(({ key, kind, label, text, source }) => ({ key, kind, label, text, source }))),
        JSON.stringify(manifest.coverage), input.errorCode ?? null, input.errorMessage ?? null, now, input.requestHash ?? null,
        JSON.stringify(manifest.comparison_entries),
      ],
    );
    for (const row of manifest.inputs) {
      await this.db.query(
        `INSERT INTO information_briefing_inputs
           (id, space_id, briefing_id, ref_key, ref_kind, source_item_id, family_key, content_revision, status, delta_class, analysis_json, activity_at, created_at)
         VALUES ($1,$2,$3,$4,'source_item',$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
        [
          randomUUID(), scope.spaceId, id, row.ref_key, row.lead?.source_item_id ?? row.item_ids[0], row.family_key,
          row.revision, row.status, row.delta_class,
          JSON.stringify({
            item_ids: row.item_ids,
            ...(row.withdrawn ? { withdrawn: true } : {}),
            unverified: row.unverified,
            source_domain: row.lead?.source_domain ?? null,
            lenses: row.lenses,
            deps: row.deps,
          }),
          row.activity_at, now,
        ],
      );
    }
    for (const entry of manifest.context) {
      await this.db.query(
        `INSERT INTO information_briefing_inputs
           (id, space_id, briefing_id, ref_key, ref_kind, source_item_id, status, analysis_json, created_at)
         VALUES ($1,$2,$3,$4,'context',NULL,'included',$5::jsonb,$6)`,
        [randomUUID(), scope.spaceId, id, entry.key, JSON.stringify({ kind: entry.kind, source: entry.source }), now],
      );
    }
    return id;
  }

  /**
   * A sealed day that could not start now, with its reason and the request to
   * start it with later (no inputs, no Run). It holds the day: replayed in
   * date order, never displaced by a later day.
   */
  async insertBlocked(
    scope: BriefingScope, kind: BriefingKind, day: { date: string; digestId: string | null; cutoff: string },
    userId: string, code: string, message: string, request: BriefingDeferredRequest,
  ): Promise<string> {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO information_briefings (
         id, space_id, scope_type, project_id, owner_user_id, scope_key, kind, version, period_date, digest_id,
         cutoff_at, comparison, protocol_version, input_hash, context_hash, request_key, status, attempt,
         requested_by_user_id, agent_id, runtime_profile_id, coverage_json, error_code, error_message, request_json,
         created_at, updated_at, completed_at)
       VALUES ($1,$2::varchar,$3,$4,$5,$6::varchar,$7,
         (SELECT COALESCE(max(version), 0) + 1 FROM information_briefings WHERE space_id = $2::varchar AND scope_key = $6::varchar),
         $8,$9,$10,'delta',$11,'','',$12,'blocked',0,$13,$16,$17,'{}'::jsonb,$14,$15,$18::jsonb,now(),now(),now())`,
      [id, scope.spaceId, scope.type, scope.projectId, scope.ownerUserId, scope.key, kind, day.date, day.digestId, day.cutoff,
        "information_briefing.v1", `blocked:${day.date}:${id}`, userId, code, message.slice(0, 2000),
        request.agent_id, request.runtime_profile_id, JSON.stringify(request)],
    );
    return id;
  }

  /** Why a held day still cannot start, after another try. */
  async updateBlocked(spaceId: string, id: string, code: string, message: string): Promise<void> {
    await this.db.query(
      `UPDATE information_briefings SET error_code = $3, error_message = $4, updated_at = now()
        WHERE space_id = $1 AND id = $2 AND status = 'blocked'`,
      [spaceId, id, code.slice(0, 64), message.slice(0, 2000)],
    );
  }

  /** The earliest held sealed day of the scope (optionally only days before `before`). */
  async oldestPendingDay(scope: BriefingScope, before: string | null = null): Promise<BriefingRow | null> {
    const result = await this.db.query<BriefingRow>(
      `SELECT ${COLUMNS} FROM information_briefings
        WHERE space_id = $1 AND scope_key = $2 AND status = 'blocked' AND kind IN ('daily','backfill')
          AND request_json IS NOT NULL AND ($3::varchar IS NULL OR period_date < $3::varchar)
        ORDER BY period_date, version LIMIT 1`,
      [scope.spaceId, scope.key, before],
    );
    return result.rows[0] ?? null;
  }

  /** The latest cutoff of a sealed-day version that is or will be part of the chain. */
  async latestDayCutoff(scope: BriefingScope): Promise<string | null> {
    const result = await this.db.query<{ cutoff: string | null }>(
      `SELECT max(cutoff_at)::text AS cutoff FROM information_briefings
        WHERE space_id = $1 AND scope_key = $2 AND status IN ('ready','queued') AND kind IN ('daily','backfill')`,
      [scope.spaceId, scope.key],
    );
    return result.rows[0]?.cutoff ?? null;
  }

  async removeBlocked(spaceId: string, id: string): Promise<void> {
    await this.db.query(`DELETE FROM information_briefings WHERE space_id = $1 AND id = $2 AND status = 'blocked'`, [spaceId, id]);
  }

  /**
   * Starts an attempt: the version takes this Run as its current attempt. CAS on the
   * expected attempt and a startable status, so two requests cannot both start one.
   */
  async startAttempt(spaceId: string, id: string, expectedAttempt: number, runId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE information_briefings
          SET status = 'queued', attempt = attempt + 1, run_id = $4, error_code = NULL, error_message = NULL,
              completed_at = NULL, updated_at = now()
        WHERE space_id = $1 AND id = $2 AND attempt = $3 AND status IN ('queued','failed','cancelled','blocked')
          AND (status <> 'queued' OR run_id IS NULL)`,
      [spaceId, id, expectedAttempt, runId],
    );
    return result.rowCount === 1;
  }

  async inputs(briefingId: string): Promise<BriefingInputRow[]> {
    const result = await this.db.query<BriefingInputRow>(
      `SELECT ref_key, ref_kind, source_item_id, family_key, content_revision, status, delta_class, analysis_json
         FROM information_briefing_inputs WHERE briefing_id = $1 ORDER BY ref_kind DESC, ref_key NULLS LAST, family_key`,
      [briefingId],
    );
    return result.rows;
  }

  /** Settles the current attempt only: the Run must still be the version's attempt and the version still in flight. */
  async settle(spaceId: string, id: string, runId: string, outcome: {
    status: "ready" | "failed" | "cancelled";
    result?: Record<string, unknown>;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE information_briefings
          SET status = $4::varchar, outcome = CASE WHEN $4::varchar = 'ready' THEN 'briefing' END, result_json = $5::jsonb,
              error_code = $6, error_message = $7, completed_at = now(), updated_at = now()
        WHERE space_id = $1 AND id = $2 AND run_id = $3 AND status = 'queued'`,
      [spaceId, id, runId, outcome.status, outcome.result ? JSON.stringify(outcome.result) : null,
        outcome.errorCode ?? null, outcome.errorMessage?.slice(0, 2000) ?? null],
    );
    return result.rowCount === 1;
  }

  async history(scope: BriefingScope, limit: number): Promise<BriefingRow[]> {
    const result = await this.db.query<BriefingRow>(
      `SELECT ${COLUMNS} FROM information_briefings WHERE space_id = $1 AND scope_key = $2
        ORDER BY version DESC LIMIT $3`,
      [scope.spaceId, scope.key, limit],
    );
    return result.rows;
  }
}
