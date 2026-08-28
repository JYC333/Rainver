import type { Queryable } from "../routeUtils/common.js";
import {
  WORK_SKILL_RELATIVE_PATH,
  renderWorkSkill,
  workSkillContentHash,
} from "../capabilities/workSkill.js";
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
}

export const WORK_SURFACE_SKILL_PATH_ENV = "RAINVER_SKILL_PATH";

/**
 * The control-plane address *this host* can reach.
 *
 * The server's own hostname is a Compose service name no paired machine can
 * resolve, so it cannot guess this; the daemon reports the address it
 * registered through and that is the one its child process must use. Without
 * it the surface is not offered at all rather than handed out pointing
 * somewhere unreachable — an agent that cannot call back should be told by an
 * absent command, not by a connection error mid-run.
 */
export async function resolveHostApiBaseUrl(db: Queryable, hostId: string): Promise<string | null> {
  const row = await db.query<{ daemon_server_url: string | null }>(
    `SELECT daemon_server_url FROM hosts WHERE id = $1 LIMIT 1`,
    [hostId],
  );
  const reported = row.rows[0]?.daemon_server_url?.trim();
  if (!reported) return null;
  try {
    // Origin *and* path: a control plane behind a reverse proxy can be
    // registered at a prefix, and the daemon itself appends its own paths to
    // the whole reported URL. Dropping the prefix would point the CLI at a URL
    // that answers with the web app's HTML instead of the tool surface.
    const url = new URL(reported);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
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
  run: RunRecord;
  hostId: string;
  timeoutSeconds: number;
}): Promise<RunWorkSurface | null> {
  const apiBaseUrl = await resolveHostApiBaseUrl(input.db, input.hostId);
  if (!apiBaseUrl) return null;
  const skill = renderWorkSkill();
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
  };
}
