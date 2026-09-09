import { describe, expect, it } from "vitest";
import { PgRuntimeSkillProvider, renderRuntimeSkillCandidate } from "../src/modules/capabilities/runtimeSkillProvider.js";
import type { Queryable, QueryResult } from "../src/modules/routeUtils/common.js";
import { normalizeVendorEvents } from "../src/modules/runs/runtimeEventNormalization.js";
import { getLocalCliRuntimeAdapterSpec, getRuntimeAdapterSpec, isVendorCliAdapter, listRuntimeAdapterSpecs } from "../src/modules/runtimeAdapters/specs.js";

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
        ".rainver/generated-skills/codex/research-source-collect/SKILL.md",
      );
      expect(db.queries.find((sql) => sql.includes("JOIN capability_runtime_bindings")))
        .toContain("se.capability_version_id IS NOT NULL");
    });
  });
});


