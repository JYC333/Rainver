import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedServerHost, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import {
  INTERRUPTED_INSTALL_ERROR,
  PgRuntimeProvisioningRepository,
} from "../src/modules/hosts/runtimeProvisioningRepository.js";
import {
  ServerOpenCodeProvisioner,
  __resetSharedServerOpenCodeProvisionerForTests,
  sharedServerOpenCodeProvisioner,
} from "../src/modules/hosts/serverOpenCodeProvisioner.js";
import type { HostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import { SERVER_OPENCODE_RELEASE } from "../src/modules/runtimeAdapters/opencodeRelease.js";
import { PgRuntimeSkillProvider, renderRuntimeSkillCandidate } from "../src/modules/capabilities/runtimeSkillProvider.js";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common.js";
import { normalizeVendorEvents } from "../src/modules/runs/runtimeEventNormalization.js";
import { getLocalCliRuntimeAdapterSpec, getRuntimeAdapterSpec, isVendorCliAdapter, listRuntimeAdapterSpecs } from "../src/modules/runtimeAdapters/specs.js";
import { supportsRuntimeBackendMode } from "../src/modules/runtimeAdapters/runtimeDefinitions.js";

describe("runtimeAdapters", () => {
  describe("runtime adapter catalog", () => {
    it("keeps model-provider credentials separate from local CLI login state", () => {
      const specs = listRuntimeAdapterSpecs();
      // A runtime is credentialed by its own login, optionally backed by a
      // bound ModelProvider — never by holding a provider API key itself. A
      // dynamic (registry) spec is built at runtime, so this is checked here
      // and not only by the CredentialMode union.
      for (const spec of specs) {
        expect(["none", "cli_profile", "cli_profile_or_model_provider"]).toContain(spec.credentials.credential_mode);
      }

      for (const spec of specs.filter((item) => item.runtime_kind === "local_cli")) {
        // `supportsRuntimeBackendMode` is the one backend-mode authority; the
        // spec carries no second answer for a reader to prefer.
        if (spec.runtime_key !== "opencode") {
          expect(supportsRuntimeBackendMode(spec.runtime_key, "model_provider")).toBe(false);
        }
        expect(["cli_profile", "cli_profile_or_model_provider"]).toContain(spec.credentials.credential_mode);
        expect(spec.credentials.credential_runtime_name).toBe(spec.runtime_key);
      }
    });

    it("exposes only implemented local CLI adapters as executable vendor CLIs", () => {
      expect(isVendorCliAdapter("claude_code")).toBe(true);
      expect(isVendorCliAdapter("codex_cli")).toBe(true);
      expect(isVendorCliAdapter("opencode")).toBe(true);
      expect(isVendorCliAdapter("gemini_cli")).toBe(false);
      expect(getLocalCliRuntimeAdapterSpec("opencode")?.implementation_status).toBe("implemented");
    });


    it("does not register an in-process Agent runtime", () => {
      expect(getRuntimeAdapterSpec("model_api")).toBeNull();
    });

    it("declares the execution and trust capabilities for every catalog entry", () => {
      for (const spec of listRuntimeAdapterSpecs()) {
        expect(spec.executor_family).toBe(spec.runtime_kind);
        expect(spec.subagent_support).toBeDefined();
        expect(spec.subagent_disable_mechanism).toBeDefined();
        expect(spec.delegation_controllability).toBeDefined();
        expect(spec.structured_output).toBeDefined();
        expect(spec.checkpoint_resume).toBeDefined();
        expect(spec.cancellation_reliability).toBeDefined();
        expect(spec.observability_level).toBeDefined();
        expect(spec.side_effect_level).toBeDefined();
        expect(spec.data_exposure).toBeDefined();
        expect(spec.baseline_trust_level).toBeDefined();
      }
      expect(getRuntimeAdapterSpec("claude_code")).toMatchObject({
        executor_family: "local_cli",
        subagent_support: "runtime_internal",
        subagent_disable_mechanism: "runtime_config",
        subagent_disable_config: {
          relative_path: ".claude/settings.json",
          denied_value: "Task",
        },
      });
      expect(getRuntimeAdapterSpec("codex_cli")?.subagent_disable_mechanism).toBe("unknown");
      expect(getRuntimeAdapterSpec("opencode")).toMatchObject({
        implementation_status: "implemented",
        invocation: {
          headless_command_template: ["{executable}", "acp", "--cwd", "{sandbox_cwd}"],
          protocol: "acp",
        },
        subagent_disable_config: {
          relative_path: "opencode.json",
          denied_value: { "*": "deny" },
          required_values: expect.arrayContaining([
            { path: ["default_agent"], value: "rainver-locked", value_mode: "exact" },
            { path: ["subagent_depth"], value: 0, value_mode: "exact" },
            { path: ["agent", "rainver-locked", "mode"], value: "primary", value_mode: "exact" },
          ]),
        },
      });
    });
  });
});

describe("runtimeEventNormalization", () => {
  // Runtime I/O Convergence requires semantic Run Events to never persist
  // credentials or unbounded vendor payloads (see
  // .agent/architecture/RUNS_AND_OUTPUTS.md). Codex-style command_execution
  // events fall back to the raw shell command string for tool_name, which can
  // carry secrets or arbitrarily long text — this must be redacted and bounded
  // the same way `error.message` already is.

  describe("normalizeVendorEvents tool_name redaction", () => {
    it("redacts a secret embedded in an ACP tool_call title", () => {
      const events = normalizeVendorEvents("codex_cli", [{
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: 'curl -H "Bearer sk-abcdefghijklmnop123456" https://example.com',
          },
        },
      }], "2026-07-25T00:00:00.000Z");
      expect(events).toHaveLength(1);
      const toolName = String((events[0]!.metadata_json as Record<string, unknown>).tool_name);
      expect(toolName).not.toContain("sk-abcdefghijklmnop123456");
      expect(toolName).toContain("[REDACTED_SECRET]");
    });

    it("truncates an oversized tool_call title instead of persisting it unbounded", () => {
      const longTitle = `echo ${"a".repeat(5_000)}`;
      const events = normalizeVendorEvents("codex_cli", [{
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: longTitle },
        },
      }], "2026-07-25T00:00:00.000Z");
      const toolName = String((events[0]!.metadata_json as Record<string, unknown>).tool_name);
      expect(toolName.length).toBeLessThan(longTitle.length);
      expect(toolName.endsWith("...[truncated]")).toBe(true);
    });

    it("normalizes ACP tool lifecycle updates", () => {
      const events = normalizeVendorEvents("opencode", [
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call-1",
              title: "Read file",
            },
          },
        },
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call-1",
              status: "failed",
            },
          },
        },
      ], "2026-07-25T00:00:00.000Z");

      expect(events.map((event) => event.type)).toEqual([
        "tool_call_started",
        "tool_call_failed",
      ]);
      expect((events[0]!.metadata_json as Record<string, unknown>).tool_name).toBe("Read file");
    });

    it("normalizes ACP tool lifecycle updates for codex_cli too (ACP runtime replatform P3)", () => {
      const events = normalizeVendorEvents("codex_cli", [
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call-1",
              title: "npm test",
            },
          },
        },
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call-1",
              status: "completed",
            },
          },
        },
      ], "2026-07-25T00:00:00.000Z");

      expect(events.map((event) => event.type)).toEqual([
        "tool_call_started",
        "tool_call_completed",
      ]);
      expect(events.every((event) => event.call_id === "call-1")).toBe(true);
    });

    it("repairs missing starts and anonymous ids before writing semantic events", () => {
      const repaired = normalizeVendorEvents("codex_cli", [{
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: { sessionUpdate: "tool_call_update", title: "task.create", status: "completed" },
        },
      }], "2026-07-25T00:00:00.000Z");

      expect(repaired.map((event) => event.type)).toEqual([
        "tool_call_started",
        "tool_call_completed",
      ]);
      expect(repaired[0]?.call_id).toMatch(/^rainver:acp:anonymous:/);
      expect(repaired[1]?.call_id).toBe(repaired[0]?.call_id);
    });

    it("produces no normalized event for an ACP initialize response echoed for diagnostics", () => {
      const events = normalizeVendorEvents("opencode", [
        {
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: 1,
            agentCapabilities: { sessionCapabilities: ["close", "fork", "list", "resume"] },
          },
        },
      ], "2026-07-25T00:00:00.000Z");

      expect(events).toEqual([]);
    });
  });
});

