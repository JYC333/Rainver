import { randomUUID } from "node:crypto";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { AMBIENT_PARSER_VERSION, type AmbientRecord, type AmbientSessionSummary } from "@rainver/protocol";
import { ambientRecordHash } from "./records.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { contentAccessSql } from "../access/contentAccessSql.js";

export interface ImportedSessionRow {
  id: string;
  space_id: string;
  project_id: string;
  project_folder_id: string | null;
  workspace_location_id: string | null;
  execution_host_id: string | null;
  owner_user_id: string;
  adapter_type: string;
  installation: string;
  vendor_session_id: string;
  cwd: string | null;
  title: string | null;
  visibility: string;
  access_level: string;
  source_state: "present" | "gone";
  load_state: "complete" | "partial";
  last_error: string | null;
  record_count: number;
  first_record_at: string | null;
  last_record_at: string | null;
  vendor_updated_at: string | null;
  last_synced_at: string | null;
  last_seen_on_host_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportedSessionRecordRow {
  id: string;
  imported_session_id: string;
  record_key: string;
  content_hash: string;
  conflict_hash: string | null;
  kind: string;
  sequence: number;
  occurred_at: string | null;
  text: string | null;
  tool_name: string | null;
  tool_status: string | null;
  tool_input: string | null;
  tool_output: string | null;
  raw_json: unknown;
  truncated: boolean;
  parser_version: string;
  extracted_in: string | null;
  created_at: string;
}

const SESSION_COLUMNS = `id, space_id, project_id, project_folder_id, workspace_location_id,
  execution_host_id, owner_user_id, adapter_type, installation, vendor_session_id, cwd, title,
  visibility, access_level, source_state, load_state, last_error, record_count, first_record_at,
  last_record_at, vendor_updated_at, last_synced_at, last_seen_on_host_at, created_at, updated_at`;

const RECORD_COLUMNS = `id, imported_session_id, record_key, content_hash, conflict_hash, kind,
  sequence, occurred_at, text, tool_name, tool_status, tool_input, tool_output, raw_json,
  truncated, parser_version, extracted_in, created_at`;

/** What one session's reconciliation changed, for the caller's report. */
export interface ReconcileOutcome {
  session: ImportedSessionRow;
  inserted: number;
  unchanged: number;
  conflicted: number;
}

export class PgImportedSessionRepository {
  constructor(private readonly db: Queryable) {}

  async listForLocation(spaceId: string, locationId: string): Promise<ImportedSessionRow[]> {
    const result = await this.db.query<ImportedSessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM imported_sessions
       WHERE space_id = $1 AND workspace_location_id = $2
       ORDER BY last_record_at DESC NULLS LAST, created_at DESC`,
      [spaceId, locationId],
    );
    return result.rows;
  }

  /**
   * Every imported session in a Project this viewer may read.
   *
   * Filtered by the one canonical content predicate, not by host ownership:
   * importing is the owner's act, but a session shared into the Project is
   * ordinary Project content and a teammate reads it like anything else. A
   * private one stays with its owner by the same predicate.
   */
  async listForProjectAsViewer(
    identity: { spaceId: string; userId: string },
    projectId: string,
  ): Promise<ImportedSessionRow[]> {
    const definition = contentResourceDefinition("imported_session");
    if (!definition) throw new Error("imported_session is not a registered content resource");
    const alias = "s";
    const result = await this.db.query<ImportedSessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM imported_sessions ${alias}
        WHERE ${alias}.space_id = $1
          AND ${alias}.project_id = $2
          AND ${contentAccessSql({ definition, alias, userExpr: "$3" })}
        ORDER BY ${alias}.last_record_at DESC NULLS LAST, ${alias}.created_at DESC`,
      [identity.spaceId, projectId, identity.userId],
    );
    return result.rows;
  }

