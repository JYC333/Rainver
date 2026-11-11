import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { roleMayApproveRisk, VALID_RISK_LEVELS, type RiskLevel } from "../policy/decisions.js";
import type { PgRunRepository } from "./repository.js";
import type { VisibleRunRecord } from "./runRepositoryTypes.js";
import { recordValue } from "./runRepositoryHelpers.js";

type RunCommand = "execute" | "stop" | "resume" | "abandon" | "finalize" | "steer";

type RunReader = Pick<PgRunRepository, "getVisibleRun">;

/**
 * The one rule for a command on a Run: the Run is visible to the caller, and
 * the caller is its owner or the person who instructed it. Seeing a Run in a
 * shared Project is not standing to start, stop or settle it.
 */
export async function authorizeRunCommand(
  runs: RunReader,
  identity: SpaceUserIdentity,
  runId: string,
  command: RunCommand,
): Promise<VisibleRunRecord> {
  const run = await runs.getVisibleRun(identity.spaceId, identity.userId, runId);
  if (!run) throw new HttpError(404, "Run not found in this space");
  assertCommandStanding(run, identity, command);
  return run;
}

/**
 * Whether this resume may happen, and which kind it is. Only a paused Run
 * resumes, and an authorization-request pause is settled by its request, not
 * here. A supervisor-review pause is the Run's own to continue, under the
 * command rule. A policy-gate pause grants that gate's approval, and an
 * approval is decided by approval authority over the risk the gate recorded —
 * the same table that applies proposals — not by owning the Run.
 */
export async function authorizeRunResume(
  db: Queryable,
  runs: RunReader,
  identity: SpaceUserIdentity,
  runId: string,
): Promise<{ run: VisibleRunRecord; kind: "supervisor_review" | "approval" }> {
  const run = await runs.getVisibleRun(identity.spaceId, identity.userId, runId);
  if (!run) throw new HttpError(404, "Run not found in this space");
  if (run.status !== "waiting_for_review") {
    throw new RunCommandRefusal(`Run is not waiting for review (current status: ${run.status})`);
  }
  const pause = recordValue(run.error_json);
  if (typeof pause.authorization_request_id === "string") {
    const detail = "Authorization-request Runs reconcile automatically after the request is decided.";
    throw new RunCommandRefusal(detail, 409, { detail, authorization_request_id: pause.authorization_request_id });
  }
  if (pause.supervisor_review === true) {
    assertCommandStanding(run, identity, "resume");
    return { run, kind: "supervisor_review" };
  }
  if (typeof pause.risk_level !== "string" || !VALID_RISK_LEVELS.has(pause.risk_level)) {
    throw new RunCommandRefusal("This pause recorded no risk to approve against; abandon the Run and start it again");
  }
  const risk = pause.risk_level as RiskLevel;
  const membership = await db.query<{ role: string }>(
    `SELECT role FROM space_memberships
      WHERE space_id = $1 AND user_id = $2 AND status = 'active'
      LIMIT 1`,
    [identity.spaceId, identity.userId],
  );
  if (!roleMayApproveRisk(membership.rows[0]?.role ?? null, risk)) {
    throw new HttpError(403, `Approving this Run needs approval authority for ${risk}-risk actions`);
  }
  return { run, kind: "approval" };
}

/**
 * Whether this person could give a resume that already happened, judged now:
 * the receipt of a supervisor-review resume needs the Run command standing; that
 * of an approval needs approval authority for the risk the grant recorded
 * (critical when an older grant recorded none).
 */
export async function mayHoldRunResume(
  db: Queryable,
  run: VisibleRunRecord,
  identity: SpaceUserIdentity,
  kind: "new_attempt" | "same_attempt" | undefined,
): Promise<boolean> {
  if (kind !== "same_attempt") return run.owner_user_id === identity.userId || run.instructed_by_user_id === identity.userId;
  const grant = await db.query<{ role: string | null; risk_level: string | null }>(
    `SELECT (SELECT role FROM space_memberships WHERE space_id = $1 AND user_id = $3 AND status = 'active' LIMIT 1) AS role,
            (SELECT grants.entry->>'risk_level'
               FROM runs, jsonb_array_elements(COALESCE(runs.permission_snapshot_json->'policy_grants', '[]'::jsonb))
                    WITH ORDINALITY AS grants(entry, position)
              WHERE runs.space_id = $1 AND runs.id = $2 AND grants.entry->>'granted_by_user_id' = $3
              ORDER BY grants.position DESC LIMIT 1) AS risk_level`,
    [identity.spaceId, run.id, identity.userId],
  );
  const row = grant.rows[0];
  const risk = row?.risk_level && VALID_RISK_LEVELS.has(row.risk_level) ? row.risk_level as RiskLevel : "critical";
  return roleMayApproveRisk(row?.role ?? null, risk);
}

function assertCommandStanding(run: VisibleRunRecord, identity: SpaceUserIdentity, command: RunCommand): void {
  if (run.owner_user_id !== identity.userId && run.instructed_by_user_id !== identity.userId) {
    throw new HttpError(403, `Only the Run's owner or the person who started it can ${command} it`);
  }
}

/** A deterministic refusal of a Run command written for the person (wrong state, stale status). */
export class RunCommandRefusal extends HttpError {
  constructor(message: string, statusCode: 409 | 422 = 409, body?: unknown) { super(statusCode, message, body); this.name = "RunCommandRefusal"; }
}
