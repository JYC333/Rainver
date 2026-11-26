import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import type { RunRecord } from "./repository.js";

/**
 * The bearer identity the Host uses for a dispatched Run's tool requests.
 *
 * Durable. A remote run's CLI keeps running across a server restart. Do not
 * keep the identity only in memory: after a restart the callback comes back
 * unrecognized and the agent loses its tool surface mid-run. Only the digest is stored, so reading the table cannot
 * recover a live token.
 *
 * The identity authorizes the tool surface of exactly one Run. It is not a
 * credential for any provider and selects no model backend, so it is outside
 * ADR 0008's channel isolation and B67's mutual exclusion — both govern
 * upstream credentials, which this is not.
 */
interface RunToolIdentity {
  run_id: string;
  space_id: string;
  expires_at: string;
  /**
   * The launch this token was issued for, stored with the token in the same statement (`issue`). It is the
   * caller's launch for the request's whole life, whichever launch the Run's attempt names meanwhile: a relaunch
   * issues a new token for its own launch (revoking this one), and launch-bound work compares it with the Run's
   * current launch (ADR 0034). A token without a launch never resolves.
   */
  launch_id: string;
}

function runToolTokenDigest(token: string): string {
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
interface RunToolIdentityPort {
  issue(
    run: Pick<RunRecord, "id" | "space_id">,
    ttlMs: number,
    skillContentHash?: string | null,
    launchId?: string,
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
   *
   * `launchId` is the launch nonce the token is for, generated before the token so that both are written
   * together: there is no moment at which the new token exists without its launch, or resolves to the launch
   * the attempt still names from before (the nonce is bound on the attempt only after this, just before the
   * frame leaves). Without one the token gets a fresh nonce no attempt is bound to: it serves ordinary tools,
   * and launch-bound work refuses it.
   */
  async issue(
    run: Pick<RunRecord, "id" | "space_id">,
    ttlMs: number,
    skillContentHash: string | null = null,
    launchId: string = randomUUID(),
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.max(1, ttlMs));
    await this.db.query(
      `INSERT INTO run_tool_identities (run_id, space_id, token_digest, skill_content_hash, launch_id, expires_at, revoked_at, created_at)
       VALUES ($1, $2, $3, $4, $7, $5::timestamptz, NULL, $6::timestamptz)
       ON CONFLICT (run_id) DO UPDATE
         SET token_digest = EXCLUDED.token_digest,
             skill_content_hash = EXCLUDED.skill_content_hash,
             launch_id = EXCLUDED.launch_id,
             expires_at = EXCLUDED.expires_at,
             revoked_at = NULL,
             created_at = EXCLUDED.created_at`,
      [run.id, run.space_id, runToolTokenDigest(token), skillContentHash, expiresAt.toISOString(), now.toISOString(), launchId],
    );
    return token;
  }

  /**
   * The identity this token names, if it is live and belongs to `runId`.
   *
   * The Run id is matched rather than trusted from the token so a token issued
   * for one Run cannot be replayed against another's route. The launch is the
   * one stored with the token, never read from the Run's attempt.
   */
  async resolve(token: string, runId: string): Promise<RunToolIdentity | null> {
    if (!token) return null;
    const result = await this.db.query<RunToolIdentity>(
      `SELECT i.run_id, i.space_id, i.expires_at, i.launch_id
         FROM run_tool_identities i
        WHERE i.token_digest = $1
          AND i.run_id = $2
          AND i.launch_id IS NOT NULL
          AND i.revoked_at IS NULL
          AND i.expires_at > now()`,
      [runToolTokenDigest(token), runId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The content hash of the Work Skill this Run's latest attempt was given,
   * or null when it was never dispatched with a work surface.
   *
   * This column is the one source a provenance read uses. The Host adapter's
   * result metadata carries a copy of the same value, but it is not a second
   * identity to read from. The row outlives revocation, so a finished Run
   * still names its Skill. A retry re-issues the identity, so this answers
   * for the latest attempt. The caller has already authorized the Run read;
   * the Space is matched as well, so a Run id cannot be read in the wrong
   * Space. The token digest is never selected.
   */
  async workSkillContentHash(spaceId: string, runId: string): Promise<string | null> {
    const result = await this.db.query<{ skill_content_hash: string | null }>(
      `SELECT skill_content_hash
         FROM run_tool_identities
        WHERE run_id = $1 AND space_id = $2`,
      [runId, spaceId],
    );
    return result.rows[0]?.skill_content_hash ?? null;
  }

  /** Extend only this live attempt's identity; never revive a revoked token. */
  async renew(runId: string, token: string, ttlMs: number): Promise<void> {
    await this.db.query(
      `UPDATE run_tool_identities SET expires_at = $3::timestamptz
        WHERE run_id = $1 AND token_digest = $2
          AND revoked_at IS NULL AND expires_at > now()`,
      [runId, runToolTokenDigest(token), new Date(Date.now() + ttlMs).toISOString()],
    );
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