describe("runtimeSkillProvider", () => {
  class FakeQueryable implements Queryable {
    readonly queries: string[] = [];

    constructor(
      private readonly dbBindingRows: Record<string, unknown>[],
      private readonly enablementRows: Record<string, unknown>[],
    ) {}

    async query<Row = Record<string, unknown>>(sql: string): Promise<QueryResult<Row>> {
      this.queries.push(sql);
      const rows = sql.includes("JOIN capability_runtime_bindings")
        ? this.dbBindingRows
        : this.enablementRows;
      return { rows: rows as Row[], rowCount: rows.length };
    }
  }

  describe("PgRuntimeSkillProvider", () => {
    it("loads default runtime bindings for enabled built-in capabilities", async () => {
      const db = new FakeQueryable([], [
          {
            capability_enablement_id: "enable-1",
            capability_key: "research.source_collect",
            capability_version_id: null,
            enabled: true,
            config_json: { source_mode: "project_sources" },
          },
        ]);
      const provider = new PgRuntimeSkillProvider(db);

      const candidates = await provider.loadCandidatesForRun({
        space_id: "space-1",
        run_id: "run-1",
        runtime_key: "codex_cli",
        capability_id: "research.source_collect",
        agent_id: "agent-1",
        project_id: "project-1",
        instructed_by_user_id: "user-1",
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        binding_id: "research.source_collect:codex_cli:render_skill",
        capability_id: "research.source_collect",
        capability_version_id: null,
        capability_enablement_id: "enable-1",
        capability: { source_kind: "builtin" },
        enablement_config_json: { source_mode: "project_sources" },
      });

      const rendered = renderRuntimeSkillCandidate(candidates[0]!);
      expect(rendered?.rendered.files.map((file) => file.path)).toContain(
        ".rainver/generated-skills/codex/research-source-collect/SKILL.md",
      );
      expect(db.queries.find((sql) => sql.includes("JOIN capability_runtime_bindings")))
        .toContain("se.capability_version_id IS NOT NULL");
    });
  });
});

