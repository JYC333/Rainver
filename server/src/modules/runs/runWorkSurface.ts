import type { HostLaunchWorkSurface } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import {
  WORK_SKILL_RELATIVE_PATH,
  renderWorkSkill,
  workSkillContentHash,
  type WorkSkillOptions,
} from "../skills/workSkill.js";
import { assembleRunInputEnvelope } from "./runInputEnvelope.js";
import type { RunRecord } from "./repository.js";
import { PgRunToolIdentityRepository } from "./runToolIdentityRepository.js";

export type RunWorkSurfaceFrame = HostLaunchWorkSurface;

export interface RunWorkSurface {
  frame: RunWorkSurfaceFrame;
  /** Which Skill text this run received, for its execution record. */
  skill_content_hash: string;
  /** The options the Skill was rendered with; the prompt pointer must use the same. */
  options: WorkSkillOptions;
}

/**
 * Which Skill a Run gets, decided from the Run itself: a conversation turn
 * (it has a Session) reads differently from a dispatched Task, and the
 * output-delivery section is offered only when `artifact.submit` was
 * actually granted. Do not render the dispatched default for every remote
 * run. A Room agent would be sent to `artifact.submit` it was not granted
 * and told its reply reached nobody.
 */
export function workSkillOptionsForRun(run: RunRecord): WorkSkillOptions {
  const grants = assembleRunInputEnvelope(run).tool_grants.map(grant => grant.action_id);
  const input = (run.contract_snapshot_json as {
    workflow_input_json?: {
      source_goal?: { goal_id?: string; purpose?: string };
      material_processing?: unknown;
    };
  } | null)?.workflow_input_json;
  const goal = input?.source_goal;
  const sourceCollection = goal?.purpose === 'collect';
  const materialProcessing = sourceCollection || Boolean(input?.material_processing);
  const goalPlanning = !grants.includes('task.report') && Boolean(goal?.goal_id)
    && ['explore', 'repair'].includes(goal?.purpose ?? '')
    && grants.some(action => action.startsWith('source.goal.'));
  return {
    ...(goalPlanning ? { domainActions: grants } : {}),
    ...(materialProcessing ? { materialProcessing: true, sourceCollection, domainActions: grants } : {}),
    ...(grants.includes("agent.delegate") ? { canDelegate: true } : {}),
    conversation: Boolean(run.session_id),
    deliverOutputs: grants.includes('artifact.submit'),
  };
}

const WORK_SURFACE_SKILL_PATH_ENV = "RAINVER_SKILL_PATH";

/**
 * Issues the run's identity and assembles what the host must materialize.
 *
 * The caller renews this short-lived identity while execution remains active
 * and revokes it on completion. `lifetimeSeconds` is a renewable lease, not
 * a limit on how long the Run can execute.
 */
export async function buildRunWorkSurface(input: {
  db: Queryable;
  run: RunRecord;
  hostId: string;
  /** The launch nonce the token is issued for (bound on the attempt later, just before the frame leaves). */
  launchId: string;
  lifetimeSeconds: number;
}): Promise<RunWorkSurface | null> {
  const host = (await input.db.query<{ id: string }>(
    "SELECT id FROM hosts WHERE id = $1 LIMIT 1", [input.hostId],
  )).rows[0];
  if (!host) return null;
  const options = workSkillOptionsForRun(input.run);
  const skill = renderWorkSkill(options);
  const skillContentHash = workSkillContentHash(skill);
  // The hash is written with the identity rather than reported at the end: a
  // Run that crashes still has to be explainable, and the fact being recorded
  // is what it was *given*, which is known now.
  const token = await new PgRunToolIdentityRepository(input.db)
    .issue(input.run, input.lifetimeSeconds * 1000, skillContentHash, input.launchId);
  return {
    frame: {
      run_tool_token: token,
      files: [{ relative_path: WORK_SKILL_RELATIVE_PATH, contents: skill }],
      dir_env: { [WORK_SURFACE_SKILL_PATH_ENV]: WORK_SKILL_RELATIVE_PATH },
    },
    skill_content_hash: skillContentHash,
    options,
  };
}
