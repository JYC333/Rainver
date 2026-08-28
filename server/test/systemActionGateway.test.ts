import { describe, expect, it, vi } from "vitest";
import { SYSTEM_ACTION_REGISTRY, systemActionInputJsonSchema } from "@rainver/protocol";
import type { SystemActionDefinition, SystemActionId, SystemActionPolicyResource } from "@rainver/protocol";
import { SystemActionGateway } from "../src/modules/systemActions/gateway.js";
import { resolveDeclaredResourceId } from "../src/modules/systemActions/systemActionDispatcher.js";
import { ROOM_CONVERSATION_TOOL_ALLOWANCE } from "../src/modules/systemActions/scenarioToolAllowance.js";
import type { RunRecord } from "../src/modules/runs/repository.js";

const context = {
  actor: { type: "agent" as const, space_id: "space-1", agent_id: "agent-1", run_id: "run-1" },
  visibility: "agent_tool" as const,
};

describe("SystemActionGateway", () => {
  it("fails closed for unknown and non-visible actions", async () => {
    const gateway = new SystemActionGateway(new Map(), async () => ({ allowed: true }));
    await expect(gateway.dispatch("missing.action.read", {}, context)).rejects.toMatchObject({ code: "unknown_system_action" });
    await expect(gateway.dispatch("source.recipe.activate", {}, context)).rejects.toMatchObject({ code: "system_action_actor_denied" });
  });

  it("enforces policy on every dispatch and validates output", async () => {
    const execute = vi.fn(async () => ({ items: [] }));
    const enforce = vi.fn(async () => ({ allowed: true, policy_decision_record_id: "decision-1" }));
    const gateway = new SystemActionGateway(
      new Map([["retrieval.search" as SystemActionId, execute]]),
      enforce,
    );
    const result = await gateway.dispatch("retrieval.search", { query: "test" }, context);
    expect(result.policy_decision_record_id).toBe("decision-1");
    expect(enforce).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns a failed dispatch when policy denies", async () => {
    const execute = vi.fn();
    const onFailed = vi.fn();
    const gateway = new SystemActionGateway(
      new Map([["retrieval.search" as SystemActionId, execute]]),
      async () => ({ allowed: false, reason: "denied",policy_decision_record_id:"decision-denied" }),
      { onFailed },
    );
    await expect(gateway.dispatch("retrieval.search", {}, context)).rejects.toMatchObject({ code: "system_action_policy_denied" });
    expect(execute).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({id:"retrieval.search"}),expect.objectContaining({code:"system_action_policy_denied"}),context);
    expect(onFailed.mock.calls[0]?.[1]).toMatchObject({policy_decision_record_id:"decision-denied"});
  });

  it("distinguishes an approval pause from a policy denial", async () => {
    const execute = vi.fn();
    const gateway = new SystemActionGateway(
      new Map([["retrieval.search" as SystemActionId, execute]]),
      async () => ({
        allowed: false,
        reason: "Review required",
        policy_decision_record_id: "decision-review",
        details: { status: "require_approval", error_code: "policy_requires_approval" },
      }),
    );

    await expect(gateway.dispatch("retrieval.search", {}, context)).rejects.toMatchObject({
      code: "system_action_approval_required",
      policy_decision_record_id: "decision-review",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires the canonical tool-call id for side-effecting actions", async () => {
    const gateway = new SystemActionGateway(new Map(), async () => ({ allowed: true }));
    await expect(gateway.dispatch(
      "source.channel.propose_activation",
      { provider_key: "rss", name: "Feed", query: {}, endpoint_url: "https://example.test/feed" },
      context,
    )).rejects.toMatchObject({ code: "system_action_idempotency_required" });
  });

  it("derives tool-call JSON schemas for the Room Inquiry proposal actions from the Zod that validates them", async () => {
    const definitionFor = (id: string): SystemActionDefinition => {
      const found = SYSTEM_ACTION_REGISTRY.find((definition) => definition.id === id);
      if (!found) throw new Error(`Missing system action definition: ${id}`);
      return found;
    };

    const projectDefinition = systemActionInputJsonSchema(definitionFor("project.propose_definition"));
    expect(projectDefinition.required).toEqual(["goal"]);
    expect(projectDefinition.properties).toMatchObject({
      goal: { type: "string" },
      success_definition: { type: "string" },
    });

    const createThread = systemActionInputJsonSchema(definitionFor("inquiry.create_thread"));
    expect(createThread.required).toEqual(["statement"]);
    expect(createThread.properties).toMatchObject({
      kind: { type: "string" },
      statement: { type: "string" },
      resolution_criteria: { type: "string" },
    });

    const conclusion = systemActionInputJsonSchema(definitionFor("inquiry.record_conclusion"));
    expect(conclusion.required).toEqual(["thread_id", "change_summary"]);
    expect(conclusion.properties).toMatchObject({
      thread_id: { type: "string" },
      change_summary: { type: "string" },
      evaluation_state: { type: "string" },
      answer_state: { type: "string" },
    });

    const promote = systemActionInputJsonSchema(definitionFor("inquiry.promote_knowledge"));
    expect(promote.required).toEqual(["thread_id", "candidate_kind", "proposed_title", "proposed_content"]);
    expect(promote.properties).toMatchObject({
      thread_id: { type: "string" },
      candidate_kind: { type: "string" },
      proposed_title: { type: "string" },
      proposed_content: { type: "string" },
    });
  });

  it("resolves declarative policy resource ids the same way the four eliminated branches did (D4)", () => {
    const run = { id: "run-1", project_id: "project-1" } as RunRecord;
    const runWithoutProject = { id: "run-1", project_id: null } as RunRecord;

    // authorization.request / agent.wait_for_results shape: no input field, run fallback.
    const runFallback: SystemActionPolicyResource = { resource_id_fallback: "run", check_action_approval_grant: false };
    expect(resolveDeclaredResourceId(runFallback, {}, run)).toBe("run-1");

    // task.plan.propose / source.backfill.propose_start / research.start_acquisition
    // shape: input-derived id, run fallback when absent.
    const inputWithRunFallback: SystemActionPolicyResource = {
      resource_id_input_field: "task_id",
      resource_id_fallback: "run",
      check_action_approval_grant: true,
    };
    expect(resolveDeclaredResourceId(inputWithRunFallback, { task_id: "task-9" }, run)).toBe("task-9");
    expect(resolveDeclaredResourceId(inputWithRunFallback, {}, run)).toBe("run-1");
    expect(resolveDeclaredResourceId(inputWithRunFallback, { task_id: "" }, run)).toBe("run-1");
    expect(resolveDeclaredResourceId(inputWithRunFallback, { task_id: 42 }, run)).toBe("run-1");

    // The six unoverridden proposalAction shape: no input field, project-or-run fallback.
    const projectOrRunFallback: SystemActionPolicyResource = { resource_id_fallback: "project_or_run", check_action_approval_grant: true };
    expect(resolveDeclaredResourceId(projectOrRunFallback, {}, run)).toBe("project-1");
    expect(resolveDeclaredResourceId(projectOrRunFallback, {}, runWithoutProject)).toBe("run-1");
  });

  it("derives the source.channel.propose_activation schema as creation parameters, not a channel reference", async () => {
    // The service begins with `this.create(identity, { ...body, status: "paused" })` —
    // the body is Source Channel creation parameters. Only `provider_key` is
    // required; the old hand-written schema and the pre-fix Zod disagreed with
    // each other and both disagreed with the service (D5).
    const definition = SYSTEM_ACTION_REGISTRY.find((candidate) => candidate.id === "source.channel.propose_activation");
    if (!definition) throw new Error("Missing system action definition: source.channel.propose_activation");
    const schema = systemActionInputJsonSchema(definition);
    expect(schema.required).toEqual(["provider_key"]);
    expect(schema.properties).toMatchObject({
      provider_key: { type: "string" },
      name: { type: "string" },
      endpoint_url: { type: "string" },
    });
    // `query` is nullable (SourceChannelService.createLocked reads it through
    // `objectValue`, which tolerates `null`) — a nullable Zod field compiles
    // to a `type`/`null` union in JSON Schema rather than a flat object type.
    expect((schema.properties as Record<string, { anyOf?: Array<{ type?: string }> }>).query.anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "object" }), expect.objectContaining({ type: "null" })]),
    );
  });

  it("offers the Thread creation action to Room conversations", () => {
    expect(ROOM_CONVERSATION_TOOL_ALLOWANCE).toContain("project.propose_definition");
    expect(ROOM_CONVERSATION_TOOL_ALLOWANCE).toContain("inquiry.create_thread");
  });
});
