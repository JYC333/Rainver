import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { ExecutionControlSnapshot } from "@agent-space/protocol" with { "resolution-mode": "import" };
import {
  InvocationSnapshotService,
  RuntimeContextCliContinuityService,
  RuntimeContextContinuityService,
  RuntimeContextPlanner,
  normalizeContextItem,
} from "../src/modules/runtimeContext";
import {
  getTestPostgres,
  isTestPostgresUnavailableError,
  type TestPostgresDatabase,
} from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";

const SPACE = "71000000-0000-4000-8000-000000000001";
const USER = "71000000-0000-4000-8000-000000000002";
const AGENT = "71000000-0000-4000-8000-000000000003";
const VERSION = "71000000-0000-4000-8000-000000000004";
const RUNTIME = "71000000-0000-4000-8000-000000000005";
const RUN = "71000000-0000-4000-8000-000000000006";
const SESSION = "71000000-0000-4000-8000-000000000007";
const SETUP = "71000000-0000-4000-8000-000000000008";
const CONTROL = "71000000-0000-4000-8000-000000000009";
const DECISION = "71000000-0000-4000-8000-000000000010";
const PROVIDER_SPACE = "71000000-0000-4000-8000-000000000013";
const PROVIDER = "71000000-0000-4000-8000-000000000014";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri(), max: 2 });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[runtime-context-cli-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await resetTables(pool, ["policy_decision_records", "users", "spaces"], { cascade: true });
  await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'CLI','personal',now(),now())`, [SPACE]);
  await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',now(),now())`, [USER]);
  await pool.query(
    `INSERT INTO agents (id,space_id,owner_user_id,name,status,agent_kind,visibility,access_level,created_at,updated_at)
     VALUES ($1,$2,$3,'CLI Agent','active','standard','private','full',now(),now())`,
    [AGENT, SPACE, USER],
  );
  await pool.query(
    `INSERT INTO agent_versions (id,agent_id,space_id,version_label,system_prompt,model_config_json,runtime_config_json,context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,runtime_policy_json,created_at)
     VALUES ($1,$2,$3,'v1','Act','{}','{}','{}','{}','[]','{}','{}',now())`,
    [VERSION, AGENT, SPACE],
  );
  await pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [AGENT, VERSION]);
  await pool.query(
    `INSERT INTO agent_runtime_profiles (id,space_id,agent_id,name,adapter_type,runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at)
     VALUES ($1,$2,$3,'Codex','codex_cli','{}','{}',TRUE,TRUE,now(),now())`,
    [RUNTIME, SPACE, AGENT],
  );
  await pool.query(
    `INSERT INTO sessions (id,space_id,user_id,agent_id,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'active',now(),now())`,
    [SESSION, SPACE, USER, AGENT],
  );
  await pool.query(
    `INSERT INTO runs (id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,adapter_type,required_sandbox_level,instructed_by_user_id,owner_user_id,requested_runtime_profile_id,session_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'agent','manual','running','live','codex_cli','ephemeral',$5,$5,$6,$7,now(),now())`,
    [RUN, SPACE, AGENT, VERSION, USER, RUNTIME, SESSION],
  );
  await pool.query(
    `INSERT INTO policy_decision_records (id,space_id,actor_type,actor_id,action,resource_type,resource_id,decision,risk_level,policy_source,metadata_json,created_at)
     VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,'allow','medium','test','{}',now())`,
    [DECISION, SPACE, USER, SETUP],
  );
  await pool.query(
    `INSERT INTO work_context_setups (
       id,space_id,work_context_scope_id,scope_kind,version,user_id,agent_id,runtime_ref_json,
       pinned_refs_json,excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,
       project_instruction_enabled,governing_policy_refs_json,setup_fingerprint,base_version,
       typed_diff_json,reason,policy_decision_record_id,created_by_user_id,created_at
     ) VALUES ($1,$2,$3,'direct_session',1,$4,$5,$6::jsonb,'[]','[]','{}',
               '{"strategy":"stateful_cli","continue_vendor_session":true}',FALSE,'[]','setup-v1',NULL,
               '{}','test',$7,$4,now())`,
    [SETUP, SPACE, RUN, USER, AGENT, JSON.stringify({ type: "agent_runtime_profile", id: RUNTIME }), DECISION],
  );
  await pool.query(
    `INSERT INTO execution_control_snapshots (id,space_id,run_id,snapshot_json,created_at)
     VALUES ($1,$2,$3,$4::jsonb,now())`,
    [CONTROL, SPACE, RUN, JSON.stringify(control())],
  );
});