const provisioningDb = useTestDatabase(import.meta.filename);

describe("Server runtime provisioning against PostgreSQL", () => {
  beforeEach(async () => {
    if (!provisioningDb.available || !provisioningDb.pool) return;
    await resetTables(provisioningDb.pool, [
      "host_runtime_provisioning",
      "agent_runtime_profiles",
      "agent_versions",
      "agents",
      "hosts",
      "machines",
      "projects",
      "space_memberships",
      "users",
      "spaces",
    ], { cascade: true });
    const { now } = await seedSpaceOwnerProject(provisioningDb.pool, {
      space: "91111111-1111-4111-8111-111111111111",
      owner: "92222222-2222-4222-8222-222222222222",
      project: "93333333-3333-4333-8333-333333333333",
    });
    await seedServerHost(provisioningDb.pool, {
      id: "97777777-7777-4777-8777-777777777777",
      now,
      installations: {},
    });
    await seedAgentWithVersion(provisioningDb.pool, {
      agent: "94444444-4444-4444-8444-444444444444",
      version: "95555555-5555-4555-8555-555555555555",
      space: "91111111-1111-4111-8111-111111111111",
      owner: "92222222-2222-4222-8222-222222222222",
      seedDefaultRuntimeProfile: false,
      now,
    });
    await provisioningDb.pool.query(
      `INSERT INTO agent_runtime_profiles (
       id,
       space_id,
       agent_id,
       name,
       runtime_key,
       backend_mode,
       execution_host_id,
       workspace_mode,
       runtime_installation,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES (
       $1,
       $2,
       $3,
       'Default',
       'opencode',
       'runtime_native',
       $4,
       'managed',
       'managed:pending',
       '{}'::jsonb,
       '{}'::jsonb,
       true,
       true,
       $5,
       $5
     )`,
      [
        "96666666-6666-4666-8666-666666666666",
        "91111111-1111-4111-8111-111111111111",
        "94444444-4444-4444-8444-444444444444",
        "97777777-7777-4777-8777-777777777777",
        now,
      ],
    );
    await provisioningDb.pool.query(
      `INSERT INTO agent_runtime_profiles (
       id,
       space_id,
       agent_id,
       name,
       runtime_key,
       backend_mode,
       execution_host_id,
       workspace_mode,
       runtime_installation,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES (
       $1,
       $2,
       $3,
       'Pinned old runtime',
       'opencode',
       'runtime_native',
       $4,
       'managed',
       'managed:1.0.0',
       '{}'::jsonb,
       '{}'::jsonb,
       true,
       false,
       $5,
       $5
     )`,
      [
        "96666666-6666-4666-8666-666666666667",
        "91111111-1111-4111-8111-111111111111",
        "94444444-4444-4444-8444-444444444444",
        "97777777-7777-4777-8777-777777777777",
        now,
      ],
    );
  });

  it("claims atomically, keeps failures sticky, and switches Profiles only after a healthy activation", async (ctx) => {
    if (!provisioningDb.available || !provisioningDb.pool) return ctx.skip();
    const pool = provisioningDb.pool;
    const hostId = "97777777-7777-4777-8777-777777777777";
    const profileId = "96666666-6666-4666-8666-666666666666";
    const pinnedProfileId = "96666666-6666-4666-8666-666666666667";
    const repository = new PgRuntimeProvisioningRepository(pool);

    const initial = await repository.ensureDesired(hostId, "opencode", "1.0.0");
    expect(initial).toMatchObject({ state: "queued", desired_version: "1.0.0", installed_version: null });
    const claims = await Promise.all([
      repository.claim(hostId, "opencode", "1.0.0"),
      repository.claim(hostId, "opencode", "1.0.0"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ state: "installing", attempts: 1 });

    await repository.fail(hostId, "opencode", "1.0.0", "installer failed");
    expect((await repository.ensureDesired(hostId, "opencode", "1.0.0")).state).toBe("failed");
    expect(await repository.retry(hostId, "opencode", "1.0.0")).toMatchObject({ state: "queued" });
    expect(await repository.retry(hostId, "opencode", "1.0.0")).toBeNull();
    expect(await repository.claim(hostId, "opencode", "1.0.0")).toMatchObject({ state: "installing", attempts: 2 });
    await repository.complete(hostId, "opencode", "1.0.0");

    expect((await repository.get(hostId, "opencode"))?.state).toBe("ready");
    expect((await pool.query<{ runtime_installation: string }>(
      `SELECT runtime_installation FROM agent_runtime_profiles WHERE id = $1`, [profileId],
    )).rows).toEqual([{ runtime_installation: "managed:1.0.0" }]);

    await repository.ensureDesired(hostId, "opencode", "2.0.0");
    expect((await repository.get(hostId, "opencode"))?.installed_version).toBe("1.0.0");
    await repository.claim(hostId, "opencode", "2.0.0");
    await repository.fail(hostId, "opencode", "2.0.0", "health check failed");
    expect((await repository.get(hostId, "opencode"))?.installed_version).toBe("1.0.0");
    expect((await pool.query<{ runtime_installation: string }>(
      `SELECT runtime_installation FROM agent_runtime_profiles WHERE id = $1`, [profileId],
    )).rows).toEqual([{ runtime_installation: "managed:1.0.0" }]);

    await repository.retry(hostId, "opencode", "2.0.0");
    await repository.claim(hostId, "opencode", "2.0.0");
    await repository.complete(hostId, "opencode", "2.0.0");
    expect((await pool.query<{ runtime_installation: string }>(
      `SELECT runtime_installation FROM agent_runtime_profiles
        WHERE id = ANY($1::varchar[]) ORDER BY id`, [[profileId, pinnedProfileId]],
    )).rows).toEqual([
      { runtime_installation: "managed:2.0.0" },
      { runtime_installation: "managed:1.0.0" },
    ]);
    expect((await pool.query<{ from_version: string | null; to_version: string }>(
      `SELECT from_version, to_version FROM host_runtime_changes
        WHERE host_id = $1 AND runtime_key = 'opencode' ORDER BY to_version`, [hostId],
    )).rows).toEqual([
      { from_version: null, to_version: "1.0.0" },
      { from_version: "1.0.0", to_version: "2.0.0" },
    ]);
    await repository.complete(hostId, "opencode", "2.0.0");
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM host_runtime_changes
        WHERE host_id = $1 AND runtime_key = 'opencode'`, [hostId],
    )).rows[0]?.count).toBe("2");
  });

  it("replaces the interruption placeholder with the daemon's own error, and keeps a settled failure", async (ctx) => {
    if (!provisioningDb.available || !provisioningDb.pool) return ctx.skip();
    const repository = new PgRuntimeProvisioningRepository(provisioningDb.pool);
    const hostId = "97777777-7777-4777-8777-777777777777";

    await repository.ensureDesired(hostId, "opencode", "1.0.0");
    await repository.claim(hostId, "opencode", "1.0.0");
    await repository.failInterrupted(hostId, "opencode", "1.0.0");
    expect((await repository.get(hostId, "opencode"))?.error).toBe(INTERRUPTED_INSTALL_ERROR);

    // The owner was still waiting on the daemon when another process gave its
    // claim up for lost. Its answer is the real diagnosis; the placeholder was
    // a guess, so it must not outlive it.
    await repository.fail(hostId, "opencode", "1.0.0", "daemon reported\na sha256\tmismatch");
    expect(await repository.get(hostId, "opencode")).toMatchObject({
      state: "failed",
      error: "daemon reported a sha256 mismatch",
    });

    // A settled failure is still sticky: only an explicit retry reopens it.
    await repository.fail(hostId, "opencode", "1.0.0", "a later straggler");
    expect((await repository.get(hostId, "opencode"))?.error).toBe("daemon reported a sha256 mismatch");
  });

  it("heartbeats an in-flight install so no other process fails it out from under its owner", async (ctx) => {
    if (!provisioningDb.available || !provisioningDb.pool) return ctx.skip();
    const pool = provisioningDb.pool;
    const hostId = "97777777-7777-4777-8777-777777777777";
    const repository = new PgRuntimeProvisioningRepository(pool);

    let release: (result: { ok: boolean; error: string | null; installation: string | null }) => void = () => {};
    const daemonAnswer = new Promise<{ ok: boolean; error: string | null; installation: string | null }>(
      (resolve) => { release = resolve; },
    );
    const registry = {
      isOnline: vi.fn(() => true),
      requestToolAction: vi.fn(() => daemonAnswer),
    } as unknown as HostConnectionRegistry;
    const provisioner = new ServerOpenCodeProvisioner(pool, registry);

    const inFlight = provisioner.reconcile();
    await vi.waitFor(async () => {
      expect((await repository.get(hostId, "opencode"))?.state).toBe("installing");
    });

    // An install that legitimately outlasts the staleness window.
    await pool.query(
      `UPDATE host_runtime_provisioning SET last_attempt_at = now() - interval '30 minutes'
        WHERE host_id = $1 AND runtime_key = 'opencode'`,
      [hostId],
    );
    await provisioner.reconcile();
    const beaten = await repository.get(hostId, "opencode");
    expect(beaten?.state).toBe("installing");
    expect(Date.now() - Date.parse(beaten!.last_attempt_at!)).toBeLessThan(60_000);

    // A second Server process runs its own provisioner; it may not declare
    // this process's claim interrupted.
    await new ServerOpenCodeProvisioner(pool, registry).reconcile();
    expect((await repository.get(hostId, "opencode"))?.state).toBe("installing");

    release({ ok: false, error: "the daemon could not verify the download", installation: null });
    await inFlight;
    expect(await repository.get(hostId, "opencode")).toMatchObject({
      state: "failed",
      error: "the daemon could not verify the download",
    });
  });

  it("keeps a retry-initiated install heartbeated by wakening the one process-wide provisioner", async (ctx) => {
    if (!provisioningDb.available || !provisioningDb.pool) return ctx.skip();
    const pool = provisioningDb.pool;
    const hostId = "97777777-7777-4777-8777-777777777777";
    const repository = new PgRuntimeProvisioningRepository(pool);
    __resetSharedServerOpenCodeProvisionerForTests();

    let release: (result: { ok: boolean; error: string | null; installation: string | null }) => void = () => {};
    const daemonAnswer = new Promise<{ ok: boolean; error: string | null; installation: string | null }>(
      (resolve) => { release = resolve; },
    );
    const registry = {
      isOnline: vi.fn(() => true),
      requestToolAction: vi.fn(() => daemonAnswer),
    } as unknown as HostConnectionRegistry;
    // The scheduler builds the shared instance at startup.
    const scheduled = sharedServerOpenCodeProvisioner(pool, { registry });

    // The admin retry route asks for the provisioner with only the pool it
    // holds, and must be handed that same instance — a one-shot instance's
    // claim is heartbeated by nobody.
    const fromRetryRoute = sharedServerOpenCodeProvisioner(pool);
    expect(fromRetryRoute).toBe(scheduled);

    const inFlight = fromRetryRoute.reconcile();
    await vi.waitFor(async () => {
      expect((await repository.get(hostId, "opencode"))?.state).toBe("installing");
    });

    // The install outlasts the staleness window; the scheduler's 15s tick is
    // the same instance, so it heartbeats its own claim instead of failing it.
    await pool.query(
      `UPDATE host_runtime_provisioning SET last_attempt_at = now() - interval '30 minutes'
        WHERE host_id = $1 AND runtime_key = 'opencode'`,
      [hostId],
    );
    await scheduled.reconcile();
    const beaten = await repository.get(hostId, "opencode");
    expect(beaten?.state).toBe("installing");
    expect(Date.now() - Date.parse(beaten!.last_attempt_at!)).toBeLessThan(60_000);

    release({ ok: true, error: null, installation: `managed:${SERVER_OPENCODE_RELEASE.version}` });
    await inFlight;
    __resetSharedServerOpenCodeProvisionerForTests();
  });

  it("installs only on the built-in Host and leaves the verified copy active after an upgrade failure", async (ctx) => {
    if (!provisioningDb.available || !provisioningDb.pool) return ctx.skip();
    const pool = provisioningDb.pool;
    const hostId = "97777777-7777-4777-8777-777777777777";
    const profileId = "96666666-6666-4666-8666-666666666666";
    const remoteHostId = "98888888-8888-4888-8888-888888888888";
    const remoteMachineId = "99999999-9999-4999-8999-999999999999";
    const now = new Date().toISOString();
    await pool.query(
      `UPDATE hosts SET capabilities_json = $2::jsonb WHERE id = $1`,
      [hostId, JSON.stringify({ installations: { opencode: [{
        id: "managed:1.0.0", version: "1.0.0", logged_in: false,
        options: null, health_check_protocol: "acp",
      }] } })],
    );
    await pool.query(
      `UPDATE agent_runtime_profiles SET runtime_installation = 'managed:1.0.0'
        WHERE id = $1`,
      [profileId],
    );
    await pool.query(
      `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
       VALUES ($1, $2, 'Paired test machine', 'desktop', $3, $3)`,
      [remoteMachineId, "92222222-2222-4222-8222-222222222222", now],
    );
    await pool.query(
      `INSERT INTO hosts (
         id, owner_user_id, machine_id, name, kind, environment_kind, status,
         capabilities_json, created_at, updated_at
       ) VALUES ($1, $2, $3, 'Paired test host', 'remote', 'linux_native', 'online', $4::jsonb, $5, $5)`,
      [remoteHostId, "92222222-2222-4222-8222-222222222222", remoteMachineId, JSON.stringify({
        installations: { opencode: [{
          id: "managed:1.0.0", version: "1.0.0", logged_in: false,
          options: null, health_check_protocol: "acp",
        }] },
      }), now],
    );

    const requestToolAction = vi.fn().mockResolvedValue({ ok: false, error: "health check failed" });
    const registry = {
      isOnline: vi.fn(() => true),
      requestToolAction,
    } as unknown as HostConnectionRegistry;
    const provisioner = new ServerOpenCodeProvisioner(pool, registry);

    await provisioner.reconcile();
    await provisioner.reconcile();

    expect(registry.isOnline).toHaveBeenCalledExactlyOnceWith(hostId);
    expect(requestToolAction).toHaveBeenCalledExactlyOnceWith(hostId, "install_tool", expect.objectContaining({
      runtime_key: "opencode",
      version: SERVER_OPENCODE_RELEASE.version,
      health_check_protocol: "acp",
    }));
    expect(await new PgRuntimeProvisioningRepository(pool).get(hostId, "opencode")).toMatchObject({
      state: "failed",
      desired_version: SERVER_OPENCODE_RELEASE.version,
      installed_version: "1.0.0",
    });
    expect((await pool.query<{ runtime_installation: string }>(
      `SELECT runtime_installation FROM agent_runtime_profiles WHERE id = $1`, [profileId],
    )).rows).toEqual([{ runtime_installation: "managed:1.0.0" }]);
    expect((await pool.query(
      `SELECT 1 FROM host_runtime_provisioning WHERE host_id = $1 AND runtime_key = 'opencode'`, [remoteHostId],
    )).rows).toEqual([]);
  });
});
