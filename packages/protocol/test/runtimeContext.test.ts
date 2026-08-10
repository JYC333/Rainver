import { describe, expect, it } from "vitest";
import {
  InvocationAuditRefsSchema,
  InvocationDeliverySchema,
  InvocationSnapshotSafeSchema,
  ExecutionControlSnapshotSchema,
  DroppedContextWindowDecisionSchema,
  MicroCheckpointSchema,
  RuntimeContextPolicyDocumentSchema,
  RuntimeContextPolicyVersionSchema,
  RuntimeContextEventIngressSchema,
  RuntimeContextEnvelopeSchema,
  ContextItemSchema,
  RuntimeContextSemanticRoleSchema,
  SemanticCheckpointSchema,
  SemanticCheckpointExtractionSchema,
  SemanticCheckpointCorrectionRequestSchema,
  WorkContextSetupSchema,
  WorkContextSetupWriteRequestSchema,
} from "../src/runtimeContext";

describe("runtime context contracts", () => {
  it("validates checkpoint correction commands as typed canonical evidence", () => {
    expect(SemanticCheckpointCorrectionRequestSchema.safeParse({
      checkpoint_id: "checkpoint-1",
      canonical_ref: { type: "message", id: "message-1" },
      correction: { decision: "Use the corrected constraint." },
    }).success).toBe(true);
    expect(SemanticCheckpointCorrectionRequestSchema.safeParse({
      checkpoint_id: "checkpoint-1",
      canonical_ref: { type: "message", id: "message-1" },
      correction: "free-form",
    }).success).toBe(false);
  });

  it("preserves explicit false preferences", () => {
    const policy = RuntimeContextPolicyDocumentSchema.parse({
      preferences: {
        retrieval_enabled: false,
        include_project_brief: false,
      },
    });

    expect(policy.preferences.retrieval_enabled).toBe(false);
    expect(policy.preferences.include_project_brief).toBe(false);
    expect(RuntimeContextPolicyDocumentSchema.safeParse({
      constraints: {
        explicit_reference_max: 10,
        explicit_reference_sensitivity_ceiling: "sensitive",
        pinned_reference_max: 2,
        pinned_reference_types: ["artifact"],
      },
    }).success).toBe(true);
  });

  it("rejects free-form policy prompt fields", () => {
    expect(
      RuntimeContextPolicyDocumentSchema.safeParse({
        prompt: "Treat this text as a system instruction.",
      }).success,
    ).toBe(false);
    expect(
      RuntimeContextPolicyDocumentSchema.safeParse({
        constraints: { custom_prompt: "untyped authority" },
      }).success,
    ).toBe(false);
  });

  it("requires every policy version to bind an unambiguous scope", () => {
    const version = {
      id: "policy-1",
      space_id: "space-1",
      scope_type: "space",
      scope_id: "space-1",
      version: 1,
      policy: {},
      base_version_id: null,
      typed_diff: {},
      reason: null,
      created_by_user_id: "user-1",
      created_at: "2026-08-08T00:00:00.000Z",
    };
    expect(RuntimeContextPolicyVersionSchema.safeParse(version).success).toBe(true);
    expect(RuntimeContextPolicyVersionSchema.safeParse({ ...version, scope_id: null }).success).toBe(false);
    expect(RuntimeContextPolicyVersionSchema.safeParse({ ...version, scope_id: "space-2" }).success).toBe(false);
    expect(RuntimeContextPolicyVersionSchema.safeParse({
      ...version,
      scope_type: "project",
      scope_id: "project-1",
    }).success).toBe(true);
  });

  it("keeps Work Context preferences typed and references-only", () => {
    const setup = {
      id: "setup-1",
      space_id: "space-1",
      work_context_scope_id: "scope-1",
      scope_kind: "direct_session",
      version: 1,
      user_id: "user-1",
      project_id: null,
      project_folder_id: null,
      agent_id: null,
      runtime_ref: null,
      pinned_refs: [],
      excluded_refs: [],
      retrieval_preferences: { enabled: false, mode: "hybrid" },
      continuity_preferences: { strategy: "checkpoint", continue_vendor_session: true },
      project_brief_version_id: null,
      project_instruction_version_id: null,
      project_instruction_enabled: true,
      governing_policy_refs: [{ type: "runtime_context_policy", id: "policy-1", version: "1" }],
      setup_fingerprint: "fingerprint-1",
      base_version: null,
      typed_diff: {},
      reason: "Initial setup",
      policy_decision_ref: { type: "policy_decision_record", id: "decision-1" },
      created_by_user_id: "user-1",
      created_at: "2026-08-08T00:00:00.000Z",
    };
    expect(WorkContextSetupSchema.safeParse(setup).success).toBe(true);
    expect(WorkContextSetupSchema.safeParse({
      ...setup,
      retrieval_preferences: { retrieval_enabled: "yes", prompt: "untyped text" },
    }).success).toBe(false);
    expect(WorkContextSetupWriteRequestSchema.safeParse({
      work_context_scope_id: "scope-1", scope_kind: "root_task", project_id: null,
      project_folder_id: null, agent_id: null, runtime_ref: null, pinned_refs: [],
      excluded_refs: [], retrieval_preferences: {}, continuity_preferences: {},
      base_version: null, reason: "Initial setup",
      embedded_context: "unreviewed free-form text",
    }).success).toBe(false);
    expect(WorkContextSetupSchema.safeParse({
      ...setup,
      continuity_preferences: { prompt: "untyped text" },
    }).success).toBe(false);
  });

  it("keeps delegated instructions, user input, and reference data distinct", () => {
    expect(RuntimeContextSemanticRoleSchema.options).toEqual([
      "delegated_instruction",
      "user_input",
      "reference_data",
    ]);
  });

  it("never elevates retrieval output into an instruction role", () => {
    const retrievalItem = {
      id: "item-1",
      source_ref: { type: "claim", id: "claim-1" },
      acquisition: "retrieval",
      selection: "ranked",
      rank: 1,
      score: 0.9,
      semantic_role: "reference_data",
      trust: "external_untrusted",
      sensitivity: "normal",
      visibility: "private",
      owner_user_id: "user-1",
      space_id: "space-1",
      egress_eligible: true,
      token_estimate: 20,
      payload: {},
      revalidation: {},
    };
    expect(ContextItemSchema.safeParse(retrievalItem).success).toBe(true);
    expect(ContextItemSchema.safeParse({
      ...retrievalItem,
      semantic_role: "delegated_instruction",
    }).success).toBe(false);
    expect(ContextItemSchema.safeParse({
      ...retrievalItem,
      semantic_role: "user_input",
    }).success).toBe(false);
    expect(ContextItemSchema.safeParse({
      ...retrievalItem,
      selection: "required",
      rank: null,
    }).success).toBe(false);
    expect(ContextItemSchema.safeParse({
      ...retrievalItem,
      rank: null,
    }).success).toBe(false);
    expect(ContextItemSchema.safeParse({
      ...retrievalItem,
      acquisition: "direct",
      selection: "required",
      rank: 1,
    }).success).toBe(false);
  });

  it("requires delivery, snapshot, control, and usage audit references together", () => {
    expect(
      InvocationAuditRefsSchema.safeParse({
        delivery_id: "delivery-1",
        invocation_snapshot_id: "snapshot-1",
        execution_control_snapshot_id: "control-1",
      }).success,
    ).toBe(false);
    expect(
      InvocationAuditRefsSchema.safeParse({
        delivery_id: "delivery-1",
        invocation_snapshot_id: "snapshot-1",
        execution_control_snapshot_id: "control-1",
        usage_source_id: "usage-1",
      }).success,
    ).toBe(true);
  });

  it("requires typed security controls and preserves non-user actor provenance", () => {
    const snapshot = {
      id: "control-1",
      version: 2,
      space_id: "space-1",
      actor: { type: "automation", automation_id: "automation-1", instructed_by_user_id: "user-1" },
      project_id: null,
      project_folder_id: null,
      agent_id: null,
      work_context_scope_id: "scope-1",
      work_context_setup_ref: { type: "work_context_setup", id: "setup-1", version: "2" },
      project_brief_ref: { type: "project_brief_version", id: "brief-1", version: "v1" },
      project_instruction_ref: null,
      readable_scope: {
        space_id: "space-1",
        allowed_source_types: ["message"],
        unrestricted_source_categories: [],
        explicit_reference_types: ["message"],
        explicit_reference_max: 4,
        pinned_reference_types: [],
        pinned_reference_max: null,
        retrieval_enabled: true,
        retrieval_max_candidates: null,
        explicit_reference_sensitivity_ceiling: null,
        allowed_source_ids: [],
        excluded_source_ids: [],
        sensitivity_ceiling: "sensitive",
      },
      egress: {
        destination_type: "model_provider",
        destination_id: "provider-1",
        sensitivity_ceiling: "normal",
        external_egress_allowed: true,
        allowed_provider_ids: ["provider-1"],
      },
      tool_grant_refs: [],
      credential_channel_ref: null,
      sandbox_profile_ref: null,
      approval_refs: [],
      persistence: {
        event_capture_allowed: true,
        checkpoint_allowed: true,
        memory_proposals_allowed: false,
        sealed_payload_retention_seconds: 0,
      },
      output_contract: {
        schema_ref: null,
        unstructured_output_allowed: true,
        max_output_tokens: 1000,
      },
      governing_policy_version_refs: [{ type: "runtime_context_policy", id: "policy-1", version: "1" }],
      policy_decision_refs: [],
      created_at: "2026-08-08T00:00:00.000Z",
    };
    expect(ExecutionControlSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(ExecutionControlSnapshotSchema.safeParse({ ...snapshot, version: 1 }).success).toBe(false);
    expect(ExecutionControlSnapshotSchema.safeParse({
      ...snapshot,
      actor: { type: "service", service_name: "job_worker", instructed_by_user_id: "user-1" },
      egress: {
        destination_type: "model_provider",
        destination_id: "provider-1",
        sensitivity_ceiling: "normal",
        external_egress_allowed: false,
        allowed_provider_ids: [],
      },
    }).success).toBe(true);
    expect(ExecutionControlSnapshotSchema.safeParse({ ...snapshot, actor: { type: "automation" } }).success).toBe(false);
    expect(ExecutionControlSnapshotSchema.safeParse({ ...snapshot, readable_scope: {} }).success).toBe(false);
    expect(ExecutionControlSnapshotSchema.safeParse({
      ...snapshot,
      readable_scope: { ...snapshot.readable_scope, space_id: "space-2" },
    }).success).toBe(false);
    expect(ExecutionControlSnapshotSchema.safeParse({ ...snapshot, egress: {} }).success).toBe(false);
    expect(ExecutionControlSnapshotSchema.safeParse({
      ...snapshot,
      egress: {
        destination_type: "local_cli",
        destination_id: "codex_cli",
        sensitivity_ceiling: "normal",
        external_egress_allowed: true,
        allowed_provider_ids: [],
      },
    }).success).toBe(true);
    expect(ExecutionControlSnapshotSchema.safeParse({
      ...snapshot,
      egress: {
        destination_type: "local_cli",
        destination_id: "codex_cli",
        sensitivity_ceiling: "normal",
        external_egress_allowed: false,
        allowed_provider_ids: [],
      },
    }).success).toBe(false);
    expect(ExecutionControlSnapshotSchema.safeParse({
      ...snapshot,
      egress: { ...snapshot.egress, allowed_provider_ids: [] },
    }).success).toBe(false);
    expect(ExecutionControlSnapshotSchema.safeParse({
      ...snapshot,
      egress: {
        ...snapshot.egress,
        destination_type: "none",
        destination_id: null,
      },
    }).success).toBe(false);
    expect(ExecutionControlSnapshotSchema.safeParse({ ...snapshot, persistence: {} }).success).toBe(false);
    expect(ExecutionControlSnapshotSchema.safeParse({ ...snapshot, output_contract: {} }).success).toBe(false);
  });

  it("represents deterministic per-turn micro checkpoint cursors and gaps", () => {
    const checkpoint = {
      id: "micro-1",
      space_id: "space-1",
      work_context_scope_id: "scope-1",
      version: 1,
      event_head_cursor: 9,
      checkpoint_cursor: 8,
      cli_known_cursor: 7,
      capture_status: "partial",
      message_refs: [],
      artifact_refs: [],
      tool_refs: [],
      invocation_snapshot_refs: [],
      capture_gaps: [{ code: "missing_event", after_cursor: 8, before_cursor: 10, detail: null }],
      created_at: "2026-08-08T00:00:00.000Z",
    };
    expect(MicroCheckpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(MicroCheckpointSchema.safeParse({ ...checkpoint, checkpoint_cursor: 10 }).success).toBe(false);
    expect(MicroCheckpointSchema.safeParse({ ...checkpoint, cli_known_cursor: 10 }).success).toBe(false);
    expect(MicroCheckpointSchema.safeParse({
      ...checkpoint,
      capture_gaps: [{ code: "missing_event", after_cursor: 10, before_cursor: 5, detail: null }],
    }).success).toBe(false);
    expect(MicroCheckpointSchema.safeParse({
      ...checkpoint,
      capture_status: "complete",
    }).success).toBe(false);
    expect(MicroCheckpointSchema.safeParse({
      ...checkpoint,
      capture_gaps: [],
    }).success).toBe(false);
  });

  it("rejects ungrounded or non-canonical semantic checkpoint citations", () => {
    const base = {
      id: "semantic-1",
      space_id: "space-1",
      work_context_scope_id: "scope-1",
      version: 1,
      covered_cursor: 9,
      goals: [],
      user_intent: [],
      constraints: [],
      facts: [],
      open_questions: [],
      tasks: [],
      artifact_refs: [],
      tool_refs: [],
      correction_refs: [],
      source_refs: [{
        ref: { type: "message", id: "message-1" },
        confirmation_authority: "none",
      }],
      extractor_ref: { type: "provider_task", id: "extractor-1", version: "v1" },
      created_at: "2026-08-08T00:00:00.000Z",
    };
    expect(SemanticCheckpointSchema.safeParse({ ...base, decisions: [{}] }).success).toBe(false);
    expect(SemanticCheckpointSchema.safeParse({
      ...base,
      decisions: [{
        id: "decision-1",
        text: "Use the unified gateway.",
        confirmation_state: "confirmed",
        source_refs: [{ type: "message", id: "message-2" }],
      }],
    }).success).toBe(false);
    expect(SemanticCheckpointSchema.safeParse({
      ...base,
      decisions: [{
        id: "decision-1",
        text: "Use the unified gateway.",
        confirmation_state: "confirmed",
        source_refs: [{ type: "message", id: "message-1" }],
      }],
    }).success).toBe(false);
    expect(SemanticCheckpointSchema.safeParse({
      ...base,
      source_refs: [{
        ref: { type: "message", id: "message-1" },
        confirmation_authority: "canonical_user",
      }],
      decisions: [{
        id: "decision-1",
        text: "Use the unified gateway.",
        confirmation_state: "confirmed",
        source_refs: [{ type: "message", id: "message-1" }],
      }],
    }).success).toBe(true);
  });

  it("keeps server-authoritative event fields out of runtime ingress", () => {
    const base = {
      invocation_id: "invocation-1",
      event_type: "assistant_message_completed",
      canonical_ref: { type: "message", id: "message-1" },
      semantic_role: "reference_data",
      token_estimate: 100,
    };
    expect(RuntimeContextEventIngressSchema.safeParse(base).success).toBe(true);
    expect(RuntimeContextEventIngressSchema.safeParse({
      ...base,
      trust: "system_approved",
      confirmation_state: "confirmed",
      scope_sequence: 99,
    }).success).toBe(false);
  });

  it("does not allow extractor output to self-assign confirmed authority", () => {
    const extraction = {
      goals: [],
      user_intent: [],
      constraints: [],
      facts: [],
      open_questions: [],
      tasks: [],
      artifact_refs: [],
      tool_refs: [],
      correction_refs: [],
      decisions: [{
        id: "decision-1",
        text: "Use the unified gateway.",
        confirmation_state: "confirmed",
        source_refs: [{ type: "message", id: "message-1" }],
      }],
    };
    expect(SemanticCheckpointExtractionSchema.safeParse(extraction).success).toBe(false);
    expect(SemanticCheckpointExtractionSchema.safeParse({
      ...extraction,
      decisions: [{ ...extraction.decisions[0], confirmation_state: "candidate" }],
    }).success).toBe(true);
    expect(SemanticCheckpointExtractionSchema.safeParse({
      ...extraction,
      decisions: [{ ...extraction.decisions[0], confirmation_state: "corrected" }],
    }).success).toBe(false);
  });

  it("rejects internally inconsistent delivery audit references", () => {
    const delivery = {
      id: "delivery-1",
      invocation_id: "invocation-1",
      delivery_kind: "agent_task",
      adapter_type: "model_api",
      provider_id: "provider-1",
      model: "model-1",
      renderer_version: "v1",
      mode: "full",
      planned_items: [{ item_id: "item-1", semantic_role: "user_input", required: true }],
      message_blocks: [{
        semantic_role: "user_input",
        content: "Current task",
        source_item_ids: ["item-1"],
      }],
      control_ref: { type: "execution_control_snapshot", id: "control-1" },
      sandbox_ref: null,
      tool_grant_refs: [],
      output_contract_ref: null,
      expected_prompt_tokens: 0,
      max_output_tokens: null,
      snapshot_draft_ref: { type: "invocation_snapshot", id: "snapshot-1" },
      audit_refs: {
        delivery_id: "delivery-1",
        invocation_snapshot_id: "snapshot-1",
        execution_control_snapshot_id: "control-1",
        usage_source_id: "usage-1",
      },
    };
    expect(InvocationDeliverySchema.safeParse(delivery).success).toBe(true);
    expect(InvocationDeliverySchema.safeParse({
      ...delivery,
      audit_refs: { ...delivery.audit_refs, delivery_id: "delivery-2" },
    }).success).toBe(false);
    expect(InvocationDeliverySchema.safeParse({
      ...delivery,
      message_blocks: [],
    }).success).toBe(false);
    expect(InvocationDeliverySchema.safeParse({
      ...delivery,
      planned_items: [{ item_id: "item-1", semantic_role: "user_input", required: false }],
    }).success).toBe(false);
    expect(InvocationDeliverySchema.safeParse({
      ...delivery,
      message_blocks: [{
        semantic_role: "reference_data",
        content: "Unattributed content",
        source_item_ids: [],
      }],
    }).success).toBe(false);
    expect(InvocationDeliverySchema.safeParse({
      ...delivery,
      delivery_kind: "provider_task",
      planned_items: [
        { item_id: "item-1", semantic_role: "reference_data", required: true },
        { item_id: "item-2", semantic_role: "reference_data", required: false },
      ],
      message_blocks: [{
        semantic_role: "reference_data",
        content: "Attributed content",
        source_item_ids: ["item-1", "item-2"],
      }],
    }).success).toBe(true);
    expect(InvocationDeliverySchema.safeParse({
      ...delivery,
      planned_items: [{ item_id: "item-1", semantic_role: "reference_data", required: true }],
      message_blocks: [{
        semantic_role: "reference_data",
        content: "Reference without a user task",
        source_item_ids: ["item-1"],
      }],
    }).success).toBe(false);
    expect(InvocationDeliverySchema.safeParse({
      ...delivery,
      message_blocks: [{ ...delivery.message_blocks[0], content: "   " }],
    }).success).toBe(false);
    expect(InvocationDeliverySchema.parse({
      ...delivery,
      message_blocks: [{ ...delivery.message_blocks[0], content: "  indented\n" }],
    }).message_blocks[0]?.content).toBe("  indented\n");
    expect(InvocationDeliverySchema.safeParse({
      ...delivery,
      message_blocks: [delivery.message_blocks[0], delivery.message_blocks[0]],
    }).success).toBe(false);
    expect(InvocationDeliverySchema.safeParse({
      ...delivery,
      planned_items: [{ item_id: "item-1", semantic_role: "reference_data", required: true }],
      message_blocks: [{
        semantic_role: "delegated_instruction",
        content: "Elevated reference data",
        source_item_ids: ["item-1"],
      }],
    }).success).toBe(false);
  });

  it("rejects over-budget plans and trimming or omitting mandatory items", () => {
    const item = {
      id: "item-1",
      source_ref: { type: "message", id: "message-1" },
      acquisition: "direct",
      selection: "required",
      rank: null,
      score: null,
      semantic_role: "user_input",
      trust: "user_confirmed",
      sensitivity: "normal",
      visibility: "private",
      owner_user_id: "user-1",
      space_id: "space-1",
      egress_eligible: true,
      token_estimate: 10,
      payload: {},
      revalidation: {},
    };
    const envelope = {
      id: "envelope-1",
      execution_control_snapshot_id: "control-1",
      setup_ref: null,
      turn_request: {
        work_context_scope_id: "scope-1",
        expected_setup_version: 1,
        current_message_ref: { type: "message", id: "message-1" },
        one_off_refs: [],
        invocation_purpose: "chat_turn",
      },
      items: [item],
      source_trace: [{ type: "message", id: "message-1" }],
      window_plan: {
        model: "model-1",
        model_catalog_version: "catalog-v1",
        tokenizer_version: "tokenizer-v1",
        total_window_tokens: 100,
        reserved_output_tokens: 20,
        provider_overhead_tokens: 5,
        planned_prompt_tokens: 10,
        allocations: { current_input: 10 },
        decisions: [{ item_id: "item-1", decision: "included", reason: "required", planned_tokens: 10 }],
        overflow_blockers: [],
      },
    };
    expect(RuntimeContextEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(RuntimeContextEnvelopeSchema.safeParse({
      ...envelope,
      window_plan: { ...envelope.window_plan, total_window_tokens: 30, planned_prompt_tokens: 10 },
    }).success).toBe(false);
    expect(RuntimeContextEnvelopeSchema.safeParse({
      ...envelope,
      window_plan: {
        ...envelope.window_plan,
        planned_prompt_tokens: 1,
        decisions: [{ item_id: "item-1", decision: "included", reason: "required", planned_tokens: 1 }],
      },
    }).success).toBe(false);
    expect(RuntimeContextEnvelopeSchema.safeParse({
      ...envelope,
      window_plan: {
        ...envelope.window_plan,
        decisions: [{ item_id: "item-1", decision: "trimmed", reason: "overflow", planned_tokens: 10 }],
      },
    }).success).toBe(false);
    expect(RuntimeContextEnvelopeSchema.safeParse({
      ...envelope,
      window_plan: { ...envelope.window_plan, planned_prompt_tokens: 0, decisions: [] },
    }).success).toBe(false);
    expect(RuntimeContextEnvelopeSchema.safeParse({
      ...envelope,
      items: [],
      window_plan: { ...envelope.window_plan, planned_prompt_tokens: 0, decisions: [] },
    }).success).toBe(false);

    const rankedItem = {
      ...item,
      id: "item-2",
      source_ref: { type: "claim", id: "claim-1" },
      acquisition: "retrieval",
      selection: "ranked",
      rank: 1,
      score: 0.8,
      semantic_role: "reference_data",
      token_estimate: 40,
    };
    const withRankedItem = {
      ...envelope,
      items: [item, rankedItem],
      window_plan: {
        ...envelope.window_plan,
        planned_prompt_tokens: 50,
        allocations: { current_input: 10, retrieval: 40 },
        decisions: [
          ...envelope.window_plan.decisions,
          { item_id: "item-2", decision: "included", reason: "ranked", planned_tokens: 40 },
        ],
      },
    };
    expect(RuntimeContextEnvelopeSchema.safeParse(withRankedItem).success).toBe(true);
    expect(RuntimeContextEnvelopeSchema.safeParse({
      ...withRankedItem,
      window_plan: {
        ...withRankedItem.window_plan,
        planned_prompt_tokens: 10,
        decisions: [
          ...envelope.window_plan.decisions,
          { item_id: "item-2", decision: "included", reason: "ranked", planned_tokens: 0 },
        ],
      },
    }).success).toBe(false);
    expect(RuntimeContextEnvelopeSchema.safeParse({
      ...withRankedItem,
      window_plan: {
        ...withRankedItem.window_plan,
        planned_prompt_tokens: 51,
        decisions: [
          ...envelope.window_plan.decisions,
          { item_id: "item-2", decision: "trimmed", reason: "ranked", planned_tokens: 41 },
        ],
      },
    }).success).toBe(false);

    const invocationSnapshot = {
      id: "snapshot-1",
      invocation_id: "invocation-1",
      delivery_id: "delivery-1",
      attempt: 1,
      space_id: "space-1",
      actor: { type: "user", user_id: "user-1" },
      project_id: null,
      project_folder_id: null,
      agent_id: null,
      work_context_scope_id: "scope-1",
      runtime_session_binding_ref: null,
      control_ref: { type: "execution_control_snapshot", id: "control-1" },
      setup_ref: null,
      governing_policy_version_refs: [{ type: "runtime_context_policy", id: "policy-1", version: "1" }],
      audit_refs: {
        delivery_id: "delivery-1",
        invocation_snapshot_id: "snapshot-1",
        execution_control_snapshot_id: "control-1",
        usage_source_id: "usage-1",
      },
      source_refs: [],
      included_item_hashes: [],
      dropped_items: [],
      budget: envelope.window_plan,
      renderer_version: "v1",
      planned_tokens: 10,
      actual_tokens: null,
      delivered_at: null,
      acknowledgement: null,
      checkpoint_cursor: 0,
      cli_known_cursor: null,
      capture_status: "complete",
      error_code: null,
      created_at: "2026-08-08T00:00:00.000Z",
    };
    expect(InvocationSnapshotSafeSchema.safeParse(invocationSnapshot).success).toBe(true);
    expect(InvocationSnapshotSafeSchema.safeParse({
      ...invocationSnapshot,
      planned_tokens: 9,
    }).success).toBe(false);
    expect(InvocationSnapshotSafeSchema.safeParse({
      ...invocationSnapshot,
      budget: {
        ...invocationSnapshot.budget,
        planned_prompt_tokens: 0,
        decisions: [{ item_id: "item-1", decision: "blocked", reason: "policy", planned_tokens: 0 }],
      },
      planned_tokens: 0,
      dropped_items: [],
    }).success).toBe(false);
  });

  it("allows only actually dropped decisions in safe snapshot projections", () => {
    expect(DroppedContextWindowDecisionSchema.safeParse({
      item_id: "item-1",
      decision: "blocked",
      reason: "policy",
      planned_tokens: 0,
    }).success).toBe(true);
    expect(DroppedContextWindowDecisionSchema.safeParse({
      item_id: "item-1",
      decision: "included",
      reason: "required",
      planned_tokens: 10,
    }).success).toBe(false);
  });
});
