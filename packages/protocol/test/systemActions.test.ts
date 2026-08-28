import { describe, expect, it } from "vitest";
import { POLICY_ACTION_REGISTRY, SYSTEM_ACTION_GATE_CLASSES, SYSTEM_ACTION_REGISTRY, SystemActionDefinitionSchema } from "../src/index.js";
import type { SystemActionDefinition } from "../src/index.js";

describe("SYSTEM_ACTION_REGISTRY", () => {
  const policyById = new Map(POLICY_ACTION_REGISTRY.map((definition) => [definition.action, definition]));

  it("has unique normalized ids and valid policy links", () => {
    const ids = SYSTEM_ACTION_REGISTRY.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of SYSTEM_ACTION_REGISTRY) {
      expect(definition.id).toMatch(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/);
      expect(policyById.has(definition.policy_action)).toBe(true);
      expect(SystemActionDefinitionSchema.safeParse(definition).success).toBe(true);
      if(!["authorization.request","source.channel.propose_activation","project.source.propose_bind","project.propose_definition","source.backfill.propose_start","task.plan.propose","inquiry.create_thread","inquiry.record_conclusion","inquiry.promote_knowledge","research.start_acquisition","research.cancel_acquisition","agent.delegate","task.create","task.report","task.handoff","task.advance_stage","task.request_review","proposal.decide","inquiry.adopt_next_step","memory.remember","memory.revise","artifact.submit"].includes(definition.id))expect(definition.input_schema.safeParse({}).success).toBe(true);
    }
  });

  it("defines concrete contracts for Project Chat proposal actions",()=>{
    const byId=new Map(SYSTEM_ACTION_REGISTRY.map(action=>[action.id,action]));
    expect(byId.get("project.source.propose_bind")!.input_schema.safeParse({}).success).toBe(false);
    expect(byId.get("project.source.propose_bind")!.input_schema.safeParse({source_channel_id:"channel-1"}).success).toBe(true);
    expect(byId.get("source.backfill.propose_start")!.input_schema.safeParse({source_channel_id:"channel-1"}).success).toBe(false);
    expect(byId.get("project.propose_definition")!.input_schema.safeParse({goal:"Define reliable personal memory"}).success).toBe(true);
    expect(byId.get("inquiry.create_thread")!.input_schema.safeParse({ statement: "How should memory retrieval work?" }).success).toBe(true);
  });

  it("validates source.channel.propose_activation as Source Channel creation parameters, not a channel reference (D5)", () => {
    // SourceChannelService.proposeActivation begins with
    // `this.create(identity, { ...body, status: "paused" })` — the body is
    // creation parameters. Before this fix the Zod required `source_channel_id`,
    // a field the model was never told about and that plays no role in
    // creation, so every real call failed input validation before the
    // executor ever ran.
    const byId = new Map(SYSTEM_ACTION_REGISTRY.map((action) => [action.id, action]));
    const schema = byId.get("source.channel.propose_activation")!.input_schema;
    expect(schema.safeParse({ source_channel_id: "channel-1" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ provider_key: "rss" }).success).toBe(true);
    // SourceChannelService.createLocked reads `query` through `objectValue`,
    // which tolerates `null` (coalesces to `{}`) as well as an absent field —
    // the schema must accept both, not just the omitted case.
    expect(schema.safeParse({ provider_key: "rss", query: null }).success).toBe(true);
    expect(schema.safeParse({
      provider_key: "rss",
      name: "Feed",
      query: {},
      endpoint_url: "https://example.test/feed",
    }).success).toBe(true);
  });

  it("validates agent.delegate against the same strict schema as the runtime delegation output path (D8)", async () => {
    // Path A (this tool call) and Path B (an Agent's own structured
    // `delegations` output, materialized post-terminal) both mean "this
    // Agent decided another Agent should do work" — they must validate
    // identically rather than Path A accepting anything.
    const { RuntimeDelegationOutputItemSchema } = await import("../src/agentGroupRuns.js");
    const byId = new Map(SYSTEM_ACTION_REGISTRY.map((action) => [action.id, action]));
    const schema = byId.get("agent.delegate")!.input_schema;
    expect(schema).toBe(RuntimeDelegationOutputItemSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ target_agent_id: "agent-1" }).success).toBe(false);
    expect(schema.safeParse({ target_agent_id: "agent-1", instruction: "Review this." }).success).toBe(true);
    expect(schema.safeParse({
      target_agent_id: "agent-1",
      instruction: "Review this.",
      extra_field: "not part of the contract",
    }).success).toBe(false);
  });

  it("keeps agent tools audited and high-risk direct writes hidden", () => {
    for (const definition of SYSTEM_ACTION_REGISTRY) {
      if (!definition.visibility.has("agent_tool")) continue;
      const policy = policyById.get(definition.policy_action)!;
      expect(policy.audit_required).toBe(true);
      if (policy.default_risk_level === "high" || policy.default_risk_level === "critical") {
        expect(["none", "draft", "proposal"]).toContain(definition.side_effects);
      }
    }
  });

  it("declares an explicit tool surface and policy adapter for every Agent action (D4)", () => {
    // `agent.delegate` and retrieval keep an explicit custom policy adapter —
    // they must carry no `policy_resource`, or the generic adapter would try
    // to handle them too. Every other agent-visible action must declare one,
    // or it silently falls through to "No canonical policy adapter".
    const byId = new Map<string, SystemActionDefinition>(SYSTEM_ACTION_REGISTRY.map((action) => [action.id, action]));
    for (const definition of SYSTEM_ACTION_REGISTRY.filter((action) => action.visibility.has("agent_tool"))) {
      expect(definition.agent_tool_surface, definition.id).toBeDefined();
      expect(definition.policy_adapter, definition.id).toBeDefined();
    }
    expect(byId.get("agent.delegate")!.agent_tool_surface).toBe("delegation");
    expect(byId.get("agent.delegate")!.policy_adapter).toBe("agent_delegate");
    expect(byId.get("agent.wait_for_results")!.agent_tool_surface).toBe("delegation");
    expect(byId.get("agent.wait_for_results")!.policy_adapter).toBe("declared_resource");
    for (const retrievalId of [
      "retrieval.search", "retrieval.brief",
      "memory.retrieval.search", "memory.retrieval.brief",
      "project.summary.search", "project.summary.brief",
      "source.retrieval.search", "source.retrieval.brief",
    ]) {
      expect(byId.get(retrievalId)!.agent_tool_surface, retrievalId).toBe("retrieval");
      expect(byId.get(retrievalId)!.policy_adapter, retrievalId).toBe("retrieval");
    }
    expect(byId.get("agent.delegate")!.policy_resource).toBeUndefined();
    for (const retrievalId of [
      "retrieval.search", "retrieval.brief",
      "memory.retrieval.search", "memory.retrieval.brief",
      "project.summary.search", "project.summary.brief",
      "source.retrieval.search", "source.retrieval.brief",
    ]) {
      expect(byId.get(retrievalId)!.policy_resource, retrievalId).toBeUndefined();
    }

    expect(byId.get("authorization.request")!.policy_resource).toEqual({
      resource_type: "authorization_request",
      resource_id_fallback: "run",
      check_action_approval_grant: false,
    });
    expect(byId.get("agent.wait_for_results")!.policy_resource).toEqual({
      resource_type: "run",
      resource_id_fallback: "run",
      check_action_approval_grant: false,
    });
    expect(byId.get("research.start_acquisition")!.policy_resource).toEqual({
      resource_type: "inquiry_thread",
      resource_id_input_field: "thread_id",
      resource_id_fallback: "run",
      check_action_approval_grant: false,
    });
    expect(byId.get("task.plan.propose")!.policy_resource).toEqual({
      resource_type: "plan",
      resource_id_input_field: "task_id",
      resource_id_fallback: "run",
      check_action_approval_grant: true,
    });
    expect(byId.get("source.backfill.propose_start")!.policy_resource).toEqual({
      resource_type: "source_backfill_plan",
      resource_id_input_field: "source_backfill_plan_id",
      resource_id_fallback: "run",
      check_action_approval_grant: true,
    });
    // The other six proposalAction-built actions take the builder's default:
    // no resource_type override (falls back to owning_module), no
    // input-derived resource_id, project-or-run fallback, grant check on.
    for (const id of [
      "source.channel.propose_activation",
      "project.source.propose_bind",
      "project.propose_definition",
      "inquiry.promote_knowledge",
    ]) {
      const definition = byId.get(id)!;
      expect(definition.policy_resource, id).toEqual({
        resource_id_fallback: "project_or_run",
        check_action_approval_grant: true,
      });
      // Undeclared resource_type falls back to owning_module — assert the
      // fallback actually resolves to a real, non-empty module name.
      expect(definition.policy_resource!.resource_type).toBeUndefined();
      expect(definition.owning_module.length).toBeGreaterThan(0);
    }
  });

  it("rejects a custom-adapter action that also declares policy_resource", () => {
    // A custom adapter never reads policy_resource, so carrying one would be
    // a misleading declaration the runtime silently ignores — the definition
    // schema refuses it at server registry load instead.
    const retrievalAction = SYSTEM_ACTION_REGISTRY.find((action) => action.id === "retrieval.search")!;
    const result = SystemActionDefinitionSchema.safeParse({
      ...retrievalAction,
      policy_resource: { resource_id_fallback: "run", check_action_approval_grant: false },
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.message).toMatch(/must not declare policy_resource/);
  });

  it("uses a strict shared schema for agent.wait_for_results", () => {
    const definition = SYSTEM_ACTION_REGISTRY.find((action) => action.id === "agent.wait_for_results")!;
    expect(definition.input_schema.safeParse({}).success).toBe(true);
    expect(definition.input_schema.safeParse({ scope: "run_ids", run_ids: ["run-1"] }).success).toBe(true);
    expect(definition.input_schema.safeParse({ unexpected: true }).success).toBe(false);
    expect(definition.input_schema.safeParse({ run_ids: [42] }).success).toBe(false);
    expect(definition.input_schema.parse({
      scope: "run_ids",
      run_ids: [" run-1 ", "run-1", "   "],
      target_agent_ids: [" agent-1 ", "agent-1", ""],
      reason: "  Waiting for review.  ",
      resume_instruction: "  Summarize the result.  ",
    })).toEqual({
      scope: "run_ids",
      run_ids: ["run-1"],
      target_agent_ids: ["agent-1"],
      reason: "Waiting for review.",
      resume_instruction: "Summarize the result.",
    });
    expect(definition.input_schema.parse({
      scope: "run_ids",
      run_ids: ["   ", ""],
    })).toEqual({ scope: "run_ids", run_ids: [] });
  });

  it("keeps proposal metadata and visibility internally coherent", () => {
    for (const definition of SYSTEM_ACTION_REGISTRY) {
      expect(definition.side_effects === "proposal").toBe(definition.proposal_type !== null);
      if (definition.visibility.has("internal_only")) {
        expect(definition.visibility.has("public_api")).toBe(false);
      }
      if (definition.id === "source.recipe.activate" || definition.id === "project.source.bind") {
        expect(definition.visibility.has("agent_tool")).toBe(false);
      }
    }
  });

  it("every gated action names why it is gated, and nothing else claims a gate", () => {
    // ADR 0017 §1/§5: the hard-gate list is exhaustive, and a proposal is what
    // you register when you can name which row of it applies. A default is how
    // "draft a proposal" became the shape of every Agent write without anyone
    // deciding it should be.
    for (const definition of SYSTEM_ACTION_REGISTRY) {
      if (definition.side_effects === "proposal") {
        expect(definition.gate_class, `${definition.id} is a proposal with no gate class`).not.toBeNull();
        expect(SYSTEM_ACTION_GATE_CLASSES).toContain(definition.gate_class!);
      } else {
        expect(definition.gate_class, `${definition.id} claims a gate class but is not a proposal`).toBeNull();
      }
    }
  });

  it("keeps Inquiry's Project-internal writes direct", () => {
    // The two that flipped. A regression here is the six-cards-for-one-decision
    // failure returning, so it is asserted by id rather than left to review.
    const byId = new Map(SYSTEM_ACTION_REGISTRY.map((definition) => [definition.id, definition]));
    for (const id of ["inquiry.create_thread", "inquiry.record_conclusion"] as const) {
      expect(byId.get(id)?.side_effects).toBe("durable");
      expect(byId.get(id)?.proposal_type).toBeNull();
    }
    expect(byId.has("inquiry.propose_thread" as never)).toBe(false);
    // What stays gated, and why.
    expect(byId.get("inquiry.promote_knowledge")?.gate_class).toBe("exposure");
    expect(byId.get("project.propose_definition")?.gate_class).toBe("direction");
    expect(byId.get("source.backfill.propose_start")?.gate_class).toBe("money");
  });
});
