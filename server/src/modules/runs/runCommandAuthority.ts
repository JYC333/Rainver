import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { roleMayApproveRisk, VALID_RISK_LEVELS, type RiskLevel } from "../policy/decisions.js";
import type { PgRunRepository } from "./repository.js";
import type { VisibleRunRecord } from "./runRepositoryTypes.js";
import { recordValue } from "./runRepositoryHelpers.js";

export type RunCommand = "execute" | "stop" | "resume" | "abandon" | "finalize";

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
    throw new HttpError(409, `Run is not waiting for review (current status: ${run.status})`);
  }
  const pause = recordValue(run.error_json);
  if (typeof pause.authorization_request_id === "string") {
    const detail = "Authorization-request Runs reconcile automatically after the request is decided.";
    throw new HttpError(409, detail, { detail, authorization_request_id: pause.authorization_request_id });
  }
  if (pause.supervisor_review === true) {
    assertCommandStanding(run, identity, "resume");
    return { run, kind: "supervisor_review" };
  }
  if (typeof pause.risk_level !== "string" || !VALID_RISK_LEVELS.has(pause.risk_level)) {
    throw new HttpError(409, "This pause recorded no risk to approve against; abandon the Run and start it again");
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

function assertCommandStanding(run: VisibleRunRecord, identity: SpaceUserIdentity, command: RunCommand): void {
  if (run.owner_user_id !== identity.userId && run.instructed_by_user_id !== identity.userId) {
    throw new HttpError(403, `Only the Run's owner or the person who started it can ${command} it`);
  }
}
