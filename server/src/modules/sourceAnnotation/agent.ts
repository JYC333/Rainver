import type { Pool } from "../../db/pool.js";
import { PgAgentRepository } from "../agents/repository.js";
import { HttpError } from "../routeUtils/common.js";
import { defaultModelProviderForSpace } from "../sources/postProcessing/service.js";

export const SOURCE_ANNOTATOR_AGENT_KIND = "system_source_annotator";

/**
 * The system-managed agent the annotation pass runs as.
 *
 * A separate agent kind from `system_source_post_processor` rather than a
 * shared one: their system prompts state different jobs, and the annotator's
 * has to keep saying "describe, do not judge" — folding both into one prompt is
 * how the annotator starts returning relevance opinions that then leak into
 * every reader's ranking.
 */
export async function ensureSourceAnnotatorAgent(pool: Pool, spaceId: string): Promise<{ id: string }> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id
       FROM agents
      WHERE space_id = $1
        AND agent_kind = $2
        AND status = 'active'
      ORDER BY created_at ASC
      LIMIT 1`,
    [spaceId, SOURCE_ANNOTATOR_AGENT_KIND],
  );
  if (existing.rows[0]) {
    await refreshSourceAnnotatorAgentPrompt(pool, spaceId, existing.rows[0].id);
    return existing.rows[0];
  }
  const provider = await defaultModelProviderForSpace(pool, spaceId);
  if (!provider) {
    throw new HttpError(409, "Configure a default model provider before running source annotation.");
  }
  const agents = new PgAgentRepository(pool);
  const created = await agents.create({
    spaceId,
    userId: await resolveSystemActorUserId(pool, spaceId),
    name: "Source annotation",
    description: "System-managed agent that classifies incoming source material for the digest pipeline.",
    visibility: "space_shared",
    systemPrompt: sourceAnnotatorSystemPrompt(),
    adapterType: "model_api",
    defaultModelProviderId: provider.id,
    defaultModel: provider.default_model,
  });
  await pool.query(
    `UPDATE agents
        SET owner_user_id = NULL,
            agent_kind = $3,
            updated_at = $4
      WHERE space_id = $1 AND id = $2`,
    [spaceId, created.id, SOURCE_ANNOTATOR_AGENT_KIND, new Date().toISOString()],
  );
  return { id: created.id };
}

export async function refreshSourceAnnotatorAgentPrompt(
  pool: Pool,
  spaceId: string,
  agentId: string,
): Promise<void> {
  const managed = await pool.query<{ agent_kind: string }>(
    `SELECT agent_kind
       FROM agents
      WHERE space_id = $1 AND id = $2 AND status = 'active'
      LIMIT 1`,
    [spaceId, agentId],
  );
  if (managed.rows[0]?.agent_kind !== SOURCE_ANNOTATOR_AGENT_KIND) return;
  await new PgAgentRepository(pool).publishSystemManagedPrompt({
    spaceId,
    agentId,
    agentKind: SOURCE_ANNOTATOR_AGENT_KIND,
    systemPrompt: sourceAnnotatorSystemPrompt(),
  });
}

function sourceAnnotatorSystemPrompt(): string {
  return [
    "You are the system-managed Source annotation agent.",
    "You classify newly captured source material so downstream systems can organize it.",
    "You describe what each item is. You never judge whether it is interesting, important, or relevant.",
    "Your annotations are shared by every reader in the space, so they must not reflect any particular person's taste.",
    "Assign every item exactly one domain from the provided list, even when the fit is imperfect.",
    "Your final response must be exactly one valid JSON object matching schema source_annotation.result.v1.",
    "Do not wrap the JSON in prose or code fences.",
  ].join("\n");
}

/**
 * The user an annotation run is attributed to.
 *
 * The pass has no actor — no one asked for it, and its output is shared by the
 * whole space. `runs.user_id` is non-null, so attribution falls to the space's
 * longest-standing active member, the same resolution the system-managed agents
 * already use for ownership. It is attribution for audit and cost, not a
 * statement that this person requested anything.
 */
export async function resolveSystemActorUserId(pool: Pool, spaceId: string): Promise<string> {
  const membership = await pool.query<{ user_id: string }>(
    `SELECT user_id
       FROM space_memberships
      WHERE space_id = $1 AND status = 'active'
      ORDER BY created_at ASC
      LIMIT 1`,
    [spaceId],
  );
  const userId = membership.rows[0]?.user_id;
  if (userId) return userId;
  const user = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`,
  );
  const fallback = user.rows[0]?.id;
  if (!fallback) throw new HttpError(409, "Cannot create the source annotation agent without an active user");
  return fallback;
}