describe("Runtime Context CLI continuity (real PostgreSQL)", () => {
  it("resumes a healthy accepted vendor session even when its acknowledged cursor is zero", async () => {
    if (!available || !pool) return;
    const cli = new RuntimeContextCliContinuityService(pool);
    const binding = await cli.prepareBinding(bindingInput(control()));
    expect(await cli.recordVendorSession({
      bindingId: binding.id,
      runtimeStateKey: binding.runtime_state_key,
      vendorSessionId: "thread-empty",
    })).toBe(true);
    const delivery = await cli.prepareDelivery({
      bindingId: binding.id,
      spaceId: SPACE,
      workContextScopeId: RUN,
      invocationId: RUN,
      currentMessageRef: { type: "run_request", id: RUN },
      ownerUserId: USER,
      authorizedSourceRefs: [{ type: "run_request", id: RUN }],
    });
    expect(delivery).toMatchObject({
      mode: "delta",
      cli_known_cursor: 0,
      target_cursor: 0,
      delta_item: null,
    });
  });

  it("rotates an oversized delta and reconstructs from the bounded checkpoint", async () => {
    if (!available || !pool) return;
    const cli = new RuntimeContextCliContinuityService(pool);
    const continuity = new RuntimeContextContinuityService(pool);
    const binding = await cli.prepareBinding(bindingInput(control()));
    await cli.recordVendorSession({
      bindingId: binding.id,
      runtimeStateKey: binding.runtime_state_key,
      vendorSessionId: "thread-overflow",
    });
    let currentMessage = "";
    for (let index = 0; index < 8; index += 1) {
      currentMessage = await message(`overflow-${index}`, "x".repeat(1_200), "user");
      await continuity.ingest({
        invocation_id: RUN,
        event_type: "user_message_received",
        canonical_ref: { type: "message", id: currentMessage },
        semantic_role: "user_input",
        token_estimate: 1_200,
      });
    }
    const scope = await pool.query<{ event_head_cursor: number }>(
      `SELECT event_head_cursor FROM context_event_scopes WHERE space_id=$1 AND work_context_scope_id=$2`,
      [SPACE, RUN],
    );
    const checkpointId = randomUUID();
    await pool.query(
      `INSERT INTO context_semantic_checkpoints (
         id,space_id,work_context_scope_id,version,covered_cursor,status,
         checkpoint_json,extractor_ref_json,created_at
       ) VALUES ($1,$2,$3,1,$4,'active',$5::jsonb,$6::jsonb,now())`,
      [checkpointId, SPACE, RUN, Number(scope.rows[0]?.event_head_cursor ?? 0),
        JSON.stringify({ decisions: [{ text: "Bounded checkpoint" }] }),
        JSON.stringify({ type: "provider_task", id: randomUUID(), version: "test.v1" })],
    );
    const delivery = await cli.prepareDelivery({
      bindingId: binding.id,
      spaceId: SPACE,
      workContextScopeId: RUN,
      invocationId: RUN,
      currentMessageRef: { type: "message", id: currentMessage },
      ownerUserId: USER,
      authorizedSourceRefs: [{ type: "message", id: currentMessage }],
    });
    expect(delivery.mode).toBe("full");
    expect(delivery.id).not.toBe(binding.id);
    expect(delivery.rotation_reason).toBe("overflow_reconstruction");
    expect(delivery.delta_item?.payload.text).toContain("Bounded checkpoint");
    await expect(pool.query<{ status: string }>(
      `SELECT status FROM runtime_context_cli_bindings WHERE id=$1`,
      [binding.id],
    )).resolves.toMatchObject({ rows: [{ status: "rotated" }] });
  });

  it("advances only accepted deltas and rotates hard authority or missing vendor state", async () => {
    if (!available || !pool) return;
    const cli = new RuntimeContextCliContinuityService(pool);
    const continuity = new RuntimeContextContinuityService(pool);
    const firstMessage = await message("first", "Start the task.", "user");
    await continuity.ingest({
      invocation_id: RUN,
      event_type: "user_message_received",
      canonical_ref: { type: "message", id: firstMessage },
      semantic_role: "user_input",
      token_estimate: 4,
    });
    let binding = await cli.prepareBinding(bindingInput(control()));
    expect(binding).toMatchObject({
      vendor_session_id: null,
      cli_known_cursor: 0,
      generation: 1,
      rotation_reason: "new_scope",
    });
    const first = await cli.prepareDelivery({
      bindingId: binding.id,
      spaceId: SPACE,
      workContextScopeId: RUN,
      invocationId: RUN,
      currentMessageRef: { type: "message", id: firstMessage },
      ownerUserId: USER,
      authorizedSourceRefs: [{ type: "message", id: firstMessage }],
    });
    expect(first).toMatchObject({ mode: "full", target_cursor: 1, delta_item: null });
    const snapshots = new InvocationSnapshotService(pool, undefined, undefined, undefined, cli);
    const attempt = await snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(firstMessage),
      control: control(),
      adapterType: "codex_cli",
      providerId: null,
      model: "gpt-4o",
      usageSourceId: "cli-continuity:first",
      mode: "full",
      cliSession: {
        binding_ref: { type: "runtime_context_cli_binding", id: binding.id, version: "1" },
        runtime_state_key: binding.runtime_state_key,
        vendor_session_id: null,
        cursor_from: 0,
        cursor_through: 1,
        generation: 1,
        rotation_reason: "new_scope",
      },
    });
    expect(attempt.delivery.message_blocks.at(-1)?.delivery_phase).toBe("current_user");
    await snapshots.acknowledgeCliContextPhase({
      spaceId: SPACE,
      deliveryId: attempt.delivery.id,
      vendorSessionId: "thread-1",
    });
    expect(await cursor(binding.id)).toBe(1);
    expect((await pool.query<{ status: string }>(
      `SELECT status FROM invocation_snapshots WHERE delivery_id=$1`,
      [attempt.delivery.id],
    )).rows[0]?.status).toBe("draft");
    const accepted = await snapshots.acknowledge({
      spaceId: SPACE,
      deliveryId: attempt.delivery.id,
      status: "accepted",
    });
    expect(accepted.cli_known_cursor).toBe(1);
    expect(await cursor(binding.id)).toBe(1);
    expect((await pool.query<{ vendor_session_id: string | null }>(
      `SELECT vendor_session_id FROM runtime_context_cli_bindings WHERE id=$1`,
      [binding.id],
    )).rows[0]?.vendor_session_id).toBe("thread-1");

    const assistant = await message("assistant", "Use the scoped delivery.", "assistant");
    await continuity.ingest({
      invocation_id: RUN,
      event_type: "assistant_message_completed",
      canonical_ref: { type: "message", id: assistant },
      semantic_role: "reference_data",
      token_estimate: 5,
    });
    const current = await message("current", "Continue.", "user");
    await continuity.ingest({
      invocation_id: RUN,
      event_type: "user_message_received",
      canonical_ref: { type: "message", id: current },
      semantic_role: "user_input",
      token_estimate: 2,
    });
    const finalRunEventId = randomUUID();
    await pool.query(
      `UPDATE runs SET output_json=$2::jsonb WHERE id=$1`,
      [RUN, JSON.stringify({
        schema_version: "run_output.v1",
        status: "succeeded",
        summary: "Actual final CLI response.",
        result: {},
        output_manifest: [],
      })],
    );
    await pool.query(
      `INSERT INTO run_events (
         id,space_id,run_id,event_index,event_type,status,summary,created_at
       ) VALUES ($1,$2,$3,1,'assistant_message_completed','succeeded',
                 'Assistant message completed.',now())`,
      [finalRunEventId, SPACE, RUN],
    );
    await continuity.ingest({
      invocation_id: RUN,
      event_type: "assistant_message_completed",
      canonical_ref: { type: "run_event", id: finalRunEventId },
      semantic_role: "reference_data",
      token_estimate: 6,
    });
    binding = await cli.prepareBinding(bindingInput(control()));
    expect(binding).toMatchObject({ vendor_session_id: "thread-1", generation: 1, rotation_reason: "new_scope" });
    const delta = await cli.prepareDelivery({
      bindingId: binding.id,
      spaceId: SPACE,
      workContextScopeId: RUN,
      invocationId: RUN,
      currentMessageRef: { type: "message", id: current },
      ownerUserId: USER,
      authorizedSourceRefs: [{ type: "message", id: current }],
    });
    expect(delta.mode).toBe("delta");
    expect(delta.target_cursor).toBe(4);
    expect(delta.delta_item?.payload.text).toContain("Use the scoped delivery.");
    expect(delta.delta_item?.payload.text).toContain("Actual final CLI response.");
    expect(delta.delta_item?.payload.text).not.toContain("Assistant message completed.");
    expect(delta.delta_item?.payload.text).not.toContain("Continue.");
    expect(await cursor(binding.id)).toBe(1);
    await acknowledge(cli, binding.id, 1, 4, [delta.delta_item!.id, "current-item"]);
    expect(await cursor(binding.id)).toBe(4);
    const scopeCursor = await pool.query<{ cli_known_cursor: number | null }>(
      `SELECT cli_known_cursor FROM context_event_scopes
        WHERE space_id=$1 AND work_context_scope_id=$2`,
      [SPACE, RUN],
    );
    expect(scopeCursor.rows[0]?.cli_known_cursor).toBeNull();

    const toolChanged = control();
    toolChanged.tool_grant_refs = [{ type: "tool_grant", id: "71000000-0000-4000-8000-000000000099" }];
    const rotated = await cli.prepareBinding(bindingInput(toolChanged));
    expect(rotated).toMatchObject({
      vendor_session_id: null,
      cli_known_cursor: 0,
      generation: 2,
      rotation_reason: "tool_policy_changed",
    });
    await cli.recordVendorSession({
      bindingId: rotated.id,
      runtimeStateKey: rotated.runtime_state_key,
      vendorSessionId: "thread-2",
    });
    const checkpointId = randomUUID();
    await pool.query(
      `INSERT INTO context_semantic_checkpoints (
         id,space_id,work_context_scope_id,version,covered_cursor,status,
         checkpoint_json,extractor_ref_json,created_at
       ) VALUES ($1,$2,$3,1,1,'active',$4::jsonb,$5::jsonb,now())`,
      [checkpointId, SPACE, RUN,
        JSON.stringify({ decisions: [{ text: "Keep canonical scope continuity." }] }),
        JSON.stringify({ type: "provider_task", id: randomUUID(), version: "test.v1" })],
    );
    const missing = await cli.rotateMissingVendorState(rotated.id);
    expect(missing).toMatchObject({
      vendor_session_id: null,
      cli_known_cursor: 0,
      generation: 3,
      rotation_reason: "vendor_state_missing",
    });
    const reconstructed = await cli.prepareDelivery({
      bindingId: missing.id,
      spaceId: SPACE,
      workContextScopeId: RUN,
      invocationId: RUN,
      currentMessageRef: { type: "message", id: current },
      ownerUserId: USER,
      authorizedSourceRefs: [{ type: "message", id: current }],
    });
    expect(reconstructed).toMatchObject({ mode: "full", target_cursor: 4 });
    expect(reconstructed.delta_item?.payload.text).toContain("Keep canonical scope continuity.");
    expect(reconstructed.delta_item?.payload.text).toContain("Use the scoped delivery.");
    expect(reconstructed.delta_item?.payload.text).toContain("Actual final CLI response.");
    expect(reconstructed.delta_item?.payload.text).not.toContain("Assistant message completed.");
    expect(reconstructed.delta_item?.payload.text).not.toContain("Continue.");
    expect(reconstructed.delta_item?.payload.checkpoint_ref).toEqual({
      type: "semantic_checkpoint",
      id: checkpointId,
      version: "1",
    });
  });

  it("serializes a shared binding lease and rotates immutable runtime generations", async () => {
    if (!available || !pool) return;
    const cli = new RuntimeContextCliContinuityService(pool);
    const first = await cli.prepareBinding(bindingInput(control()));
    const firstLease = await cli.acquireExecutionLease(first.id);
    let secondAcquired = false;
    const secondLease = cli.acquireExecutionLease(first.id).then((lease) => {
      secondAcquired = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(secondAcquired).toBe(false);
    await cli.releaseExecutionLease(first.id, firstLease);
    const acquired = await secondLease;
    expect(secondAcquired).toBe(true);
    await cli.releaseExecutionLease(first.id, acquired);

    await pool.query(
      `UPDATE agent_runtime_profiles
          SET runtime_policy_json='{"network":"restricted"}'::jsonb,updated_at=now() + interval '1 second'
        WHERE id=$1`,
      [RUNTIME],
    );
    const rotated = await cli.prepareBinding(bindingInput(control()));
    expect(rotated).toMatchObject({
      vendor_session_id: null,
      generation: 2,
      rotation_reason: "runtime_changed",
    });

    const delegated = await cli.prepareBinding({
      ...bindingInput(control()),
      agentVersionId: "71000000-0000-4000-8000-000000000099",
    });
    expect(delegated).toMatchObject({
      generation: 3,
      rotation_reason: "delegated_instruction_changed",
    });

    await pool.query(
      `INSERT INTO settings (
         id,scope_type,scope_id,settings_key,settings_json,created_at,updated_at
       ) VALUES ($1,'space',$2,'runtime_context.cli_egress_generation','{"generation":1}',now(),now())`,
      [randomUUID(), SPACE],
    );
    const egressRotated = await cli.prepareBinding({
      ...bindingInput(control()),
      agentVersionId: "71000000-0000-4000-8000-000000000099",
    });
    expect(egressRotated).toMatchObject({
      generation: 4,
      rotation_reason: "egress_policy_changed",
    });
  });

  it("binds provider generations through the target Space grant", async () => {
    if (!available || !pool) return;
    await pool.query(
      `INSERT INTO spaces (id,name,type,created_at,updated_at)
       VALUES ($1,'Provider Home','personal',now(),now())`,
      [PROVIDER_SPACE],
    );
    await pool.query(
      `INSERT INTO model_providers (
         id,space_id,owner_user_id,name,provider_type,base_url,default_model,
         enabled,capabilities_json,config_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'Shared Provider','openai','https://example.invalid/v1',
                 'shared-model',TRUE,'{}','{}',now(),now())`,
      [PROVIDER, PROVIDER_SPACE, USER],
    );
    await pool.query(
      `INSERT INTO model_provider_space_grants (
         id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,
         created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$4,TRUE,FALSE,now(),now())`,
      [randomUUID(), PROVIDER, SPACE, USER],
    );
    const cli = new RuntimeContextCliContinuityService(pool);
    const input = { ...bindingInput(control()), providerId: PROVIDER, model: "shared-model" };
    const first = await cli.prepareBinding(input);
    expect(first).toMatchObject({ generation: 1, rotation_reason: "new_scope" });

    await pool.query(
      `UPDATE model_provider_space_grants
          SET is_default=TRUE,updated_at=now() + interval '1 second'
        WHERE provider_id=$1 AND space_id=$2`,
      [PROVIDER, SPACE],
    );
    await expect(cli.prepareBinding(input)).resolves.toMatchObject({
      generation: 2,
      rotation_reason: "runtime_changed",
    });
    await pool.query(
      `UPDATE model_provider_space_grants SET enabled=FALSE WHERE provider_id=$1 AND space_id=$2`,
      [PROVIDER, SPACE],
    );
    await expect(cli.prepareBinding(input)).rejects.toMatchObject({ statusCode: 409 });
  });

  async function message(suffix: string, content: string, role: "user" | "assistant"): Promise<string> {
    void suffix;
    const id = randomUUID();
    await pool!.query(
      `INSERT INTO messages (id,space_id,session_id,user_id,sender_agent_id,role,content,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
      [id, SPACE, SESSION, role === "user" ? USER : null,
        role === "assistant" ? AGENT : null, role, content],
    );
    return id;
  }

  async function acknowledge(
    cli: RuntimeContextCliContinuityService,
    bindingId: string,
    fromCursor: number,
    throughCursor: number,
    itemIds: string[],
  ): Promise<void> {
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await cli.acknowledgeDeliveryInTransaction(client, {
        bindingId,
        spaceId: SPACE,
        workContextScopeId: RUN,
        fromCursor,
        throughCursor,
        itemIds,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function cursor(bindingId: string): Promise<number> {
    const result = await pool!.query<{ cli_known_cursor: number }>(
      `SELECT cli_known_cursor FROM runtime_context_cli_bindings WHERE id=$1`,
      [bindingId],
    );
    return Number(result.rows[0]?.cli_known_cursor ?? -1);
  }
});

function bindingInput(snapshot: ExecutionControlSnapshot) {
  return {
    spaceId: SPACE,
    workContextScopeId: RUN,
    setupId: SETUP,
    setupVersion: 1,
    userId: USER,
    agentId: AGENT,
    runtimeProfileId: RUNTIME,
    credentialProfileId: null,
    adapterType: "codex_cli",
    providerId: null,
    model: "gpt-4o",
    agentVersionId: VERSION,
    runtimeToolVersion: "test.v1",
    control: snapshot,
  };
}

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
      destination_type: "local_cli",
      destination_id: "codex_cli",
      sensitivity_ceiling: "normal",
      external_egress_allowed: true,
      allowed_provider_ids: [],
    },
    tool_grant_refs: [],
    credential_channel_ref: null,
    sandbox_profile_ref: { type: "sandbox_profile", id: "71000000-0000-4000-8000-000000000011" },
    approval_refs: [],
    persistence: {
      event_capture_allowed: true,
      checkpoint_allowed: true,
      memory_proposals_allowed: false,
      sealed_payload_retention_seconds: 0,
    },
    output_contract: { schema_ref: null, unstructured_output_allowed: true, max_output_tokens: 1000 },
    governing_policy_version_refs: [{ type: "runtime_context_policy_version", id: "71000000-0000-4000-8000-000000000012", version: "1" }],
    policy_decision_refs: [],
    created_at: "2026-08-09T00:00:00.000Z",
  };
}

function envelope(messageId: string) {
  const current = normalizeContextItem({
    sourceRef: { type: "message", id: messageId },
    acquisition: "direct",
    selection: "required",
    semanticRole: "user_input",
    trust: "user_confirmed",
    sensitivity: "normal",
    visibility: "private",
    ownerUserId: USER,
    spaceId: SPACE,
    egressEligible: true,
    text: "Start the task.",
    revalidation: { status: "live", checked_at: "2026-08-09T00:00:00.000Z" },
  });
  return new RuntimeContextPlanner().plan({
    executionControlSnapshotId: CONTROL,
    setupRef: { type: "work_context_setup", id: SETUP, version: "1" },
    turn: {
      work_context_scope_id: RUN,
      expected_setup_version: 1,
      current_message_ref: { type: "message", id: messageId },
      one_off_refs: [],
      invocation_purpose: "agent_task",
    },
    model: "gpt-4o",
    directItems: [current],
  });
}
