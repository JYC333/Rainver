import type { ServerConfig } from "../../config.js";
import { hostControlPlaneUrl } from "../hosts/controlPlaneUrl.js";
import { normalizeHostCapabilities } from "../hosts/capabilities.js";
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

/**
 * What a dispatched agent is given so it can act on Rainver's behalf: this
 * run's identity, the address to use it at, and the Skill that says how.
 *
 * Deliberately runtime-agnostic — two environment variables and one file. No
 * branch here or on the host is keyed on which agent is running. A newly
 * registered ACP agent works with nothing added. Do not add a per-vendor
 * configuration writer for each runtime.
 */
export interface RunWorkSurfaceFrame {
  env: Record<string, string>;
  files: Array<{ relative_path: string; contents: string; encoding?: "utf8" | "base64"; content_hash?: string }>;
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
 * actually granted. Do not render the dispatched default for every remote
 * run. A Room agent would be sent to `artifact.submit` it was not granted
 * and told its reply reached nobody.
 */
export function workSkillOptionsForRun(run: RunRecord): WorkSkillOptions {
  const grants=assembleRunInputEnvelope(run).tool_grants.map(g=>g.action_id);
  return {
    ...(!grants.includes('task.report') && !!(run.contract_snapshot_json as {workflow_input_json?:{source_goal?:{goal_id?:string;purpose?:string}}}|null)?.workflow_input_json?.source_goal?.goal_id && ['explore','repair'].includes((run.contract_snapshot_json as {workflow_input_json:{source_goal:{purpose:string}}}).workflow_input_json.source_goal.purpose) && grants.some(a=>a.startsWith('source.goal.'))?{domainActions:grants}:{}),
    ...((run.contract_snapshot_json as {workflow_input_json?:{source_goal?:{purpose?:string}}})?.workflow_input_json?.source_goal?.purpose==='collect'||!!(run.contract_snapshot_json as {workflow_input_json?:{material_processing?:unknown}})?.workflow_input_json?.material_processing?{materialProcessing:true,domainActions:grants}:{}),
    conversation: Boolean(run.session_id),
    deliverOutputs: assembleRunInputEnvelope(run).tool_grants.some((grant) => grant.action_id === "artifact.submit"),
  };
}

const WORK_SURFACE_SKILL_PATH_ENV = "RAINVER_SKILL_PATH";

/**
 * The control-plane address *this host* can reach — `RAINVER_API_URL` for the
 * Run's child processes. Configuration only (`hostControlPlaneUrl`): the
 * built-in host's in-network address, or `FRONTEND_URL` (origin and path, so
 * a control plane behind a prefix is not truncated) for a paired host.
 */
export async function resolveHostApiBaseUrl(db: Queryable, config: ServerConfig, hostId: string): Promise<string | null> {
  const host = await workSurfaceHost(db, hostId);
  return host ? hostControlPlaneUrl(config, host.kind) : null;
}

interface WorkSurfaceHost { kind: string; platform: string | null; capabilities_json: unknown }

async function workSurfaceHost(db: Queryable, hostId: string): Promise<WorkSurfaceHost | null> {
  const row = await db.query<WorkSurfaceHost>(
    `SELECT kind, platform, capabilities_json FROM hosts WHERE id = $1 LIMIT 1`,
    [hostId],
  );
  return row.rows[0] ?? null;
}

/**
 * The tool channel this Host can actually serve. `file-v1` keeps the Run
 * bearer in the Host process; a Host that cannot pin the bridge directory
 * (Windows) gets no protocol and so keeps the direct-HTTP path, where the
 * Run bearer — never a provider credential (ADR 0008) — is in the Run's
 * environment as before. Daemons predating the report implemented `file-v1`
 * on Linux only.
 */
export function selectToolBridgeProtocol(host: Pick<WorkSurfaceHost, "platform" | "capabilities_json">): "file-v1" | null {
  const advertised = normalizeHostCapabilities(host.capabilities_json).tool_bridge_protocols;
  if (advertised) return advertised.includes("file-v1") ? "file-v1" : null;
  return host.platform === "linux" ? "file-v1" : null;
}

/**
 * Issues the run's identity and assembles what the host must materialize.
 *
 * The caller renews this short-lived identity while execution remains active
 * and revokes it on completion. `lifetimeSeconds` is a renewable lease, not
 * a limit on how long the Run can execute.
 */
export async function buildRunWorkSurface(input: {
  db: Queryable;
  config: ServerConfig;
  run: RunRecord;
  hostId: string;
  lifetimeSeconds: number;
}): Promise<RunWorkSurface | null> {
  const host = await workSurfaceHost(input.db, input.hostId);
  if (!host) return null;
  const apiBaseUrl = hostControlPlaneUrl(input.config, host.kind);
  const bridgeProtocol = selectToolBridgeProtocol(host);
  const options = workSkillOptionsForRun(input.run);
  const skill = renderWorkSkill(options);
  const skillContentHash = workSkillContentHash(skill);
  // The hash is written with the identity rather than reported at the end: a
  // Run that crashes still has to be explainable, and the fact being recorded
  // is what it was *given*, which is known now.
  const token = await new PgRunToolIdentityRepository(input.db)
    .issue(input.run, input.lifetimeSeconds * 1000, skillContentHash);
  return {
    frame: {
      env: {
        ...(bridgeProtocol ? { RAINVER_TOOL_BRIDGE_PROTOCOL: bridgeProtocol } : {}),
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
