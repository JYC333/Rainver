import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgHostRepository } from "../src/modules/hosts/repository.js";
import { PgArtifactRepository } from "../src/modules/artifacts/repository.js";

// Real-Postgres coverage for the ADR 0016 D7 upload path: a remote host may
// only upload diff/output artifacts for a Run bound to its own Folder, and
// a remote diff/output never becomes anything but a read-only artifact.

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb";
const SPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const HOST_A = "33333333-3333-4333-8333-333333333333";
const HOST_B = "44444444-4444-4444-8444-444444444444";
const FOLDER_A = "55555555-5555-4555-8555-555555555555";
const AGENT = "66666666-6666-4666-8666-666666666666";
const AGENT_VERSION = "77777777-7777-4777-8777-777777777777";
const RUN_A = "88888888-8888-4888-8888-888888888888";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["runs", "workspace_locations", "project_folders", "agent_versions", "agents", "projects", "hosts", "machines", "spaces", "users"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'active', $3, $3), ($2, 'Member', 'active', $3, $3)`,
    [OWNER, MEMBER, now],
  );
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at) VALUES ($1, 'Space', 'household', $2, $3, $3)`, [SPACE, OWNER, now]);
  await db.pool.query(`INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1, $2, $3, 'Project', 'active', $4, $4)`, [PROJECT, SPACE, OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, 'member', 'active', $3, $3)`,
    [SPACE, MEMBER, now],
  );
  await db.pool.query(
    `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, $3, 'member', 'active', $4, $4)`,
    [SPACE, PROJECT, MEMBER, now],
  );
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at) VALUES
       ($1, $3, 'Machine A', 'desktop', $4, $4),
       ($2, $3, 'Machine B', 'desktop', $4, $4)`,
    [HOST_A, HOST_B, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, created_at, updated_at) VALUES
       ($1, $3, $1, 'Host A', 'remote', 'linux_native', 'online', $4, $4),
       ($2, $3, $2, 'Host B', 'remote', 'linux_native', 'online', $4, $4)`,
    [HOST_A, HOST_B, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO project_folders (
       id, space_id, project_id, name, status, kind,
       is_primary, protected, system_managed, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Folder A', 'active', 'code', false, false, false, $4, $4)`,
    [FOLDER_A, SPACE, PROJECT, now],
  );
  await db.pool.query(
    `INSERT INTO workspace_locations (
       id, space_id, project_folder_id, execution_host_id, execution_host_kind,
       execution_ready, status, preferred, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'remote',true,'active',true,$5,$5)`,
    ["location-a", SPACE, FOLDER_A, HOST_A, now],
  );
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, current_version_id, visibility, created_at, updated_at)
     VALUES ($1, $2, NULL, 'Agent', 'active', 'standard', NULL, 'space_shared', $3, $3)`,
    [AGENT, SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (id, agent_id, space_id, version_label, system_prompt, model_config_json, runtime_config_json, context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json, runtime_policy_json, created_at)
     VALUES ($1, $2, $3, 'v1', 'x', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
    [AGENT_VERSION, AGENT, SPACE, now],
  );
  await db.pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, AGENT_VERSION]);
  await db.pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
       project_folder_id, workspace_location_id, trust_mode, adapter_type, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'agent', 'manual', 'succeeded', 'live', $5, $6, 'trusted_host', 'claude_code', $7, $8, $8)`,
    [RUN_A, SPACE, AGENT, AGENT_VERSION, FOLDER_A, "location-a", OWNER, now],
  );
});

describe("host upload authorization and artifact recording (ADR 0016 D7)", () => {
  it("lets a host record a diff artifact only for a Run bound to its own Folder", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repo = new PgHostRepository(db.pool);
    expect(await repo.runOwnedByHost(HOST_B, RUN_A)).toBeNull();
    const run = await repo.runOwnedByHost(HOST_A, RUN_A);
    expect(run).not.toBeNull();
    const result = await repo.recordDiffArtifact(run!, OWNER, { diff: "diff --git a/x b/x\n+hi\n", truncated: false });
    expect(result.artifact_id).toBeTruthy();

    const row = await db.pool.query<{ artifact_type: string; visibility: string; content: string; project_folder_id: string }>(
      `SELECT artifact_type, visibility, content, project_folder_id FROM artifacts WHERE id = $1`,
      [result.artifact_id],
    );
    expect(row.rows[0]).toMatchObject({
      artifact_type: "remote_diff",
      // space_shared, not private: a thread's visibility follows Project
      // read access (GET /api/v1/hosts/threads), not host ownership — a
      // private artifact here would let a non-owner reader see the "Review
      // diff" button but get a false "no diff was uploaded".
      visibility: "space_shared",
      project_folder_id: FOLDER_A,
    });
    expect(row.rows[0]!.content).toContain("+hi");
  });

  it("truncates an oversized diff and records that it was truncated", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repo = new PgHostRepository(db.pool);
    const run = await repo.runOwnedByHost(HOST_A, RUN_A);
    const oversized = "x".repeat(2_000_000);
    const result = await repo.recordDiffArtifact(run!, OWNER, { diff: oversized, truncated: false });
    const row = await db.pool.query<{ content: string; metadata_json: { truncated: boolean } }>(
      `SELECT content, metadata_json FROM artifacts WHERE id = $1`,
      [result.artifact_id],
    );
    expect(row.rows[0]!.content.length).toBeLessThan(oversized.length);
    expect(row.rows[0]!.metadata_json).toMatchObject({ truncated: true });
  });

  it("records one artifact per output file, skipping oversized files and capping the count", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repo = new PgHostRepository(db.pool);
    const run = await repo.runOwnedByHost(HOST_A, RUN_A);
    const files = [
      { name: "report.md", content: "# done" },
      { name: "too-big.bin", content: "x".repeat(3_000_000) },
      ...Array.from({ length: 25 }, (_, i) => ({ name: `extra-${i}.txt`, content: "x" })),
    ];
    const result = await repo.recordOutputArtifacts(run!, OWNER, files);
    expect(result.skipped).toContain("too-big.bin");
    // 20-file cap: report.md + too-big.bin(skipped for size, still counts
    // toward the slice) + 18 of the 25 "extra" files fit in the first 20.
    expect(result.artifact_ids.length).toBeLessThanOrEqual(20);
    expect(result.skipped.length).toBeGreaterThan(0);

    const rows = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM artifacts WHERE run_id = $1 AND artifact_type = 'remote_output'`,
      [RUN_A],
    );
    expect(Number(rows.rows[0]!.count)).toBe(result.artifact_ids.length);
  });

  it("lets a Project member who is not the dispatching host owner read the recorded diff (space_shared, not private)", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const hosts = new PgHostRepository(db.pool);
    const run = await hosts.runOwnedByHost(HOST_A, RUN_A);
    const { artifact_id: artifactId } = await hosts.recordDiffArtifact(run!, OWNER, { diff: "diff --git a/x b/x\n+hi\n", truncated: false });

    const artifacts = new PgArtifactRepository(db.pool, { artifactStorageRoot: "/tmp", sandboxRoot: "/tmp" });
    const asMember = await artifacts.getVisible(SPACE, MEMBER, artifactId, true);
    expect(asMember?.content).toContain("+hi");

    const listedForMember = await artifacts.listVisible(SPACE, MEMBER, { runId: RUN_A, limit: 10, offset: 0 });
    expect(listedForMember.items.map((item) => item.id)).toContain(artifactId);
  });
});
