import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { PgRuntimeSkillProvider, renderRuntimeSkillCandidate } from "../src/modules/capabilities/runtimeSkillProvider.js";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common.js";
import type { CliExecutionResult } from "../src/modules/runs/localCliExecution.js";
import { normalizeVendorEvents } from "../src/modules/runs/runtimeEventNormalization.js";
import { getLocalCliRuntimeAdapterSpec, getRuntimeAdapterSpec, isVendorCliAdapter, listRuntimeAdapterSpecs } from "../src/modules/runtimeAdapters/specs.js";
import { CONFORMANCE_CHECKS, type ConformanceCheck, RuntimeConformanceService } from "../src/modules/runtimeConformance/service.js";
import { LocalCliConformanceProbeRunner, type LocalCliConformanceProbeRunnerDeps } from "../src/modules/runtimeConformance/probeRunner.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("runtimeAdapters", () => {
  describe("runtime adapter catalog", () => {
    it("keeps model-provider credentials separate from local CLI login state", () => {
      const specs = listRuntimeAdapterSpecs();
      const modelProviderSpecs = specs.filter(
        (spec) => spec.credentials.credential_mode === "model_provider_api_key",
      );
      expect(modelProviderSpecs.map((spec) => spec.adapter_type).sort()).toEqual([
        "model_api",
        "ts_agent_host",
      ]);

      for (const spec of specs.filter((item) => item.runtime_kind === "local_cli")) {
        if (spec.adapter_type !== "opencode") expect(spec.model.model_provider_mode).toBe("none");
        expect(["cli_profile", "cli_profile_or_model_provider"]).toContain(spec.credentials.credential_mode);
        expect(spec.credentials.credential_runtime_name).toBe(spec.adapter_type);
      }
    });

    it("exposes only implemented local CLI adapters as executable vendor CLIs", () => {
      expect(isVendorCliAdapter("claude_code")).toBe(true);
      expect(isVendorCliAdapter("codex_cli")).toBe(true);
      expect(isVendorCliAdapter("opencode")).toBe(true);
      expect(isVendorCliAdapter("gemini_cli")).toBe(false);
      expect(getLocalCliRuntimeAdapterSpec("opencode")?.implementation_status).toBe("implemented");
    });

    it("owns adapter execution semantics outside providers", () => {
      expect(getRuntimeAdapterSpec("model_api")?.runtime_kind).toBe("managed_api");
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
            { path: ["default_agent"], value: "agent-space-locked", value_mode: "exact" },
            { path: ["subagent_depth"], value: 0, value_mode: "exact" },
            { path: ["agent", "agent-space-locked", "mode"], value: "primary", value_mode: "exact" },
          ]),
        },
      });
    });
  });
});

describe("runtimeConformanceDb", () => {
  const db = useTestDatabase(`${`${import.meta.filename}#runtimeConformanceGroup`}#runtimeConformanceDb`, { max: 2 });

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(db.pool, ["runtime_conformance_results"]);
  });

  function allChecks(passed: boolean) {
    return Object.fromEntries(CONFORMANCE_CHECKS.map((check) => [check, { passed }])) as Record<ConformanceCheck, { passed: boolean }>;
  }

  describe("runtime conformance persistence (real Postgres)", () => {
    it("persists a failed result fail-closed, then replaces it with a complete pass", async () => {
      if (!db.available) return;
      const service = new RuntimeConformanceService(db.pool);
      const failed = await service.record({
        runtime_adapter_type: "opencode",
        runtime_version: "1.0.0",
        checks: { ...allChecks(true), credential_leakage: { passed: false, evidence: { leak: "detected" } } },
      });
      expect(failed).toMatchObject({ status: "partial", passed_checks: 4, failed_checks: 1, trust_level: "low" });

      const passed = await service.record({
        runtime_adapter_type: "opencode",
        runtime_version: "1.0.0",
        checks: allChecks(true),
      });
      expect(passed).toMatchObject({ status: "passed", passed_checks: 5, failed_checks: 0, trust_level: "low" });
      expect(await service.list("opencode")).toHaveLength(1);
    });

    it("records runner exceptions as failed checks instead of granting trust", async () => {
      if (!db.available) return;
      const result = await new RuntimeConformanceService(db.pool).run({
        runtime_adapter_type: "opencode",
        runtime_version: "1.0.0",
        runner: {
          async runCheck(check) {
            if (check === "file_scope_obedience") throw new Error("probe unavailable");
            return { passed: true };
          },
        },
      });
      expect(result).toMatchObject({ status: "partial", passed_checks: 4, failed_checks: 1, trust_level: "low" });
      expect(result.checks.file_scope_obedience).toMatchObject({ passed: false });
    });
  });
});

describe("runtimeConformanceProbe", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  describe("LocalCliConformanceProbeRunner", () => {
    it("runs the structured-output and credential-leakage probes through the executor boundary", async () => {
      const root = await mkdtemp(join(tmpdir(), "aspace-conformance-"));
      roots.push(root);
      const executor = {
        async runCommand(input: { command: string[]; cwd: string | null }): Promise<CliExecutionResult> {
          expect(input.cwd).toContain(join(root, "sandboxes", "conformance"));
          return {
            returncode: 0,
            stdout: '{"result":"PASS"}\n',
            stderr: "",
            timed_out: false,
          };
        },
      };
      const deps: LocalCliConformanceProbeRunnerDeps = {
        executor,
        toolRegistry: {
          async resolveForExecution(runtime) {
            return {
              runtime,
              executable_path: join(root, "runtime-tools", "opencode"),
              version: "1.0.0",
              source: "npm",
              package_name: "opencode-ai",
            };
          },
        },
        credentialBroker: {
          async grantForRun(runId, spaceId, runtime, executorMode) {
            expect(runId).toContain("conformance-");
            expect(spaceId).toBe("space-1");
            expect(runtime).toBe("opencode");
            expect(executorMode).toBe("worktree");
            return {
              granted: true,
              profile_id: "profile-1",
              runtime,
              executor_mode: executorMode,
              readonly: true,
              temp_home: null,
              host_source_path: null,
              target_path: null,
              env: {},
              network_profile_id: null,
              fallback_reason: null,
            };
          },
          async cleanupRunHome() {},
        },
      };
      const runner = new LocalCliConformanceProbeRunner(
        loadConfig({ AGENT_SPACE_HOME: root }),
        { spaceId: "space-1", userId: "user-1" },
        deps,
      );
      const context = {
        runtime_adapter_type: "opencode",
        runtime_version: "1.0.0",
        suite_version: "runtime_conformance.v1",
      } as const;

      await expect(runner.runCheck("structured_output_compliance", context)).resolves.toMatchObject({ passed: true });
      await expect(runner.runCheck("credential_leakage", context)).resolves.toMatchObject({ passed: true });
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
        adapter_type: "codex_cli",
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
        ".agent-space/generated-skills/codex/research-source-collect/SKILL.md",
      );
      expect(db.queries.find((sql) => sql.includes("JOIN capability_runtime_bindings")))
        .toContain("se.capability_version_id IS NOT NULL");
    });
  });
});