  async byId(spaceId: string, id: string): Promise<ImportedSessionRow | null> {
    const result = await this.db.query<ImportedSessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM imported_sessions WHERE space_id = $1 AND id = $2`,
      [spaceId, id],
    );
    return result.rows[0] ?? null;
  }

  /**
   * A session's records, capped.
   *
   * The cap is real — a long OpenCode session folds to several hundred
   * records — so the caller is told when it bit rather than being handed a
   * silently short transcript that looks complete.
   */
  /**
   * `end: "tail"` keeps the *last* records rather than the first, still in
   * ascending order. Which end to drop depends on what the caller is for: the
   * transcript page reads from the top, but a continuation picks up where the
   * work stopped, so handing it the beginning of a long session drops exactly
   * the part being continued.
   */
  async records(
    spaceId: string,
    sessionId: string,
    limit = 2_000,
    end: "head" | "tail" = "head",
  ): Promise<{
    records: ImportedSessionRecordRow[];
    truncated: boolean;
  }> {
    const result = await this.db.query<ImportedSessionRecordRow>(
      `SELECT ${RECORD_COLUMNS} FROM imported_session_records
       WHERE space_id = $1 AND imported_session_id = $2
       ORDER BY sequence ${end === "tail" ? "DESC" : "ASC"}
       LIMIT $3`,
      [spaceId, sessionId, limit + 1],
    );
    const kept = result.rows.slice(0, limit);
    return {
      records: end === "tail" ? kept.reverse() : kept,
      truncated: result.rows.length > limit,
    };
  }

  /**
   * Upserts the session row and reconciles its records.
   *
   * Reconciliation is a set operation, never a cursor advance: an ambient
   * source is rewritten on resume, split by compaction, and forked by rewind,
   * so "everything after position N" is wrong the first time the person uses
   * their own CLI normally. A record already held with the same hash is left
   * alone; one that comes back different is *not* overwritten — the first
   * import stays authoritative and the disagreement is recorded, because the
   * imported copy may by then be the only one that still exists.
   */
  /**
   * Named records of one session, in the session's own order — the caller has
   * already decided the viewer may read the session; this fetches only what
   * they named, never a page to filter down.
   */
  async recordsByIds(
    spaceId: string,
    sessionId: string,
    ids: readonly string[],
  ): Promise<Array<Pick<ImportedSessionRecordRow, "id" | "kind" | "text" | "tool_output" | "tool_name">>> {
    const result = await this.db.query<Pick<ImportedSessionRecordRow, "id" | "kind" | "text" | "tool_output" | "tool_name">>(
      `SELECT id, kind, text, tool_output, tool_name
         FROM imported_session_records
        WHERE space_id = $1 AND imported_session_id = $2 AND id = ANY($3::varchar[])
        ORDER BY sequence ASC, id ASC`,
      [spaceId, sessionId, [...ids]],
    );
    return result.rows;
  }

  async reconcile(input: {
    spaceId: string;
    projectId: string;
    projectFolderId: string;
    workspaceLocationId: string;
    executionHostId: string;
    ownerUserId: string;
    adapterType: string;
    installation: string;
    visibility: string;
    session: AmbientSessionSummary;
    loadState: "complete" | "partial";
    error: string | null;
    records: readonly AmbientRecord[];
  }): Promise<ReconcileOutcome> {
    const now = new Date().toISOString();
    const vendorUpdatedAt = isoOrNull(input.session.updated_at);
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM imported_sessions
       WHERE workspace_location_id = $1 AND adapter_type = $2 AND installation = $3 AND vendor_session_id = $4`,
      [input.workspaceLocationId, input.adapterType, input.installation, input.session.session_id],
    );
    if (existing.rows.length === 0) {
      // A session whose Location was unregistered has a null location, and
      // Postgres treats nulls as distinct — so the unique constraint stops
      // constraining and re-binding the same folder would import a second
      // copy of everything. Re-adopt the orphan instead: it is the same
      // session on the same machine, and the person did not ask for two.
      //
      // Exactly one, oldest first. Two orphans can exist (one host directory
      // registered as two Locations in a Project, which nothing prevents for
      // a remote Location since it has no server path to be unique on), and
      // adopting both would point them at the same Location and violate the
      // source-identity constraint on every sync from then on.
      const orphan = await this.db.query<{ id: string }>(
        `UPDATE imported_sessions
            SET workspace_location_id = $1, execution_host_id = $2,
                project_folder_id = COALESCE(project_folder_id, $3), updated_at = now()
          WHERE id = (
            SELECT id FROM imported_sessions
             WHERE space_id = $4 AND project_id = $5 AND workspace_location_id IS NULL
               AND adapter_type = $6 AND installation = $7 AND vendor_session_id = $8
             ORDER BY created_at ASC
             LIMIT 1
          )
          RETURNING id`,
        [
          input.workspaceLocationId, input.executionHostId, input.projectFolderId,
          input.spaceId, input.projectId, input.adapterType, input.installation, input.session.session_id,
        ],
      );
      if (orphan.rows[0]) existing.rows.push(orphan.rows[0]);
    }

