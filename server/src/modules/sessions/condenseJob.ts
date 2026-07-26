import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import type { JobHandlerRegistry } from "../jobs/handlerRegistry";
import { PgJobQueueRepository } from "../jobs/repository";
import { resolveProviderCommandStore } from "../providers/commands/store";
import { completeProviderText } from "../providers/invocation/invocation";
import { PgSessionRepository, type SessionSummarizer } from "./repository";
import type { CondenserPromptConfig } from "./condenser";

/**
 * Background `session_condense` job.
 *
 * Runs the LLM (`llm.v1`) session condenser off the chat request path — chat
 * responses must not block on a second model call. The condenser falls back to
 * the deterministic `pattern.v1` when no provider is configured for the
 * `session_condense` task or the model call fails, so the job never hard-fails
 * for lack of a provider. The scenario profile and optional prompt overrides
 * come from the agent's `context_policy_json.condenser` (default `adaptive`).
 */
export function registerSessionCondenseHandler(
  registry: JobHandlerRegistry,
  config: ServerConfig,
): void {
  if (!config.databaseUrl) return;
  const db = getDbPool(config.databaseUrl);
  const repo = new PgSessionRepository(db);
  const store = resolveProviderCommandStore(config);

  registry.register("session_condense", async (job) => {
    const spaceId = stringValue(job.payload.space_id) ?? job.space_id;
    const userId = stringValue(job.payload.user_id) ?? job.user_id;
    const sessionId = stringValue(job.payload.session_id);
    if (!spaceId) throw new Error("session_condense job payload is missing space_id");
    if (!userId) throw new Error("session_condense job payload is missing user_id");
    if (!sessionId) throw new Error("session_condense job payload is missing session_id");

    const agentVersionId = stringValue(job.payload.agent_version_id);
    const condenser = await resolveCondenserConfig(db, agentVersionId);

    const summarize: SessionSummarizer = async (prompt) => {
      const completion = await completeProviderText(store, spaceId, {
        provider_id: "",
        model: null,
        system: prompt.system,
        user: prompt.user,
        task: "session_condense",
        metering: { subject_user_id: userId },
      });
      return completion.text;
    };

    const summary = await repo.condenseSession(spaceId, userId, sessionId, {
      condenser,
      summarize,
    });
    return {
      session_id: sessionId,
      condensed: summary !== null,
      condenser_version: summary?.condenser_version ?? null,
      version: summary?.version ?? null,
    };
  });
}

export async function enqueueSessionCondense(
  config: ServerConfig,
  input: {
    space_id: string;
    user_id: string;
    session_id: string;
    source_run_id: string;
    agent_id?: string | null;
    agent_version_id?: string | null;
  },
): Promise<void> {
  if (!config.databaseUrl) {
    throw new Error("enqueueSessionCondense requires SERVER_DATABASE_URL");
  }
  const queue = new PgJobQueueRepository(getDbPool(config.databaseUrl));
  await queue.enqueue({
    job_type: "session_condense",
    space_id: input.space_id,
    user_id: input.user_id,
    agent_id: input.agent_id ?? null,
    payload: {
      space_id: input.space_id,
      user_id: input.user_id,
      session_id: input.session_id,
      source_run_id: input.source_run_id,
      agent_version_id: input.agent_version_id ?? null,
    },
  });
}

async function resolveCondenserConfig(
  db: { query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }> },
  agentVersionId: string | null,
): Promise<CondenserPromptConfig | null> {
  if (!agentVersionId) return null;
  const result = await db.query<{ context_policy_json: unknown }>(
    `SELECT context_policy_json FROM agent_versions WHERE id = $1`,
    [agentVersionId],
  );
  const policy = result.rows[0]?.context_policy_json;
  if (!policy || typeof policy !== "object") return null;
  const condenser = (policy as Record<string, unknown>).condenser;
  if (!condenser || typeof condenser !== "object") return null;
  const raw = condenser as Record<string, unknown>;
  const config: CondenserPromptConfig = {};
  const profile = stringValue(raw.profile);
  if (profile) config.profile = profile;
  return Object.keys(config).length > 0 ? config : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
