import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { loadConfig } from "../src/config";
import { PgActivityConsolidationRepository } from "../src/modules/activity/consolidationRepository";
import { PgArtifactRepository } from "../src/modules/artifacts/repository";
import { PgProposalRepository } from "../src/modules/proposals/repository";
import { RunMaterializationService } from "../src/modules/runs/materializationService";
import { PgRunRepository } from "../src/modules/runs/repository";
import {
  getTestPostgres,
  isTestPostgresUnavailableError,
  type TestPostgresDatabase,
} from "./support/sharedPostgres";

const SPACE_ID = "content-derivation-space";
const OWNER_ID = "content-derivation-owner";
const MEMBER_ID = "content-derivation-member";
const OTHER_MEMBER_ID = "content-derivation-other";
const AGENT_ID = "content-derivation-agent";
const AGENT_VERSION_ID = "content-derivation-version";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri() });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(
      `[content-derivation-visibility] skipped — Docker/Postgres unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  const now = new Date().toISOString();
  await pool.query("TRUNCATE spaces, users CASCADE");
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Owner', 'active', $4, $4),
            ($2, 'Member', 'active', $4, $4),
            ($3, 'Other member', 'active', $4, $4)`,
    [OWNER_ID, MEMBER_ID, OTHER_MEMBER_ID, now],
  );
  await pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, oversight_mode, created_at, updated_at)
     VALUES ($1, 'Content Derivation', 'team', $2, 'full', $3, $3)`,
    [SPACE_ID, OWNER_ID, now],
  );
  await pool.query(
    `INSERT INTO space_memberships
       (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $4, $5, 'owner', 'active', $8, $8),
            ($2, $4, $6, 'member', 'active', $8, $8),
            ($3, $4, $7, 'member', 'active', $8, $8)`,
    [randomUUID(), randomUUID(), randomUUID(), SPACE_ID, OWNER_ID, MEMBER_ID, OTHER_MEMBER_ID, now],
  );
  await pool.query(
    `INSERT INTO agents
       (id, space_id, owner_user_id, name, status, current_version_id,
        created_at, updated_at, visibility)
     VALUES ($1, $2, $3, 'Derivation Agent', 'active', NULL, $4, $4, 'space_shared')`,
    [AGENT_ID, SPACE_ID, OWNER_ID, now],
  );
  await pool.query(
    `INSERT INTO agent_versions
       (id, agent_id, space_id, version_label, system_prompt,
        model_config_json, runtime_config_json, context_policy_json,
        memory_policy_json, capabilities_json, tool_permissions_json,
        runtime_policy_json, created_at)
     VALUES ($1, $2, $3, 'v1', 'Test', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
             '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
    [AGENT_VERSION_ID, AGENT_ID, SPACE_ID, now],
  );
  await pool.query("UPDATE agents SET current_version_id = $2 WHERE id = $1", [AGENT_ID, AGENT_VERSION_ID]);
});

describe("derived content visibility against real PostgreSQL", () => {
  it("keeps artifacts and proposals from a private Run unreadable to another Space member", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const run = await new PgRunRepository(pool).createQueuedRun({
      agent_id: AGENT_ID,
      space_id: SPACE_ID,
      user_id: OWNER_ID,
      mode: "live",
      run_type: "agent",
      trigger_origin: "manual",
      prompt: "Produce private output",
      visibility: "private",
    });
    const config = loadConfig({
      SERVER_DATABASE_URL: database!.getConnectionUri(),
      ARTIFACT_STORAGE_ROOT: "/tmp/agent-space-content-derivation-artifacts",
    });
    const materialized = await new RunMaterializationService(
      config,
      pool,
      undefined,
      async () => ({ status: "allow" }),
    ).materializeAdapterResult({
      run,
      adapterResult: {
        adapter_type: "model_api",
        adapter_kind: "managed_api",
        success: true,
        output_text: "",
        output_json: {
          artifacts: [{ title: "Private report", content: "private", visibility: "space_shared" }],
          proposed_changes: [{
            proposal_type: "memory_create",
            title: "Private learning",
            visibility: "private",
            payload_json: { proposed_content: "private" },
          }],
        },
        exit_code: 0,
      },
    });

    expect(materialized.errors).toEqual([]);
    const artifactId = materialized.items.find((item) => item.kind === "artifact")?.artifact_id;
    const proposalId = materialized.items.find((item) => item.kind === "proposal")?.proposal_id;
    expect(artifactId).toBeTruthy();
    expect(proposalId).toBeTruthy();

    const artifactRepository = new PgArtifactRepository(pool, config);
    const proposalRepository = new PgProposalRepository(pool);
    await expect(artifactRepository.getVisible(SPACE_ID, OWNER_ID, artifactId!)).resolves.not.toBeNull();
    await expect(proposalRepository.getVisible(SPACE_ID, OWNER_ID, proposalId!)).resolves.not.toBeNull();
    await expect(artifactRepository.getVisible(SPACE_ID, MEMBER_ID, artifactId!)).resolves.toBeNull();
    await expect(proposalRepository.getVisible(SPACE_ID, MEMBER_ID, proposalId!)).resolves.toBeNull();

    const stored = await pool.query<{ artifact_visibility: string; proposal_visibility: string }>(
      `SELECT a.visibility AS artifact_visibility, p.visibility AS proposal_visibility
         FROM artifacts a CROSS JOIN proposals p
        WHERE a.id = $1 AND p.id = $2`,
      [artifactId, proposalId],
    );
    expect(stored.rows[0]).toEqual({ artifact_visibility: "private", proposal_visibility: "private" });
  });

  it("gives a consolidated proposal the source activity visibility", async (ctx) => {
    if (!available || !pool) return ctx.skip();
    const activityId = randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO activity_records
         (id, space_id, user_id, owner_user_id, activity_type, title, content,
          payload_json, occurred_at, created_at, updated_at, status, source_trust,
          visibility, access_level)
       VALUES ($1, $2, $3, $3, 'user_capture', 'Private capture', 'private thought',
               '{}'::jsonb, $4, $4, $4, 'raw', 'user_confirmed', 'private', 'full')`,
      [activityId, SPACE_ID, OWNER_ID, now],
    );

    const result = await new PgActivityConsolidationRepository(pool).runPending({
      spaceId: SPACE_ID,
      actingUserId: OWNER_ID,
      batchLimit: 10,
      activityIds: [activityId],
    });
    expect(result.proposals_created).toHaveLength(1);
    const proposal = await pool.query<{ visibility: string; proposed_content: string }>(
      `SELECT visibility, payload_json->>'proposed_content' AS proposed_content
         FROM proposals WHERE id = $1`,
      [(result.proposals_created as string[])[0]],
    );
    expect(proposal.rows[0]).toEqual({ visibility: "private", proposed_content: "private thought" });
  });
});
