import { readRunFilePreview } from "../src/modules/runs/filePreview.js";
import { loadConfig } from "../src/config.js";
import { beforeEach, describe, expect, it } from "vitest";
import { HostRunDiffUploadSchema } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgHostRepository } from "../src/modules/hosts/repository.js";
import { PgArtifactRepository } from "../src/modules/artifacts/repository.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { ensureDefaultRuntimeProfile, seedMainlineRoomsForAllProjects, seedServerHost } from "./support/domainSeeds.js";

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
const ATTEMPT_A = "88888888-8888-4888-8888-aaaaaaaaaaaa";
const LAUNCH_A = "88888888-8888-4888-8888-bbbbbbbbbbbb";
const LAUNCH_STALE = "88888888-8888-4888-8888-cccccccccccc";


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
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source) VALUES ($1, 'Owner', 'active', $3, $3, lower(gen_random_uuid()::text || '@test.invalid'), 'system'), ($2, 'Member', 'active', $3, $3, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [OWNER, MEMBER, now],
  );
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at) VALUES ($1, 'Space', 'household', $2, $3, $3)`, [SPACE, OWNER, now]);
  await db.pool.query(`INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1, $2, $3, 'Project', 'active', $4, $4)`, [PROJECT, SPACE, OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, 'member', 'active', $3, $3)`,
    [SPACE, MEMBER, now],
  );
  await db.pool.query(`INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES (gen_random_uuid()::varchar, $1, $2, 'member', 'active', now(), now())`, [SPACE, OWNER]);
  await seedMainlineRoomsForAllProjects(db.pool);
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
       execution_ready, status, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'remote',true,'active',$5,$5)`,
    ["location-a", SPACE, FOLDER_A, HOST_A, now],
  );
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, current_version_id, visibility, created_at, updated_at)
     VALUES ($1, $2, NULL, 'Agent', 'active', 'standard', NULL, 'space_shared', $3, $3)`,
    [AGENT, SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (id, agent_id, space_id, version_label, system_prompt, context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json, created_at)
     VALUES ($1, $2, $3, 'v1', 'x', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, $4)`,
    [AGENT_VERSION, AGENT, SPACE, now],
  );
  await db.pool.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, AGENT_VERSION]);
  await ensureDefaultRuntimeProfile(db.pool, {
    agent: AGENT,
    space: SPACE,
    runtimeKey: "claude_code",
    executionHostId: HOST_A,
    workspaceLocationId: "location-a",
    workspaceMode: "location",
    runtimeInstallation: "managed:1.0.0",
    now,
  });
  await db.pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, project_folder_id, workspace_location_id, trust_mode, owner_user_id, created_at, updated_at, execution_kind, runtime_profile_id, runtime_profile_selection_source, runtime_key, runtime_profile_snapshot_json)
     VALUES ($1, $2, $3, $4, 'agent', 'manual', 'succeeded', 'live', $5, $6, 'trusted_host', $7, $8, $8, 'agent', (SELECT p.id FROM agent_runtime_profiles p WHERE p.space_id = $2::varchar(36) AND p.agent_id = $3::varchar(36) AND p.is_default = TRUE), 'default', (SELECT p.runtime_key FROM agent_runtime_profiles p WHERE p.space_id = $2::varchar(36) AND p.agent_id = $3::varchar(36) AND p.is_default = TRUE), (SELECT jsonb_build_object('id', p.id, 'runtime_key', p.runtime_key, 'backend_mode', p.backend_mode, 'model_provider_id', p.model_provider_id, 'model_name', p.model_name, 'runtime_config_json', p.runtime_config_json, 'runtime_policy_json', p.runtime_policy_json) FROM agent_runtime_profiles p WHERE p.space_id = $2::varchar(36) AND p.agent_id = $3::varchar(36) AND p.is_default = TRUE))`,
    [RUN_A, SPACE, AGENT, AGENT_VERSION, FOLDER_A, "location-a", OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO run_attempts (id, space_id, run_id, attempt_number, status, launch_id, started_at, created_at, updated_at)
     VALUES ($1, $2, $3, 1, 'running', $4, $5, $5, $5)`,
    [ATTEMPT_A, SPACE, RUN_A, LAUNCH_A, now],
  );
});

function accepted<T>(outcome: { ok: true; result: T } | { ok: false; reason: string }): T {
  if (!outcome.ok) throw new Error(`upload refused: ${outcome.reason}`);
  return outcome.result;
}

describe("host upload authorization and artifact recording (ADR 0016 D7)", () => {
  it("lets a host record a diff artifact only for a Run bound to its own Folder", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repo = new PgHostRepository(db.pool);
    await expect(repo.recordDiffArtifact(HOST_B, OWNER, RUN_A, { launch_id: LAUNCH_A, diff: "x", truncated: false }))
      .resolves.toEqual({ ok: false, reason: "run_not_on_host" });
    const result = accepted(await repo.recordDiffArtifact(HOST_A, OWNER, RUN_A, { launch_id: LAUNCH_A, diff: "diff --git a/x b/x\n+hi\n", truncated: false }));
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
    const oversized = "x".repeat(2_000_000);
    const result = accepted(await repo.recordDiffArtifact(HOST_A, OWNER, RUN_A, { launch_id: LAUNCH_A, diff: oversized, truncated: false }));
    const row = await db.pool.query<{ content: string; metadata_json: { truncated: boolean } }>(
      `SELECT content, metadata_json FROM artifacts WHERE id = $1`,
      [result.artifact_id],
    );
    expect(row.rows[0]!.content.length).toBeLessThan(oversized.length);
    expect(row.rows[0]!.metadata_json).toMatchObject({ truncated: true });
  });

  it("locates a linked workspace file under the pinned Location and rechecks path/Project authority", async () => {
    const { mkdtemp, mkdir, writeFile, symlink, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'rainver-file-preview-'));
    try {
      await mkdir(join(root, '.agent'));
      await writeFile(join(root, '.agent', 'report.md'), '# Result\nSafe report');
      await writeFile(join(root, '.env'), 'SECRET=x');
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
      await writeFile(join(root, 'preview.png'), Buffer.from(png, 'base64'));
      await symlink(join(root, '.agent', 'report.md'), join(root, 'link.md'));
      await seedServerHost(db.pool, { id: '99999999-9999-4999-8999-999999999999' });
      await db.pool.query(`UPDATE workspace_locations SET execution_host_id = '99999999-9999-4999-8999-999999999999', execution_host_kind = 'server', root_path = $1, display_path = $1 WHERE id = 'location-a'`, [root]);
      await db.pool.query(`UPDATE runs SET project_id = $2 WHERE id = $1`, [RUN_A, PROJECT]);
      const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
      const identity = { spaceId: SPACE, userId: OWNER };
      expect(await readRunFilePreview(db.pool, config, identity, RUN_A, `${root}/.agent/report.md:2`)).toMatchObject({ kind: 'workspace', project_id: PROJECT, folder_id: FOLDER_A, path: '.agent/report.md', line: 2 });
      expect(await readRunFilePreview(db.pool, config, identity, RUN_A, 'preview.png')).toMatchObject({ kind: 'image', mime_type: 'image/png', content_base64: png });
      await expect(readRunFilePreview(db.pool, config, identity, RUN_A, '../outside.md')).rejects.toMatchObject({ statusCode: 404 });
      await expect(readRunFilePreview(db.pool, config, identity, RUN_A, '.env')).rejects.toMatchObject({ statusCode: 403 });
      await expect(readRunFilePreview(db.pool, config, identity, RUN_A, 'link.md')).rejects.toMatchObject({ statusCode: 403 });
      await db.pool.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [PROJECT, MEMBER]);
      await expect(readRunFilePreview(db.pool, config, { ...identity, userId: MEMBER }, RUN_A, '.agent/report.md')).rejects.toMatchObject({ statusCode: 404 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("previews uploaded raster bytes only through the visible Run and artifact, rejects unsafe output", async () => {
    const hosts = new PgHostRepository(db.pool);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=";
    const uploaded = accepted(await hosts.recordOutputArtifacts(HOST_A, OWNER, RUN_A, { launch_id: LAUNCH_A, files: [
      { name: "preview.png", content: png, encoding: "base64" },
      { name: "note.md", content: "# Preview" },
      { name: "evil.svg", content: Buffer.from('<svg onload="alert(1)"/>').toString('base64'), encoding: "base64" },
      { name: "../escape.png", content: png, encoding: "base64" },
    ] }));
    expect(uploaded.skipped).toEqual(["evil.svg", "../escape.png"]);
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    const identity = { spaceId: SPACE, userId: OWNER };
    expect(await readRunFilePreview(db.pool, config, identity, RUN_A, '/__run_output__/preview.png')).toEqual({ kind: 'image', name: 'preview.png', mime_type: 'image/png', content_base64: png });
    expect(await readRunFilePreview(db.pool, config, identity, RUN_A, '/__run_output__/note.md')).toMatchObject({ kind: 'text', content: '# Preview' });
    await expect(readRunFilePreview(db.pool, config, identity, RUN_A, '/tmp/unpublished.png')).rejects.toMatchObject({ statusCode: 404 });
    await expect(readRunFilePreview(db.pool, config, { ...identity, spaceId: 'elsewhere' }, RUN_A, '/__run_output__/preview.png')).rejects.toMatchObject({ statusCode: 404 });
    await db.pool.query(`UPDATE artifacts SET access_level = 'summary' WHERE run_id = $1`, [RUN_A]);
    await expect(readRunFilePreview(db.pool, config, { ...identity, userId: MEMBER }, RUN_A, '/__run_output__/preview.png')).rejects.toMatchObject({ statusCode: 404 });
    await db.pool.query(`UPDATE artifacts SET access_level = 'full' WHERE run_id = $1`, [RUN_A]);
    await db.pool.query(`UPDATE runs SET visibility = 'private', owner_user_id = $2 WHERE id = $1`, [RUN_A, MEMBER]);
    await expect(readRunFilePreview(db.pool, config, identity, RUN_A, '/__run_output__/preview.png')).rejects.toMatchObject({ statusCode: 404 });
  });

  it("skips NUL-containing text without rolling back valid previews in the same upload", async (ctx) => {
    if (!db.available) return ctx.skip();
    const hosts = new PgHostRepository(db.pool);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=";
    const result = accepted(await hosts.recordOutputArtifacts(HOST_A, OWNER, RUN_A, {
      launch_id: LAUNCH_A,
      files: [
        { name: "misdecoded.png", content: Buffer.from(png, "base64").toString("utf8") },
        { name: "note.txt", content: "中文预览\nPREVIEW-OK" },
        { name: "image.png", content: png, encoding: "base64" },
      ],
    }));
    expect(result.skipped).toEqual(["misdecoded.png"]);
    expect(result.artifact_ids).toHaveLength(2);
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    const identity = { spaceId: SPACE, userId: OWNER };
    expect(await readRunFilePreview(db.pool, config, identity, RUN_A, "/__run_output__/note.txt"))
      .toMatchObject({ kind: "text", content: "中文预览\nPREVIEW-OK" });
    expect(await readRunFilePreview(db.pool, config, identity, RUN_A, "/__run_output__/image.png"))
      .toMatchObject({ kind: "image", mime_type: "image/png", content_base64: png });
  });

  it("records one artifact per output file, skipping oversized files and capping the count", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const repo = new PgHostRepository(db.pool);
    const files = [
      { name: "report.md", content: "# done" },
      { name: "too-big.bin", content: "x".repeat(3_000_000) },
      ...Array.from({ length: 25 }, (_, i) => ({ name: `extra-${i}.txt`, content: "x" })),
    ];
    const result = accepted(await repo.recordOutputArtifacts(HOST_A, OWNER, RUN_A, { launch_id: LAUNCH_A, files }));
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
    const { artifact_id: artifactId } = accepted(await hosts.recordDiffArtifact(HOST_A, OWNER, RUN_A, { launch_id: LAUNCH_A, diff: "diff --git a/x b/x\n+hi\n", truncated: false }));
    if (!artifactId) throw new Error("expected a diff artifact");

    const artifacts = new PgArtifactRepository(db.pool, { artifactStorageRoot: "/tmp", sandboxRoot: "/tmp" });
    const asMember = await artifacts.getVisible(SPACE, MEMBER, artifactId, true);
    expect(asMember?.content).toContain("+hi");

    const listedForMember = await artifacts.listVisible(SPACE, MEMBER, { runId: RUN_A, limit: 10, offset: 0 });
    expect(listedForMember.items.map((item) => item.id)).toContain(artifactId);
  });

  it("records where the Run left the checkout on the Run, and keeps it through finalization", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const now = new Date().toISOString();
    const sessionId = "99999999-9999-4999-8999-999999999999";
    await db.pool.query(
      // A direct chat's Conversation: its Runs carry the session id just as a Room turn's do.
      `INSERT INTO sessions (id, space_id, project_id, user_id, agent_id, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6)`,
      [sessionId, SPACE, PROJECT, OWNER, AGENT, now],
    );
    await db.pool.query(
      `INSERT INTO conversation_execution_contexts (
         id, space_id, session_id, execution_host_id, primary_workspace_mode,
         primary_project_folder_id, primary_workspace_location_id, state, initialized_at,
         git_branch, git_head, git_execution_ready, git_observed_at, created_at, updated_at
       ) VALUES (gen_random_uuid()::varchar, $1, $2, $3, 'location', $4, 'location-a', 'initialized', $5,
                 'main', 'baseline', true, $5, $5, $5)`,
      [SPACE, sessionId, HOST_A, FOLDER_A, now],
    );
    await db.pool.query(`UPDATE runs SET session_id = $2, status = 'running', output_json = NULL WHERE id = $1`, [RUN_A, sessionId]);
    const hosts = new PgHostRepository(db.pool);

    // No diff could be read, but the checkout could: nothing to review, and
    // the Run still records where it left HEAD.
    const result = accepted(await hosts.recordDiffArtifact(HOST_A, OWNER, RUN_A, {
      launch_id: LAUNCH_A,
      diff: null,
      truncated: false,
      git_before: { branch: "main", head: "baseline" },
      git_after: { branch: "main", head: "agent-commit" },
    }));
    expect(result.artifact_id).toBeNull();

    await new PgRunRepository(db.pool).markRunTerminal({
      run_id: RUN_A,
      space_id: SPACE,
      status: "succeeded",
      output_json: { summary: "done" },
      completed_at: new Date().toISOString(),
    });
    const finalized = await db.pool.query<{ output_json: Record<string, unknown> }>(`SELECT output_json FROM runs WHERE id = $1`, [RUN_A]);
    expect(finalized.rows[0]!.output_json).toMatchObject({
      summary: "done",
      workspace_after: { branch: "main", head: "agent-commit", workspace_location_id: "location-a" },
    });
  });

  it("records the version a read-only review read, never a diff of its own, and keeps it through finalization", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    await db.pool.query(
      `UPDATE runs SET status = 'running', output_json = NULL, required_sandbox_level = 'read_only',
         contract_snapshot_json = COALESCE(contract_snapshot_json, '{}'::jsonb) || '{"workspace_access":"read"}'::jsonb
        WHERE id = $1`,
      [RUN_A],
    );
    const hosts = new PgHostRepository(db.pool);
    const tree = "a".repeat(40);
    expect(HostRunDiffUploadSchema.safeParse({ launch_id: LAUNCH_A, diff: "", workspace_tree_before: tree }).success).toBe(true);
    expect(HostRunDiffUploadSchema.safeParse({ launch_id: LAUNCH_A, diff: "", workspace_tree_before: "not-a-tree" }).success).toBe(false);
    // Someone else's change in the directory is not the review's own.
    const result = accepted(await hosts.recordDiffArtifact(HOST_A, OWNER, RUN_A, {
      launch_id: LAUNCH_A,
      diff: "diff --git a/f b/f\n+someone else\n",
      truncated: false,
      git_before: { branch: "main", head: "reviewed-head" },
      workspace_tree_before: tree,
    }));
    expect(result.artifact_id).toBeNull();
    expect((await db.pool.query("SELECT 1 FROM artifacts WHERE run_id = $1 AND artifact_type = 'remote_diff'", [RUN_A])).rowCount).toBe(0);
    await new PgRunRepository(db.pool).markRunTerminal({
      run_id: RUN_A, space_id: SPACE, status: "succeeded", output_json: { summary: "reviewed" }, completed_at: new Date().toISOString(),
    });
    const finalized = await db.pool.query<{ output_json: Record<string, unknown> }>(`SELECT output_json FROM runs WHERE id = $1`, [RUN_A]);
    expect(finalized.rows[0]!.output_json).toMatchObject({
      summary: "reviewed",
      review_basis: { head: "reviewed-head", branch: "main", tree, changed_during_review: true, launch_id: LAUNCH_A },
    });
  });

  it("keeps a Run's diff and its checkout position when the branch name is long", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const now = new Date().toISOString();
    const sessionId = "99999999-9999-4999-8999-999999999997";
    await db.pool.query(
      `INSERT INTO sessions (id, space_id, project_id, user_id, agent_id, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6)`,
      [sessionId, SPACE, PROJECT, OWNER, AGENT, now],
    );
    await db.pool.query(
      `INSERT INTO conversation_execution_contexts (
         id, space_id, session_id, execution_host_id, primary_workspace_mode,
         primary_project_folder_id, primary_workspace_location_id, state, initialized_at,
         git_branch, git_head, git_execution_ready, git_observed_at, created_at, updated_at
       ) VALUES (gen_random_uuid()::varchar, $1, $2, $3, 'location', $4, 'location-a', 'initialized', $5,
                 'main', 'baseline', true, $5, $5, $5)`,
      [SPACE, sessionId, HOST_A, FOLDER_A, now],
    );
    await db.pool.query(`UPDATE runs SET session_id = $2, status = 'running', output_json = NULL WHERE id = $1`, [RUN_A, sessionId]);
    const hosts = new PgHostRepository(db.pool);
    const branch = `feature/${"x".repeat(300)}`;
    expect(HostRunDiffUploadSchema.safeParse({ launch_id: LAUNCH_A, diff: "diff --git a/f b/f\n", git_after: { branch, head: "h" } }).success).toBe(true);
    const result = accepted(await hosts.recordDiffArtifact(HOST_A, OWNER, RUN_A, {
      launch_id: LAUNCH_A,
      diff: "diff --git a/f b/f\n",
      truncated: false,
      git_after: { branch, head: "agent-commit" },
    }));
    expect(result.artifact_id).toBeTruthy();
    const recorded = await db.pool.query<{ branch: string }>(`SELECT output_json->'workspace_after'->>'branch' AS branch FROM runs WHERE id = $1`, [RUN_A]);
    expect(recorded.rows[0]!.branch).toBe(branch);
  });

  it("binds every upload to the Run's current open attempt and refuses the rest", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const hosts = new PgHostRepository(db.pool);
    const diff = { diff: "diff --git a/x b/x\n+hi\n", truncated: false };
    // A nonce no attempt carries: nothing to bind to.
    await expect(hosts.recordDiffArtifact(HOST_A, OWNER, RUN_A, { launch_id: LAUNCH_STALE, ...diff }))
      .resolves.toEqual({ ok: false, reason: "attempt_superseded" });
    // The attempt was retried: attempt 1's nonce is no longer the current one.
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO run_attempts (id, space_id, run_id, attempt_number, status, launch_id, started_at, created_at, updated_at)
       VALUES (gen_random_uuid()::varchar, $1, $2, 2, 'running', $3, $4, $4, $4)`,
      [SPACE, RUN_A, LAUNCH_STALE, now],
    );
    await expect(hosts.recordDiffArtifact(HOST_A, OWNER, RUN_A, { launch_id: LAUNCH_A, ...diff }))
      .resolves.toEqual({ ok: false, reason: "attempt_superseded" });
    await expect(hosts.recordOutputArtifacts(HOST_A, OWNER, RUN_A, { launch_id: LAUNCH_A, files: [{ name: "a.txt", content: "x" }] }))
      .resolves.toEqual({ ok: false, reason: "attempt_superseded" });
    // The live attempt's own uploads land.
    const live = accepted(await hosts.recordDiffArtifact(HOST_A, OWNER, RUN_A, { launch_id: LAUNCH_STALE, ...diff }));
    expect(live.artifact_id).toBeTruthy();
    // Once it has ended, its outputs are closed too.
    await db.pool.query(`UPDATE run_attempts SET status = 'failed' WHERE launch_id = $1`, [LAUNCH_STALE]);
    await expect(hosts.recordOutputArtifacts(HOST_A, OWNER, RUN_A, { launch_id: LAUNCH_STALE, files: [] }))
      .resolves.toEqual({ ok: false, reason: "attempt_ended" });
    const rows = await db.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM artifacts WHERE run_id = $1`, [RUN_A]);
    expect(rows.rows[0]!.count).toBe("1");
  });

  it("answers a repeated or concurrent upload of one delivery with the artifact it already made", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const hosts = new PgHostRepository(db.pool);
    const diff = { launch_id: LAUNCH_A, diff: "diff --git a/x b/x\n+hi\n", truncated: false, git_after: { branch: "main", head: "h1" } };
    const [first, second] = await Promise.all([
      hosts.recordDiffArtifact(HOST_A, OWNER, RUN_A, diff),
      hosts.recordDiffArtifact(HOST_A, OWNER, RUN_A, diff),
    ]);
    expect(accepted(first!).artifact_id).toBe(accepted(second!).artifact_id);
    const again = accepted(await hosts.recordDiffArtifact(HOST_A, OWNER, RUN_A, { ...diff, git_after: { branch: "main", head: "h2" } }));
    expect(again.artifact_id).toBe(accepted(first!).artifact_id);
    // The retry did not rewrite where the first delivery said HEAD stood.
    const recorded = await db.pool.query<{ head: string }>(`SELECT output_json->'workspace_after'->>'head' AS head FROM runs WHERE id = $1`, [RUN_A]);
    expect(recorded.rows[0]!.head).toBe("h1");

    const files = [{ name: "report.md", content: "# done" }, { name: "notes.txt", content: "n" }];
    const [outputsA, outputsB] = await Promise.all([
      hosts.recordOutputArtifacts(HOST_A, OWNER, RUN_A, { launch_id: LAUNCH_A, files }),
      hosts.recordOutputArtifacts(HOST_A, OWNER, RUN_A, { launch_id: LAUNCH_A, files }),
    ]);
    expect(accepted(outputsA!).artifact_ids).toEqual(accepted(outputsB!).artifact_ids);
    const repeat = accepted(await hosts.recordOutputArtifacts(HOST_A, OWNER, RUN_A, { launch_id: LAUNCH_A, files }));
    expect(repeat.artifact_ids).toEqual(accepted(outputsA!).artifact_ids);
    const rows = await db.pool.query<{ artifact_type: string; count: string }>(
      `SELECT artifact_type, count(*)::text AS count FROM artifacts WHERE run_id = $1 GROUP BY artifact_type ORDER BY artifact_type`,
      [RUN_A],
    );
    expect(rows.rows).toEqual([{ artifact_type: "remote_diff", count: "1" }, { artifact_type: "remote_output", count: "2" }]);
  });
});
