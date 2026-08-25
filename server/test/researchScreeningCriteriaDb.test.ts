import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectResearchRepository } from "../src/modules/projectResearch/repository";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";

/**
 * R4/D12. Two screening columns were academic in a pipeline that is not:
 *
 * - `venues_json` named only the academic half of "where material may come
 *   from" — journals, outlets and sites are one concept, now
 *   `source_restrictions_json`.
 * - `methods_json` was a paper-shaped criterion every domain had to carry. It
 *   is now one key in `domain_criteria_json`, and which keys are legal comes
 *   from the extraction profiles the Project's sources are bound with.
 *
 * The bag is the interesting half: an unconstrained one would just be free-form
 * JSON nobody can validate, which is the opposite mistake from a fixed column.
 */

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let projectId = "";

const db = useTestDatabase(__filename, { max: 2 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["project_source_bindings", "project_research_screening_criteria", "projects", "source_channels", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
  projectId = randomUUID();
  await db.pool.query(
    `INSERT INTO projects (id,space_id,name,status,owner_user_id,created_at,updated_at)
     VALUES ($1,$2,'Study','active',$3,$4,$4)`,
    [projectId, SPACE, USER, now],
  );
});

const identity = { spaceId: SPACE, userId: USER };

/** A binding needs a real channel; the chain is channel -> connection ->
 * source_provider_connectors -> source_connectors. */
async function seedChannel(): Promise<string> {
  const connectorId = randomUUID();
  const providerId = randomUUID();
  const providerConnectorId = randomUUID();
  const connectionId = randomUUID();
  const channelId = randomUUID();
  await db.pool.query(
    `INSERT INTO source_connectors (id, connector_key, display_name, connector_type, ingestion_mode, status, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, 'Test', 'external_url', 'pull', 'active', '{}'::jsonb, now(), now())`,
    [connectorId, `test_${connectorId.slice(0, 8)}`],
  );
  await db.pool.query(
    `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, 'Test', 'named', 'test', 'active', '{}'::jsonb, now(), now())`,
    [providerId, `test_${providerId.slice(0, 8)}`],
  );
  await db.pool.query(
    `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, $3, 'active', '{}'::jsonb, now(), now())`,
    [providerConnectorId, providerId, connectorId],
  );
  await db.pool.query(
    `INSERT INTO source_connections (id, space_id, provider_connector_id, owner_user_id, name, status, capture_policy, trust_level, consent_json, policy_json, config_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Test', 'active', 'reference_only', 'trusted', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now())`,
    [connectionId, SPACE, providerConnectorId, USER],
  );
  await db.pool.query(
    `INSERT INTO source_channels (id, space_id, source_connection_id, created_by_user_id, name, channel_type, status, fetch_frequency, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Test channel', 'search', 'active', 'daily', now(), now())`,
    [channelId, SPACE, connectionId, USER],
  );
  return channelId;
}

/** A binding is what says which extraction profile this Project screens with. */
async function bindProfile(profileKey: string): Promise<void> {
  const channelId = await seedChannel();
  await db.pool.query(
    `INSERT INTO project_source_bindings (
       id, space_id, project_id, source_channel_id, binding_key, status, priority,
       delivery_scope, collection_notifications_enabled, filters_json, routing_policy_json,
       extraction_policy_json, created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'test','active',0,'project_members',true,'{}'::jsonb,'{}'::jsonb,$5::jsonb,$6,now(),now())`,
    [randomUUID(), SPACE, projectId, channelId, JSON.stringify({ profile_key: profileKey }), USER],
  );
}

describe("research screening criteria (real Postgres)", () => {
  it("keeps the generic criteria generic and stores source restrictions", async () => {
    if (!db.available) return;
    const repository = new ProjectResearchRepository(db.pool);

    const saved = await repository.upsertScreeningCriteria(identity, projectId, {
      include_keywords: ["latency"],
      exclude_keywords: ["survey"],
      source_restrictions: ["arxiv.org", "The Economist"],
      required_evidence_fields: ["excerpt"],
    }) as Record<string, unknown>;

    // Journals, outlets and sites go in the same list — that is the point.
    expect(saved.source_restrictions).toEqual(["arxiv.org", "The Economist"]);
    expect(saved.include_keywords).toEqual(["latency"]);
    expect(saved.domain_criteria).toEqual({});
    expect(saved.available_domain_criteria).toEqual([]);
  });

  it("pushes saved criteria into existing automated screening rules", async () => {
    if (!db.available) return;
    const channelId = await seedChannel();
    const agentId = randomUUID();
    const ruleId = randomUUID();
    await db.pool.query(
      `INSERT INTO agents (
         id, space_id, owner_user_id, name, status, agent_kind, visibility,
         access_level, created_at, updated_at
       ) VALUES ($1,$2,$3,'Research screener','active','standard','private','full',now(),now())`,
      [agentId, SPACE, USER],
    );
    await db.pool.query(
      `INSERT INTO source_post_processing_rules (
         id, space_id, source_channel_id, agent_id, project_id, name, status,
         trigger_type, trigger_config_json, input_config_json, actions_json,
         created_by_user_id, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,'Automated screening','active','items_materialized',
         '{}'::jsonb,$6::jsonb,$7::jsonb,$8,now(),now()
       )`,
      [
        ruleId,
        SPACE,
        channelId,
        agentId,
        projectId,
        JSON.stringify({ relevance_profile: { enabled: true, objective: "Find useful work" } }),
        JSON.stringify({ mark_items: true }),
        USER,
      ],
    );

    await new ProjectResearchRepository(db.pool).upsertScreeningCriteria(identity, projectId, {
      include_keywords: ["latency"],
      exclude_keywords: ["survey"],
      source_restrictions: ["arxiv.org"],
    });

    const rule = await db.pool.query<{ input_config_json: { relevance_profile?: { project_criteria?: unknown } } }>(
      `SELECT input_config_json FROM source_post_processing_rules WHERE id = $1`,
      [ruleId],
    );
    expect(rule.rows[0]?.input_config_json.relevance_profile?.project_criteria).toEqual({
      include_keywords: ["latency"],
      exclude_keywords: ["survey"],
      domain_criteria: {},
      date_range_start: null,
      date_range_end: null,
      source_restrictions: ["arxiv.org"],
      required_evidence_fields: [],
    });
  });

  it("accepts a domain criterion the Project's bound profile declares", async () => {
    if (!db.available) return;
    await bindProfile("academic_paper_v1");
    const repository = new ProjectResearchRepository(db.pool);

    const saved = await repository.upsertScreeningCriteria(identity, projectId, {
      domain_criteria: { methods: ["randomized", "observational"] },
    }) as Record<string, unknown>;

    expect(saved.domain_criteria).toEqual({ methods: ["randomized", "observational"] });
    expect(saved.available_domain_criteria).toEqual(["methods"]);
  });

  it("refuses a criterion no bound profile declares, and names what is legal", async () => {
    if (!db.available) return;
    await bindProfile("academic_paper_v1");
    const repository = new ProjectResearchRepository(db.pool);

    // Accepting and ignoring it would look identical to working.
    await expect(repository.upsertScreeningCriteria(identity, projectId, {
      domain_criteria: { sample_size: ["large"] },
    })).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining("methods") });
  });

  it("refuses any domain criterion when no bound source declares one", async () => {
    if (!db.available) return;
    // `generic_document_v1` establishes the object and declares no domain axis,
    // so a Project screening only web material has none to screen on.
    await bindProfile("generic_document_v1");
    const repository = new ProjectResearchRepository(db.pool);

    await expect(repository.upsertScreeningCriteria(identity, projectId, {
      domain_criteria: { methods: ["randomized"] },
    })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("leaves the generic criteria writable with no binding at all", async () => {
    if (!db.available) return;
    const repository = new ProjectResearchRepository(db.pool);

    const saved = await repository.upsertScreeningCriteria(identity, projectId, {
      include_keywords: ["batching"],
      date_range_start: "2026-01-01T00:00:00.000Z",
      date_range_end: "2026-06-01T00:00:00.000Z",
    }) as Record<string, unknown>;

    expect(saved.include_keywords).toEqual(["batching"]);
    expect(saved.domain_criteria).toEqual({});
  });
});