    let sessionId = existing.rows[0]?.id ?? null;
    if (sessionId) {
      // Visibility is not re-applied here: it is the person's decision on the
      // session, and a later sync inheriting the Location default would
      // silently re-share something they had made private.
      await this.db.query(
        `UPDATE imported_sessions
            SET title = COALESCE($2, title),
                cwd = COALESCE($3, cwd),
                load_state = $4,
                last_error = $5,
                vendor_updated_at = COALESCE($6, vendor_updated_at),
                source_state = 'present',
                last_seen_on_host_at = $7,
                last_synced_at = $7,
                updated_at = $7
          WHERE id = $1`,
        [sessionId, input.session.title, input.session.cwd, input.loadState, input.error, vendorUpdatedAt, now],
      );
    } else {
      sessionId = randomUUID();
      // `ON CONFLICT` rather than a bare insert: two syncs of the same folder
      // can race (two tabs, or a manual import while a scheduled one runs),
      // and the loser must join the existing row instead of failing the whole
      // import on a unique violation.
      const inserted = await this.db.query<{ id: string }>(
        `INSERT INTO imported_sessions (
           id, space_id, project_id, project_folder_id, workspace_location_id, execution_host_id,
           owner_user_id, adapter_type, installation, vendor_session_id, cwd, title, visibility,
           access_level, source_state, load_state, last_error, record_count, vendor_updated_at,
           last_synced_at, last_seen_on_host_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'full','present',$14,$15,0,$16,$17,$17,$17,$17)
         ON CONFLICT (workspace_location_id, adapter_type, installation, vendor_session_id) DO NOTHING
         RETURNING id`,
        [
          sessionId, input.spaceId, input.projectId, input.projectFolderId, input.workspaceLocationId,
          input.executionHostId, input.ownerUserId, input.adapterType, input.installation,
          input.session.session_id, input.session.cwd, input.session.title, input.visibility,
          input.loadState, input.error, vendorUpdatedAt, now,
        ],
      );
      if (inserted.rows.length === 0) {
        const raced = await this.db.query<{ id: string }>(
          `SELECT id FROM imported_sessions
            WHERE workspace_location_id = $1 AND adapter_type = $2 AND installation = $3 AND vendor_session_id = $4`,
          [input.workspaceLocationId, input.adapterType, input.installation, input.session.session_id],
        );
        const winner = raced.rows[0]?.id;
        if (!winner) {
          // The row that won the race is already gone (a delete between the
          // insert and this read). Retrying inside this transaction would
          // race the same way; the next sync reconciles it cleanly.
          throw new HttpError(409, "That imported session changed while it was being written; try the sync again");
        }
        sessionId = winner;
      }
    }

    const held = await this.db.query<{ record_key: string; content_hash: string }>(
      `SELECT record_key, content_hash FROM imported_session_records WHERE imported_session_id = $1`,
      [sessionId],
    );
    const heldByKey = new Map(held.rows.map((row) => [row.record_key, row.content_hash]));

    let inserted = 0;
    let unchanged = 0;
    let conflicted = 0;
    for (const record of input.records) {
      const hash = ambientRecordHash(record);
      const heldHash = heldByKey.get(record.record_key);
      if (heldHash === hash) {
        unchanged += 1;
        continue;
      }
      if (heldHash !== undefined) {
        const marked = await this.db.query(
          `UPDATE imported_session_records
              SET conflict_hash = $3
            WHERE imported_session_id = $1 AND record_key = $2 AND conflict_hash IS DISTINCT FROM $3`,
          [sessionId, record.record_key, hash],
        );
        if ((marked.rowCount ?? 0) > 0) conflicted += 1;
        continue;
      }
      const written = await this.db.query(
        `INSERT INTO imported_session_records (
           id, space_id, imported_session_id, record_key, content_hash, kind, sequence, occurred_at,
           text, tool_name, tool_status, tool_input, tool_output, raw_json, truncated,
           parser_version, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (imported_session_id, record_key) DO NOTHING`,
        [
          randomUUID(), input.spaceId, sessionId, record.record_key, hash, record.kind, record.sequence,
          isoOrNull(record.occurred_at), record.text, record.tool_name, record.tool_status,
          record.tool_input, record.tool_output, record.raw_json === null ? null : record.raw_json,
          record.truncated, AMBIENT_PARSER_VERSION, now,
        ],
      );
      // A concurrent sync may have written the same record between the read
      // above and this insert; counting the attempt rather than the effect
      // would report work that did not happen.
      if ((written.rowCount ?? 0) > 0) inserted += 1;
      else unchanged += 1;
    }

    // ACP carries no per-record timestamp in any runtime verified so far, so
    // in practice this always falls back to the session's own vendor
    // timestamp — which is why the product shows one instant per session
    // rather than a range. The MIN/MAX is kept because the column exists and a
    // future replay that does carry times should be used when it appears.
    await this.db.query(
      `UPDATE imported_sessions s
          SET record_count = counts.total,
              first_record_at = COALESCE(counts.first_at, s.vendor_updated_at),
              last_record_at = COALESCE(counts.last_at, s.vendor_updated_at),
              updated_at = $2
         FROM (
           SELECT COUNT(*)::int AS total, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at
             FROM imported_session_records WHERE imported_session_id = $1
         ) AS counts
        WHERE s.id = $1`,
      [sessionId, now],
    );

