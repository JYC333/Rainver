import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { useTestDatabase } from "./support/testDatabase";
import { ProjectResearchExecutionProfileService } from "../src/modules/projectResearch/executionProfileService";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

// Real-Postgres coverage for the system-managed "Auto Research" agent's
// capabilities_json. It is fixed on the agent's current version at first
// provisioning with no versioned-edit path, so a capability a later stage
// adds (e.g. research.monitor_compare) is missing forever for any space
// whose agent already existed — every run of that stage then fails routing
// with "No runtime candidate passed routing hard filters." resolve() must
// self-heal an existing agent's capabilities in place, not just set them
// correctly for a brand-new one.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROVIDER = "99999999-9999-4999-8999-999999999999";

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

const db = useTestDatabase(__filename);

beforeAll(async () => {
  if (!db.available) return;
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO model_providers (id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at)
     VALUES ($1,$2,$3,'Test Provider','openai','https://example.invalid/v1','test-model',true,'{}'::jsonb,'{}'::jsonb,$4,$4)`,
    [PROVIDER, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO model_provider_space_grants (id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$4,true,true,$5,$5)`,
    [randomUUID(), PROVIDER, SPACE, OWNER, now],
  );
});

describe("ProjectResearchExecutionProfileService managed agent capabilities (real Postgres)", () => {
  it("provisions the full capability set for a new agent and backfills a pre-existing one missing newer capabilities", async () => {
    if (!db.available) return;
    const config = loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      SERVER_INTERNAL_TOKEN: "test-internal-token",
    });
    const service = new ProjectResearchExecutionProfileService(db.pool, config);

    await service.resolve(identity, {});
    const agentRow = await db.pool.query<{ id: string; current_version_id: string }>(
      `SELECT id, current_version_id FROM agents WHERE space_id=$1 AND agent_kind='system_research'`,
      [SPACE],
    );
    expect(agentRow.rows).toHaveLength(1);
    const versionRow = async () => db.pool.query<{ capabilities_json: string[] }>(
      `SELECT capabilities_json FROM agent_versions WHERE id=$1`,
      [agentRow.rows[0]!.current_version_id],
    );
    const freshlyCreated = await versionRow();
    expect(freshlyCreated.rows[0]!.capabilities_json).toEqual(expect.arrayContaining([
      "research.source_collect", "research.source_summarize", "research.evidence_extract",
      "research.brief_synthesize", "research.idea_generate", "research.adhoc_analyze", "research.monitor_compare",
    ]));

    // Simulate a space provisioned before research.adhoc_analyze / research.monitor_compare
    // existed — the historical narrow capability list.
    await db.pool.query(
      `UPDATE agent_versions SET capabilities_json=$2::jsonb WHERE id=$1`,
      [agentRow.rows[0]!.current_version_id, JSON.stringify([
        "research.source_collect", "research.source_summarize", "research.evidence_extract",
        "research.brief_synthesize", "research.idea_generate",
      ])],
    );

    await service.resolve(identity, {});
    const healed = await versionRow();
    expect(healed.rows[0]!.capabilities_json).toEqual(expect.arrayContaining([
      "research.adhoc_analyze", "research.monitor_compare",
    ]));
  });
});
