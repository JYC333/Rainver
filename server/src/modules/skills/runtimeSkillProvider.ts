import type { Queryable } from "../routeUtils/common.js";
import { loadSelectedSkills } from "./selectedSkills.js";

/** Run/Delivery adapter for the single original-package selection path. */
export interface RuntimeSkillRunContext {
  space_id: string;
  run_id: string;
  runtime_key: string | null;
  agent_id: string | null;
  project_id: string | null;
  instructed_by_user_id: string | null;
  viewer_user_id?: string | null;
  session_id: string | null;
  message_id: string | null;
  lock?: boolean;
}

export type RuntimeSkillCandidate = Awaited<ReturnType<typeof loadSelectedSkills>>[number];

export class PgRuntimeSkillProvider {
  constructor(private readonly db: Queryable) {}

  async loadCandidatesForRun(run: RuntimeSkillRunContext): Promise<RuntimeSkillCandidate[]> {
    if (!run.runtime_key) return [];
    return loadSelectedSkills(this.db, {
      space_id: run.space_id, project_id: run.project_id, agent_id: run.agent_id,
      user_id: run.viewer_user_id ?? run.instructed_by_user_id,
      session_id: run.session_id, message_id: run.message_id, lock: run.lock,
    });
  }
}
