import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

/**
 * The rows almost every Project-domain test needs before it can do anything:
 * a Space, its owner, the owner's membership, and one Project. Column lists
 * and literals match what the files used to inline, so assertions on names
 * and types are unchanged; pass the option when a test needs a different one.
 */
export async function seedSpaceOwnerProject(
  pool: Pool,
  input: {
    space: string;
    owner: string;
    project: string;
    spaceName?: string;
    spaceType?: string;
    ownerDisplayName?: string;
    projectName?: string;
    now?: string;
  },
): Promise<{ now: string }> {
  const now = input.now ?? new Date().toISOString();
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`,
    [input.space, input.spaceName ?? "Main", input.spaceType ?? "personal", now],
  );
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$2,'active',$3,$3)`,
    [input.owner, input.ownerDisplayName ?? input.owner, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), input.space, input.owner, now],
  );
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'active',$5,$5)`,
    [input.project, input.space, input.owner, input.projectName ?? "Research", now],
  );
  return { now };
}

/** An active agent with one version bound as current, as research tests need. */
export async function seedAgentWithVersion(
  pool: Pool,
  input: {
    agent: string;
    version: string;
    space: string;
    owner: string;
    name?: string;
    systemPrompt?: string;
    now?: string;
  },
): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  await pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
     VALUES ($1,$2,$3,$4,'active',NULL,$5,$5,'space_shared')`,
    [input.agent, input.space, input.owner, input.name ?? "Research Agent", now],
  );
  await pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1,$2,$3,'v1',$4,'{}','{}','{}','{}','[]','{}','{}',$5)`,
    [input.version, input.agent, input.space, input.systemPrompt ?? "Test research agent.", now],
  );
  await pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [input.agent, input.version]);
}

/** A finished agent Run in the Space, with the agent and version it needs. */
export async function seedRun(
  pool: Pool,
  input: { id: string; space: string; owner: string; agent: string; version: string; now?: string },
): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  await seedAgentWithVersion(pool, { agent: input.agent, version: input.version, space: input.space, owner: input.owner, name: "Run Agent", now });
  await pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, owner_user_id, visibility, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',$5,'space_shared',$6,$6)`,
    [input.id, input.space, input.agent, input.version, input.owner, now],
  );
}

