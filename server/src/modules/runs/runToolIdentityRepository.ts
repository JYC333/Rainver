import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import type { RunRecord } from "./repository.js";

/**
 * The bearer identity a dispatched agent uses to call back into Rainver.
 *
 * Durable, unlike the in-process map it replaces: a remote run's CLI keeps
 * running across a server restart, and an identity that lived only in memory
 * came back unrecognized — the agent lost its tool surface mid-run with no way
 * to acquire another. Only the digest is stored, so reading the table cannot
 * recover a live token.
 *
 * The identity authorizes the tool surface of exactly one Run. It is not a
 * credential for any provider and selects no model backend, so it is outside
 * ADR 0008's channel isolation and B67's mutual exclusion — both govern
 * upstream credentials, which this is not.
 */
export interface RunToolIdentity {
  run_id: string;
  space_id: string;
  expires_at: string;
}

export function runToolTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issuing and revoking a Run's identity, as a port.
 *
 * The vendor adapter takes its collaborators by injection — broker, executor,
 * tool registry — and this is one more: a test that is about how the work
 * surface is staged should not have to stand up a database to get a token.
 * The SQL behind it has its own real-Postgres coverage.
 */
export interface RunToolIdentityPort {
  issue(
    run: Pick<RunRecord, "id" | "space_id">,
    ttlMs: number,
    skillContentHash?: string | null,
  ): Promise<string>;
  revoke(runId: string): Promise<void>;
}

export class PgRunToolIdentityRepository implements RunToolIdentityPort {
  constructor(private readonly db: Queryable) {}

  /**
   * Issues this Run's token, replacing any identity a previous attempt left
   * behind. A Supervisor retry re-executes the same run id in a fresh
   * process: the new attempt must get a working token, and the old one must
   * stop working the moment it does.
   */
  async issue(
    run: Pick<RunRecord, "id" | "space_id">,
    ttlMs: number,
    skillContentHash: string | null = null,
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.max(1, ttlMs));
    await this.db.query(
      `INSERT INTO run_tool_identities (run_id, space_id, token_digest, skill_content_hash, expires_at, revoked_at, created_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, NULL, $6::timestamptz)
       ON CONFLICT (run_id) DO UPDATE
         SET token_digest = EXCLUDED.token_digest,
             skill_content_hash = EXCLUDED.skill_content_hash,
             expires_at = EXCLUDED.expires_at,
             revoked_at = NULL,
             created_at = EXCLUDED.created_at`,
      [run.id, run.space_id, runToolTokenDigest(token), skillContentHash, expiresAt.toISOString(), now.toISOString()],
    );
    return token;
  }

  /**
   * The identity this token names, if it is live and belongs to `runId`.
   *
   * The Run id is matched rather than trusted from the token so a token issued
   * for one Run cannot be replayed against another's route.
   */
  async resolve(token: string, runId: string): Promise<RunToolIdentity | null> {
    if (!token) return null;
    const result = await this.db.query<RunToolIdentity>(
      `SELECT run_id, space_id, expires_at
         FROM run_tool_identities
        WHERE token_digest = $1
          AND run_id = $2
          AND revoked_at IS NULL
          AND expires_at > now()`,
      [runToolTokenDigest(token), runId],
    );
    return result.rows[0] ?? null;
  }

  /** Revoked by Run rather than by token: the caller revoking holds the Run. */
  async revoke(runId: string): Promise<void> {
    await this.db.query(
      `UPDATE run_tool_identities
          SET revoked_at = now()
        WHERE run_id = $1 AND revoked_at IS NULL`,
      [runId],
    );
  }
}
