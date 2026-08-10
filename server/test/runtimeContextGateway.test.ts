import { describe, expect, it, vi } from "vitest";
import type { ExecutionControlSnapshot, InvocationSnapshotSafe } from "@agent-space/protocol" with { "resolution-mode": "import" };
import {
  RuntimeContextInvocationGateway,
  RuntimeContextPlanningService,
  normalizeContextItem,
  type InvocationSnapshotStorePort,
} from "../src/modules/runtimeContext";

const SPACE = "40000000-0000-4000-8000-000000000001";
const USER = "40000000-0000-4000-8000-000000000002";
const AGENT = "40000000-0000-4000-8000-000000000003";
const RUN = "40000000-0000-4000-8000-000000000004";
const CONTROL = "40000000-0000-4000-8000-000000000005";
const SETUP = "40000000-0000-4000-8000-000000000006";
const MESSAGE = "40000000-0000-4000-8000-000000000007";
const PROVIDER = "40000000-0000-4000-8000-000000000008";

function control(): ExecutionControlSnapshot {
  return {
    id: CONTROL,
    version: 2,
    space_id: SPACE,
    actor: { type: "user", user_id: USER },
    project_id: null,
    project_folder_id: null,
    agent_id: AGENT,
    work_context_scope_id: RUN,
    work_context_setup_ref: { type: "work_context_setup", id: SETUP, version: "1" },
    project_brief_ref: null,
    project_instruction_ref: null,
    readable_scope: {
      space_id: SPACE,
      allowed_source_types: [],
      unrestricted_source_categories: [],
      explicit_reference_types: [],
      explicit_reference_max: 0,
      pinned_reference_types: [],
      pinned_reference_max: 0,
      retrieval_enabled: false,
      retrieval_max_candidates: 0,
      explicit_reference_sensitivity_ceiling: "normal",
      allowed_source_ids: [],
      excluded_source_ids: [],
      sensitivity_ceiling: "normal",
    },
    egress: {
      destination_type: "model_provider",
      destination_id: PROVIDER,
      sensitivity_ceiling: "normal",
      external_egress_allowed: true,
      allowed_provider_ids: [PROVIDER],
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
    output_contract: { schema_ref: null, unstructured_output_allowed: true, max_output_tokens: 1000 },
    governing_policy_version_refs: [{ type: "runtime_context_policy_version", id: "policy-v1", version: "1" }],
    policy_decision_refs: [],
    created_at: "2026-08-09T00:00:00.000Z",
  };
}

function planning(
  recorder: { recordPlan: ReturnType<typeof vi.fn>; reconcile: ReturnType<typeof vi.fn> },
  extraItems: ReturnType<typeof normalizeContextItem>[] = [],
) {
  return new RuntimeContextPlanningService({
    async acquire() {
      return {
        executionControlSnapshotId: CONTROL,
        setupRef: control().work_context_setup_ref,
        model: "gpt-4o",
        directItems: [...extraItems, normalizeContextItem({
          sourceRef: { type: "message", id: MESSAGE },
          acquisition: "direct",
          selection: "required",
          semanticRole: "user_input",
          trust: "domain_approved",
          sensitivity: "normal",
          visibility: "private",
          ownerUserId: USER,
          spaceId: SPACE,
          egressEligible: true,
          text: "Question",
          revalidation: { status: "live", checked_at: "2026-08-09T00:00:00.000Z" },
        })],
      };
    },
  }, recorder);
}

function request() {
  return {
    identity: { userId: USER, spaceId: SPACE },
    turn: {
      work_context_scope_id: RUN,
      expected_setup_version: 1,
      current_message_ref: { type: "message" as const, id: MESSAGE },
      one_off_refs: [],
      invocation_purpose: "agent_task" as const,
    },
    invocationId: RUN,
    executionControlSnapshotId: CONTROL,
    adapterType: "model_api",
    providerId: PROVIDER,
    model: "gpt-4o",
    usageSourceId: `run:${RUN}:attempt:1`,
  };
}

describe("RuntimeContextInvocationGateway", () => {
  it("binds one live plan to persisted control and one attempt", async () => {
    const recorder = { recordPlan: vi.fn(async () => undefined), reconcile: vi.fn(async () => undefined) };
    const createAttempt = vi.fn(async (input) => ({
      delivery: { id: input.deliveryId } as never,
      snapshot: {} as never,
    }));
    const snapshots = {
      createAttempt,
      acknowledge: vi.fn(),
      finalize: vi.fn(),
    } as unknown as InvocationSnapshotStorePort;
    const load = vi.fn(async () => control());
    const gateway = new RuntimeContextInvocationGateway(planning(recorder), snapshots, { load });

    const delivery = await gateway.prepareInvocation(request());

    expect(load).toHaveBeenCalledWith(SPACE, CONTROL);
    expect(createAttempt).toHaveBeenCalledOnce();
    const attempt = createAttempt.mock.calls[0]![0];
    expect(attempt.control).toEqual(control());
    expect(attempt.envelope.execution_control_snapshot_id).toBe(CONTROL);
    expect(attempt.deliveryId).toBe(delivery.id);
    expect(attempt.envelope.window_plan).toBeDefined();
    expect(recorder.recordPlan).not.toHaveBeenCalled();
  });

  it("captures the triggering user Message before planning its invocation", async () => {
    const order: string[] = [];
    const recorder = { recordPlan: vi.fn(async () => undefined), reconcile: vi.fn(async () => undefined) };
    const basePlanning = planning(recorder);
    const originalPlanExecution = basePlanning.planExecution.bind(basePlanning);
    const planExecution = vi.spyOn(basePlanning, "planExecution").mockImplementation(async (input) => {
      order.push("plan");
      return originalPlanExecution(input);
    });
    const ingest = vi.fn(async (event) => {
      order.push("event");
      return { ...event, id: "event-1", space_id: SPACE, work_context_scope_id: RUN,
        scope_sequence: 1, actor_user_id: USER, agent_id: AGENT, trust: "user_confirmed",
        sensitivity: "normal", confirmation_state: "confirmed", source_refs: [event.canonical_ref],
        capture_status: "complete", created_at: "2026-08-09T00:00:00.000Z" } as never;
    });
    const gateway = new RuntimeContextInvocationGateway(
      basePlanning,
      { createAttempt: vi.fn(async (input) => ({ delivery: { id: input.deliveryId } as never, snapshot: {} as never })), acknowledge: vi.fn(), finalize: vi.fn() } as unknown as InvocationSnapshotStorePort,
      { async load() { return control(); } },
      { ingest },
    );
    await gateway.prepareInvocation(request());
    expect(order).toEqual(["event", "plan"]);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "user_message_received",
      canonical_ref: { type: "message", id: MESSAGE },
      semantic_role: "user_input",
    }));
    expect(planExecution).toHaveBeenCalledOnce();
  });

  it("plans an acknowledged CLI session as a scoped delta and omits known stable items", async () => {
    const recorder = { recordPlan: vi.fn(async () => undefined), reconcile: vi.fn(async () => undefined) };
    const stable = normalizeContextItem({
      sourceRef: { type: "agent_version", id: AGENT, version: "1" },
      acquisition: "direct",
      selection: "required",
      semanticRole: "delegated_instruction",
      trust: "system_approved",
      sensitivity: "normal",
      visibility: "private",
      ownerUserId: USER,
      spaceId: SPACE,
      egressEligible: true,
      text: "Stable instruction",
      revalidation: { status: "live", checked_at: "2026-08-09T00:00:00.000Z" },
    });
    const createAttempt = vi.fn(async (input) => ({
      delivery: { id: input.deliveryId } as never,
      snapshot: {} as never,
    }));
    const gateway = new RuntimeContextInvocationGateway(
      planning(recorder, [stable]),
      { createAttempt, acknowledge: vi.fn(), finalize: vi.fn() } as unknown as InvocationSnapshotStorePort,
      { async load() { return control(); } },
      { async ingest(event) { return event as never; } },
      {
        async prepareDelivery() {
          return {
            id: "40000000-0000-4000-8000-000000000099",
            runtime_state_key: "40000000-0000-4000-8000-000000000098",
            vendor_session_id: "thread-1",
            cli_known_cursor: 8,
            acknowledged_item_ids: [stable.id],
            generation: 2,
            rotation_reason: null,
            mode: "delta" as const,
            target_cursor: 9,
            delta_item: null,
          };
        },
      },
    );
    await gateway.prepareInvocation({
      ...request(),
      adapterType: "codex_cli",
      cliBinding: {
        id: "40000000-0000-4000-8000-000000000099",
        runtime_state_key: "40000000-0000-4000-8000-000000000098",
        vendor_session_id: "thread-1",
        cli_known_cursor: 8,
        acknowledged_item_ids: [stable.id],
        generation: 2,
        rotation_reason: null,
      },
    });
    const attempt = createAttempt.mock.calls[0]![0];
    expect(attempt.mode).toBe("delta");
    expect(attempt.envelope.items.map((item: { id: string }) => item.id)).not.toContain(stable.id);
    expect(attempt.envelope.items).toHaveLength(1);
    expect(attempt.cliSession).toMatchObject({
      vendor_session_id: "thread-1",
      cursor_from: 8,
      cursor_through: 9,
      generation: 2,
    });
  });

  it("reconciles acknowledged usage and delegates conflict-safe finalization", async () => {
    const recorder = { recordPlan: vi.fn(async () => undefined), reconcile: vi.fn(async () => undefined) };
    const snapshot = {
      invocation_id: RUN,
      delivery_id: "40000000-0000-4000-8000-000000000009",
    } as InvocationSnapshotSafe;
    const acknowledge = vi.fn(async () => snapshot);
    const finalize = vi.fn(async () => snapshot);
    const snapshots = {
      createAttempt: vi.fn(),
      acknowledge,
      finalize,
    } as unknown as InvocationSnapshotStorePort;
    const gateway = new RuntimeContextInvocationGateway(planning(recorder), snapshots, { async load() { return control(); } });

    await expect(gateway.acknowledgeDelivery({
      spaceId: SPACE,
      deliveryId: "40000000-0000-4000-8000-000000000009",
      status: "accepted",
      actualPromptTokens: 42,
    })).resolves.toBe(snapshot);
    expect(recorder.reconcile).toHaveBeenCalledWith({
      spaceId: SPACE,
      invocationId: RUN,
      deliveryId: "40000000-0000-4000-8000-000000000009",
      actualPromptTokens: 42,
    });
    const finalInput = {
      spaceId: SPACE,
      invocationId: RUN,
      deliveryId: "40000000-0000-4000-8000-000000000009",
    };
    await expect(gateway.finalizeInvocation(finalInput)).resolves.toBe(snapshot);
    expect(finalize).toHaveBeenCalledWith(finalInput);
  });

  it("fails before attempt persistence when live authority no longer matches", async () => {
    const recorder = { recordPlan: vi.fn(async () => undefined), reconcile: vi.fn(async () => undefined) };
    const createAttempt = vi.fn();
    const gateway = new RuntimeContextInvocationGateway(
      planning(recorder),
      { createAttempt, acknowledge: vi.fn(), finalize: vi.fn() } as unknown as InvocationSnapshotStorePort,
      { async load() { return control(); } },
    );
    await expect(gateway.prepareInvocation({
      ...request(),
      executionControlSnapshotId: "40000000-0000-4000-8000-000000000099",
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it("records noncritical capture failures as explicit gaps but leaves critical events fail-closed", async () => {
    const recorder = { recordPlan: vi.fn(async () => undefined), reconcile: vi.fn(async () => undefined) };
    const captureError = new Error("capture unavailable");
    const ingest = vi.fn(async () => { throw captureError; });
    const recordCaptureGap = vi.fn(async () => undefined);
    const gateway = new RuntimeContextInvocationGateway(
      planning(recorder),
      { createAttempt: vi.fn(), acknowledge: vi.fn(), finalize: vi.fn() } as unknown as InvocationSnapshotStorePort,
      { async load() { return control(); } },
      { ingest, recordCaptureGap },
    );
    const base = {
      invocation_id: RUN,
      canonical_ref: { type: "run_event", id: "event-1" },
      semantic_role: "reference_data" as const,
      token_estimate: 1,
    };
    await expect(gateway.ingestRuntimeEvent({ ...base, event_type: "assistant_message_completed" }))
      .rejects.toBe(captureError);
    expect(recordCaptureGap).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: RUN,
      code: "runtime_event_capture_failed",
    }));
    recordCaptureGap.mockClear();
    await expect(gateway.ingestRuntimeEvent({ ...base, event_type: "tool_call_completed" }))
      .rejects.toBe(captureError);
    expect(recordCaptureGap).not.toHaveBeenCalled();
  });
});
