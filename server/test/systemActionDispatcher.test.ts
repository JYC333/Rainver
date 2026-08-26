import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimeHostExecuteRequest,
  SystemActionDefinition,
  SystemActionId,
} from "@agent-space/protocol";
import { loadConfig } from "../src/config.js";
import type { RunRecord } from "../src/modules/runs/repository.js";

const registryState = vi.hoisted(() => ({
  registry: new Map<SystemActionId, SystemActionDefinition>(),
}));

vi.mock("../src/modules/systemActions/registry.js", () => ({
  loadSystemActionRegistry: async () => registryState.registry,
}));

import * as protocol from "@agent-space/protocol";
import { SystemActionDispatcher } from "../src/modules/systemActions/systemActionDispatcher.js";

describe("SystemActionDispatcher tool binding projection", () => {
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

  it("derives research binding side effects and approval metadata from the registry", async () => {
    const run = {
      id: "run-research-1",
      space_id: "space-1",
      agent_id: "agent-1",
      agent_version_id: "version-1",
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
      adapter_type: "model_api",
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
    } as RunRecord;

    const dispatcher = await SystemActionDispatcher.create(
      loadConfig({}),
      run,
      {} as RuntimeHostExecuteRequest,
    );

    expect(dispatcher.researchBindings).toEqual([
      expect.objectContaining({
        id: "research.start_acquisition",
        side_effect_level: "proposal",
        approval_required: true,
      }),
    ]);
  });
});