    const refreshed = await this.byId(input.spaceId, sessionId);
    return { session: refreshed!, inserted, unchanged, conflicted };
  }

  /**
   * Marks sessions the host no longer lists as gone.
   *
   * Never deletes: the vendor deletes sessions on its own schedule, and an
   * import that vanished with its source would be an archive that erases
   * itself. `gone` is information for the reader.
   *
   * Only ever called after a *successful* enumeration. An empty list from a
   * runtime that failed to answer would otherwise mark a folder's entire
   * history gone, which is why the failure path in the service returns before
   * reaching this.
   */
  async markMissingAsGone(input: {
    spaceId: string;
    workspaceLocationId: string;
    adapterType: string;
    installation: string;
    /** Exactly what the host enumerated this sync — never what the server holds. */
    listedVendorSessionIds: readonly string[];
  }): Promise<number> {
    const result = await this.db.query(
      `UPDATE imported_sessions
          SET source_state = 'gone', updated_at = now()
        WHERE space_id = $1 AND workspace_location_id = $2 AND adapter_type = $3 AND installation = $4
          AND source_state <> 'gone'
          AND NOT (vendor_session_id = ANY($5::text[]))`,
      [input.spaceId, input.workspaceLocationId, input.adapterType, input.installation, [...input.listedVendorSessionIds]],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Sessions and their vendor timestamps, so a sync can skip what has not
   * moved. Rendered as an explicit UTC ISO string rather than left to the
   * driver: the daemon compares these as instants, and a value whose format
   * depends on the server's session timezone would compare unequal every time
   * and re-replay every session.
   */
  async heldSessions(input: {
    spaceId: string;
    workspaceLocationId: string;
    adapterType: string;
    installation: string;
  }): Promise<Array<{ session_id: string; updated_at: string }>> {
    const result = await this.db.query<{ session_id: string; updated_at: string | null }>(
      `SELECT vendor_session_id AS session_id,
              to_char(vendor_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
         FROM imported_sessions
        WHERE space_id = $1 AND workspace_location_id = $2 AND adapter_type = $3 AND installation = $4
          AND load_state = 'complete' AND vendor_updated_at IS NOT NULL`,
      [input.spaceId, input.workspaceLocationId, input.adapterType, input.installation],
    );
    return result.rows.flatMap((row) => (row.updated_at ? [{ session_id: row.session_id, updated_at: row.updated_at }] : []));
  }

  /** How many sessions this Location already holds for a runtime, to tell a first import from a later one. */
  async countForRuntime(input: {
    spaceId: string;
    workspaceLocationId: string;
    adapterType: string;
    installation: string;
  }): Promise<number> {
    const result = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM imported_sessions
        WHERE space_id = $1 AND workspace_location_id = $2 AND adapter_type = $3 AND installation = $4`,
      [input.spaceId, input.workspaceLocationId, input.adapterType, input.installation],
    );
    return Number(result.rows[0]?.total ?? "0");
  }

  /** Sessions whose last replay did not finish; the next sync retries them regardless of the window. */
  async unfinishedSessionIds(input: {
    spaceId: string;
    workspaceLocationId: string;
    adapterType: string;
    installation: string;
  }): Promise<string[]> {
    const result = await this.db.query<{ vendor_session_id: string }>(
      `SELECT vendor_session_id FROM imported_sessions
        WHERE space_id = $1 AND workspace_location_id = $2 AND adapter_type = $3 AND installation = $4
          AND load_state = 'partial' AND source_state = 'present'`,
      [input.spaceId, input.workspaceLocationId, input.adapterType, input.installation],
    );
    return result.rows.map((row) => row.vendor_session_id);
  }

  async setVisibility(spaceId: string, id: string, visibility: string): Promise<ImportedSessionRow | null> {
    await this.db.query(
      `UPDATE imported_sessions SET visibility = $3, updated_at = now() WHERE space_id = $1 AND id = $2`,
      [spaceId, id, visibility],
    );
    return this.byId(spaceId, id);
  }

  /** Deleting takes the records with it; nothing outside this module owns them. */
  async deleteSessions(spaceId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db.query(
      `DELETE FROM imported_sessions WHERE space_id = $1 AND id = ANY($2::text[])`,
      [spaceId, [...ids]],
    );
    return result.rowCount ?? 0;
  }
}

/**
 * A vendor timestamp is whatever the runtime said; a value that is not a date
 * is dropped rather than stored, so a comparison against it cannot silently
 * skip a session that did change.
 */
function isoOrNull(value: string | null): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
