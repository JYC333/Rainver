import type { ServerConfig } from "../../config.js";
import { hostControlPlaneUrl } from "../hosts/controlPlaneUrl.js";
import type { Queryable } from "../routeUtils/common.js";
import {
  WORK_SKILL_RELATIVE_PATH,
  renderWorkSkill,
  workSkillContentHash,
  type WorkSkillOptions,
} from "../capabilities/workSkill.js";
import { assembleRunInputEnvelope } from "./runInputEnvelope.js";
import type { RunRecord } from "./repository.js";
import { PgRunToolIdentityRepository } from "./runToolIdentityRepository.js";

/**
 * What a dispatched agent is given so it can act on Rainver's behalf: this
 * run's identity, the address to use it at, and the Skill that says how.
 *
 * Deliberately runtime-agnostic — two environment variables and one file. No
 * branch here or on the host is keyed on which agent is running, which is what
 * makes a newly registered ACP agent work with nothing added: the per-vendor
 * configuration writers this replaces had to be extended once per runtime.
 */
export interface RunWorkSurfaceFrame {
  env: Record<string, string>;
  files: Array<{ relative_path: string; contents: string }>;
  /**
   * Environment whose value is a path inside the run directory the host
   * creates, keyed by variable name. The server cannot name that directory —
   * only the executing machine knows where its own config root is.
   */
  dir_env: Record<string, string>;
}

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
 * actually granted. Rendering the dispatched default for every remote run
 * sent a Room agent to `artifact.submit` it was never granted and told it
 * its reply reached nobody.
 */
export function workSkillOptionsForRun(run: RunRecord): WorkSkillOptions {
  return {
    conversation: Boolean(run.session_id),
    deliverOutputs: assembleRunInputEnvelope(run).tool_grants.some((grant) => grant.action_id === "artifact.submit"),
  };
}

export const WORK_SURFACE_SKILL_PATH_ENV = "RAINVER_SKILL_PATH";

/**
 * The control-plane address *this host* can reach — `RAINVER_API_URL` for the
 * Run's child processes. Configuration only (`hostControlPlaneUrl`): the
 * built-in host's in-network address, or `FRONTEND_URL` (origin and path, so
 * a control plane behind a prefix is not truncated) for a paired host.
 */
export async function resolveHostApiBaseUrl(db: Queryable, config: ServerConfig, hostId: string): Promise<string | null> {
  const row = await db.query<{ kind: string }>(`SELECT kind FROM hosts WHERE id = $1 LIMIT 1`, [hostId]);
  const host = row.rows[0];
  return host ? hostControlPlaneUrl(config, host.kind) : null;
}

/**
 * Issues the run's identity and assembles what the host must materialize.
 *
 * The token's lifetime covers the run's own timeout plus a margin, matching
 * how the server-host path sizes it: an identity that expires while its run is
 * still working takes the agent's tool surface away mid-task.
 */
export async function buildRunWorkSurface(input: {
  db: Queryable;
  config: ServerConfig;
  run: RunRecord;
  hostId: string;
  timeoutSeconds: number;
}): Promise<RunWorkSurface | null> {
  const apiBaseUrl = await resolveHostApiBaseUrl(input.db, input.config, input.hostId);
  if (!apiBaseUrl) return null;
  const options = workSkillOptionsForRun(input.run);
  const skill = renderWorkSkill(options);
  const skillContentHash = workSkillContentHash(skill);
  // The hash is written with the identity rather than reported at the end: a
  // Run that crashes still has to be explainable, and the fact being recorded
  // is what it was *given*, which is known now.
  const token = await new PgRunToolIdentityRepository(input.db)
    .issue(input.run, (input.timeoutSeconds + 300) * 1000, skillContentHash);
  return {
    frame: {
      env: {
        RAINVER_API_URL: apiBaseUrl,
        RAINVER_RUN_ID: input.run.id,
        RAINVER_TOOL_TOKEN: token,
      },
      files: [{ relative_path: WORK_SKILL_RELATIVE_PATH, contents: skill }],
      dir_env: { [WORK_SURFACE_SKILL_PATH_ENV]: WORK_SKILL_RELATIVE_PATH },
    },
    skill_content_hash: skillContentHash,
    options,
  };
}
