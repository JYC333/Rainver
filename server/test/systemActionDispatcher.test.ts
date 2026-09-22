import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SystemActionDefinition,
  SystemActionId,
} from "@rainver/protocol";
import { loadConfig } from "../src/config.js";
import type { AgentRunRecord } from "../src/modules/runs/repository.js";

const registryState = vi.hoisted(() => ({
  registry: new Map<SystemActionId, SystemActionDefinition>(),
}));

vi.mock("../src/modules/systemActions/registry.js", () => ({
  loadSystemActionRegistry: async () => registryState.registry,
}));

import * as protocol from "@rainver/protocol";
import type { CanonicalToolCall } from "@rainver/protocol";
import { SystemActionDispatcher } from "../src/modules/systemActions/systemActionDispatcher.js";

describe("SystemActionDispatcher ACP tool projection", () => {
  beforeEach(async () => {
    const research = protocol.SYSTEM_ACTION_REGISTRY.find(
      (definition) => definition.id === "research.start_acquisition",
    )!;
    registryState.registry = new Map([[research.id as SystemActionId, {
      ...research,
      side_effects: "proposal",
      proposal_type: "test_research_proposal",
      grantable: true,
    }]]);
  });

  function testRun(): AgentRunRecord {
    return {
      id: "run-research-1",
      space_id: "space-1",
      agent_id: "agent-1",
      agent_version_id: "version-1",
      execution_kind: "agent",
      runtime_key: "opencode",
      run_type: "agent",
      status: "running",
      mode: "live",
      prompt: "Start research.",
      instruction: "Start research.",
      project_folder_id: null,
      session_id: null,
      parent_run_id: null,
      root_run_id: null,
      run_group_id: null,
      delegation_id: null,
      project_id: "project-1",
      scheduled_at: null,
      capability_id: null,
      capabilities_json: ["research.start_acquisition"],
      model_provider_id: "provider-1",
      model_override_json: null,
      runtime_profile_snapshot_json: {},
      required_sandbox_level: "none",
      trigger_origin: "manual",
      instructed_by_user_id: "user-1",
      instructed_by_agent_id: null,
      error_message: null,
      error_json: null,
      output_json: null,
      started_at: null,
      ended_at: null,
      created_at: "2026-08-24T00:00:00.000Z",
      updated_at: "2026-08-24T00:00:00.000Z",
      visibility: "space_shared",
      permission_snapshot_json: {
        tool_grants: [{ action_id: "research.start_acquisition" }],
      },
    } as AgentRunRecord;
  }

  it("exposes only granted research actions as ACP tool definitions", async () => {
    const run = testRun();

    const dispatcher = await SystemActionDispatcher.create(
      loadConfig({}),
      run
    );

    expect(dispatcher.researchDefinitions.map((tool) => tool.name)).toEqual(["research.start_acquisition"]);
  });

  it("records a failed action_completed event when a Run calls a tool it was never granted", async () => {
    // Without this event `governedToolDegradation` sees nothing and a Run that
    // asked for a tool it never held finishes clean.
    const events: Array<{
      eventType: string;
      call: CanonicalToolCall;
      metadata?: Record<string, unknown>;
    }> = [];

    const dispatcher = await SystemActionDispatcher.create(loadConfig({}), testRun(), {
      actionEventSink: async (eventType, call, metadata) => {
        events.push({ eventType, call, metadata });
      },
    });

    const result = await dispatcher.dispatch({
      id: "call-ungranted-1",
      name: "memory.propose",
      arguments_json: "{}",
    });

    expect(result.modelResult).toMatchObject({
      ok: false,
      tool: "memory.propose",
      error_code: "system_action_not_granted",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "action_completed",
      // `defaultActionEventSink` derives `status: "failed"` from `ok === false`
      // and `metadata_json.action_id` from the call name, which is exactly what
      // `governedToolDegradation` reads back.
      call: { id: "call-ungranted-1", name: "memory.propose" },
      metadata: { ok: false, error_code: "system_action_not_granted" },
    });
  });
});
