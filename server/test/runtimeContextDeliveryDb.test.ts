import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionControlSnapshot, InvocationDelivery, RuntimeHostExecuteRequest } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { Pool } from "pg";
import { migrate } from "../src/db/migrator";
import {
  InvocationSnapshotService,
  PgInvocationDeliveryAuthorizer,
  RuntimeContextContinuityService,
  RuntimeContextPlanner,
  SealedPayloadCipher,
  SealedPayloadService,
  createProductionRuntimeContextPlanningService,
  loadConversationContinuityThroughMessage,
  normalizeContextItem,
} from "../src/modules/runtimeContext";
import { authorizeRuntimeHostDelivery, bindRuntimeHostDeliveryRequest } from "../src/modules/runtimeHost";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "30000000-0000-4000-8000-000000000001";
const USER = "30000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const VERSION = "30000000-0000-4000-8000-000000000004";
const RUN = "30000000-0000-4000-8000-000000000005";
const CONTROL = "30000000-0000-4000-8000-000000000006";
const MESSAGE = "30000000-0000-4000-8000-000000000007";
const PROVIDER = "30000000-0000-4000-8000-000000000008";
const SETUP = "30000000-0000-4000-8000-000000000009";
const PROJECT = "30000000-0000-4000-8000-000000000011";
const FOLDER = "30000000-0000-4000-8000-000000000012";
const HOST = "30000000-0000-4000-8000-000000000014";
const THREAD = "30000000-0000-4000-8000-000000000013";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[runtime-context-delivery-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query("TRUNCATE context_checkpoint_corrections, context_semantic_checkpoints, context_micro_checkpoints, context_capture_gaps, context_events, context_event_scopes, sealed_invocation_payload_access_audits, sealed_invocation_payloads, invocation_snapshots, invocation_deliveries, context_window_reconciliations, execution_control_snapshots, users, spaces, hosts CASCADE");
  await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Delivery','personal',now(),now())`, [SPACE]);
  await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',now(),now())`, [USER]);
  await pool.query(
    `INSERT INTO hosts (id, owner_user_id, name, kind, status, created_at, updated_at)
     VALUES ($1, NULL, 'server', 'server', 'online', now(), now())`,
    [HOST],
  );
  await pool.query(
    `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
     VALUES ($1,$2,$3,'owner','active',now(),now())`,
    ["30000000-0000-4000-8000-000000000010", SPACE, USER],
  );
  await pool.query(
    `INSERT INTO agents (id,space_id,owner_user_id,name,status,agent_kind,created_at,updated_at,visibility,access_level)
     VALUES ($1,$2,$3,'Agent','active','standard',now(),now(),'private','full')`,
    [AGENT, SPACE, USER],
  );
  await pool.query(
    `INSERT INTO agent_versions (id,agent_id,space_id,version_label,system_prompt,model_config_json,runtime_config_json,context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,runtime_policy_json,created_at)
     VALUES ($1,$2,$3,'v1','test','{}','{}','{}','{}','[]','{}','{}',now())`,
    [VERSION, AGENT, SPACE],
  );
  await pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [AGENT, VERSION]);
  await pool.query(
    `INSERT INTO runs (id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,adapter_type,required_sandbox_level,instructed_by_user_id,owner_user_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'agent','manual','running','live','model_api','none',$5,$5,now(),now())`,
    [RUN, SPACE, AGENT, VERSION, USER],
  );
  await pool.query(
    `INSERT INTO execution_control_snapshots (id,space_id,run_id,snapshot_json,created_at)
     VALUES ($1,$2,$3,$4::jsonb,now())`,
    [CONTROL, SPACE, RUN, JSON.stringify(control())],
  );
});

function control(retention = 60): ExecutionControlSnapshot {
  return {
    id: CONTROL,
    version: 2,
    space_id: SPACE,
    actor: { type: "user", user_id: USER },
    project_id: null,
    project_folder_id: null,
    agent_id: AGENT,
    work_context_scope_id: RUN,
    work_context_setup_ref: null,
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
      sealed_payload_retention_seconds: retention,
    },
    output_contract: { schema_ref: null, unstructured_output_allowed: true, max_output_tokens: 1000 },
    governing_policy_version_refs: [{ type: "runtime_context_policy_version", id: "policy-v1", version: "1" }],
    policy_decision_refs: [],
    created_at: "2026-08-09T00:00:00.000Z",
  };
}

function envelope(trust: "domain_approved" | "user_confirmed" = "domain_approved") {
  const message = normalizeContextItem({
    sourceRef: { type: "message", id: MESSAGE },
    acquisition: "direct",
    selection: "required",
    semanticRole: "user_input",
    trust,
    sensitivity: "normal",
    visibility: "private",
    ownerUserId: USER,
    spaceId: SPACE,
    egressEligible: true,
    text: "Private question",
    revalidation: { status: "live", checked_at: "2026-08-09T00:00:00.000Z" },
  });
  return new RuntimeContextPlanner().plan({
    executionControlSnapshotId: CONTROL,
    setupRef: null,
    turn: {
      work_context_scope_id: RUN,
      expected_setup_version: 1,
      current_message_ref: { type: "message", id: MESSAGE },
      one_off_refs: [],
      invocation_purpose: "agent_task",
    },
    model: "gpt-4o",
    directItems: [message],
  });
}

function runtimeHostRequest(delivery: InvocationDelivery): RuntimeHostExecuteRequest {
  return {
    run_input: {
      schema_version: "run_input.v1",
      run_id: RUN,
      space_id: SPACE,
      instruction: null,
      task_goal: "Private question",
      messages: [],
      inputs: { direct: null, workflow: null, upstream: null },
      attachments: [],
      project_folder_access: null,
      output_contract: { schema_version: "run_output_contract.v1", structured_output: null, required_outputs: [] },
      tool_grants: [],
      execution: {
        shape: "conversational",
        risk_level: "low",
        required_sandbox_level: "none",
        policy_ref: `run_permission_snapshot:${RUN}`,
        budget_ref: `run_contract:${RUN}`,
      },
    },
    run_id: RUN,
    space_id: SPACE,
    model_provider_id: PROVIDER,
    model: "gpt-4o",
    system_prompt: null,
    prompt: "Private question",
    messages: [{ role: "user", content: "Private question" }],
    mode: "live",
    instruction: null,
    tool_mode: "disabled",
    tool_bindings: [],
    invocation_audit_refs: delivery.audit_refs,
  };
}

describe("Context Event continuity and checkpoints", () => {
  it("allocates dense idempotent scope sequences and exposes durable gaps", async () => {
    if (!available || !pool) return;
    const continuity = new RuntimeContextContinuityService(pool);
    const input = {
      invocation_id: RUN,
      event_type: "run_observed",
      canonical_ref: { type: "run", id: RUN },
      semantic_role: null,
      token_estimate: 0,
    } as const;
    const [first, duplicate] = await Promise.all([
      continuity.ingest(input),
      continuity.ingest(input),
    ]);
    expect(duplicate.id).toBe(first.id);
    expect(first.scope_sequence).toBe(1);
    await expect(continuity.ingest({
      ...input,
      event_type: "missing_artifact",
      canonical_ref: { type: "artifact", id: randomUUID() },
    })).rejects.toMatchObject({ statusCode: 422 });
    await continuity.recordCaptureGap({
      invocationId: RUN,
      code: "adapter_event_missing",
      detail: "terminal acknowledgement omitted a noncritical event",
      event: { ...input, event_type: "buffered_runtime_notice" },
    });
    const checkpoint = await continuity.finalizeChatTurn({
      invocationId: RUN,
      messageId: null,
      failedRun: true,
    });
    expect(checkpoint.capture_status).toBe("partial");
    expect(checkpoint.capture_gaps).toEqual([
      expect.objectContaining({ code: "adapter_event_missing", after_cursor: 1 }),
    ]);
    const state = await pool.query<{ event_head_cursor: number; checkpoint_cursor: number; capture_status: string }>(
      `SELECT event_head_cursor,checkpoint_cursor,capture_status FROM context_event_scopes
        WHERE space_id=$1 AND work_context_scope_id=$2`,
      [SPACE, RUN],
    );
    expect(state.rows[0]).toMatchObject({ event_head_cursor: 2, checkpoint_cursor: 0, capture_status: "partial" });
    expect(await continuity.recoverOpenCaptureGaps(SPACE, RUN)).toBe(1);
    const recovered = await pool.query<{ scope_sequence: number; capture_status: string }>(
      `SELECT scope_sequence,capture_status FROM context_events
        WHERE space_id=$1 AND work_context_scope_id=$2 AND event_type='buffered_runtime_notice'`,
      [SPACE, RUN],
    );
    expect(recovered.rows[0]).toMatchObject({ scope_sequence: 3, capture_status: "recovered" });
    expect(await continuity.reconcileScope(SPACE, RUN)).toBe("recovered");
  });

  it("marks a snapshot complete only with its committed terminal event and checkpoint", async () => {
    if (!available || !pool) return;
    const continuity = new RuntimeContextContinuityService(pool);
    const snapshots = new InvocationSnapshotService(pool, undefined, undefined, continuity);
    const created = await snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(),
      adapterType: "model_api",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: "continuity-finalize",
    });
    const taint = await pool.query<{
      has_context_taint: boolean;
      context_taint_json: { narrowest_visibility: string; input_owner_user_ids: string[] };
    }>(`SELECT has_context_taint,context_taint_json FROM runs WHERE id=$1`, [RUN]);
    expect(taint.rows[0]).toMatchObject({
      has_context_taint: true,
      context_taint_json: {
        narrowest_visibility: "private",
        input_owner_user_ids: [USER],
      },
    });
    const acknowledged = await snapshots.acknowledge({
      spaceId: SPACE,
      deliveryId: created.delivery.id,
      status: "accepted",
    });
    expect(acknowledged.capture_status).toBe("partial");
    const finalized = await snapshots.finalize({
      spaceId: SPACE,
      invocationId: RUN,
      deliveryId: created.delivery.id,
    });
    expect(finalized).toMatchObject({ capture_status: "complete", checkpoint_cursor: 0 });
    expect((await pool.query(
      `SELECT scope_sequence,event_type,canonical_ref_json->>'id' AS ref_id
         FROM context_events WHERE space_id=$1 AND work_context_scope_id=$2`,
      [SPACE, RUN],
    )).rows).toEqual([{ scope_sequence: 1, event_type: "invocation_finalized", ref_id: created.snapshot.id }]);
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs WHERE space_id=$1 AND job_type='runtime_context_checkpoint'`,
      [SPACE],
    )).rows[0]?.count).toBe(1);
    let semanticCalls = 0;
    const semanticContinuity = new RuntimeContextContinuityService(pool, {
      async extract() {
        semanticCalls += 1;
        throw new Error("terminal-only continuity must not invoke semantic extraction");
      },
    });
    await expect(semanticContinuity.runSemanticExtraction({
      spaceId: SPACE,
      workContextScopeId: RUN,
    })).resolves.toBeNull();
    expect(semanticCalls).toBe(0);
  });

  it("validates extractor citations and derives confirmation only from canonical user evidence", async () => {
    if (!available || !pool) return;
    const sessionId = randomUUID();
    const messageId = randomUUID();
    await pool.query(`INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ($1,$2,$3,'active',now(),now())`, [sessionId, SPACE, USER]);
    await pool.query(`INSERT INTO messages (id,space_id,session_id,user_id,role,content,created_at) VALUES ($1,$2,$3,$4,'user','Use the unified gateway.',now())`, [messageId, SPACE, sessionId, USER]);
    await pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`, [RUN, sessionId]);
    const setupDecisionId = randomUUID();
    await pool.query(
      `INSERT INTO policy_decision_records (
         id,space_id,actor_type,actor_id,action,resource_type,resource_id,
         decision,risk_level,policy_source,metadata_json,created_at
       ) VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,
                 'allow','medium','test','{}',now())`,
      [setupDecisionId, SPACE, USER, SETUP],
    );
    await pool.query(
      `INSERT INTO work_context_setups (
         id,space_id,work_context_scope_id,scope_kind,version,user_id,agent_id,
         runtime_ref_json,pinned_refs_json,excluded_refs_json,retrieval_preferences_json,
         continuity_preferences_json,project_instruction_enabled,governing_policy_refs_json,
         setup_fingerprint,base_version,typed_diff_json,reason,policy_decision_record_id,
         created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'root_task',1,$4,$5,NULL,'[]','[]','{}','{}',FALSE,'[]',
                 'correction-authority',NULL,'{}','test',$6,$4,now())`,
      [SETUP, SPACE, RUN, USER, AGENT, setupDecisionId],
    );
    const observedEgress: boolean[] = [];
    const continuity = new RuntimeContextContinuityService(pool, {
      async extract({ events, egressPolicy }) {
        observedEgress.push(egressPolicy.externalEgressEnabled);
        const correction = events.find((event) => event.event_type === "checkpoint_corrected");
        const sourceRef = correction?.canonical_ref ?? events[0]!.canonical_ref;
        return {
          extraction: {
            goals: [], user_intent: [], constraints: [], facts: [], open_questions: [], tasks: [],
            artifact_refs: [], tool_refs: [], correction_refs: correction ? [sourceRef] : [],
            decisions: [{
              id: randomUUID(),
              text: correction ? "Use the corrected gateway decision." : "Use the unified gateway.",
              confirmation_state: "candidate",
              source_refs: [sourceRef],
            }],
          },
          extractorRef: { type: "provider_task", id: randomUUID(), version: "test.v1" },
        };
      },
    });
    await continuity.ingest({
      invocation_id: RUN,
      event_type: "user_decision_confirmed",
      canonical_ref: { type: "message", id: messageId },
      semantic_role: "user_input",
      token_estimate: 6,
    });
    const checkpoint = await continuity.runSemanticExtraction({
      spaceId: SPACE,
      workContextScopeId: RUN,
      force: true,
    });
    expect(checkpoint?.decisions[0]).toMatchObject({ confirmation_state: "confirmed" });
    expect(checkpoint?.source_refs).toEqual([
      expect.objectContaining({ confirmation_authority: "canonical_user" }),
    ]);
    expect(observedEgress).toEqual([true]);
    const authorityLock = await pool.connect();
    await authorityLock.query("BEGIN");
    await authorityLock.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `work-context:${SPACE}:${RUN}`,
    ]);
    let correctionSettled = false;
    const correctionPromise = continuity.correctSemanticCheckpoint({
      spaceId: SPACE,
      workContextScopeId: RUN,
      checkpointId: checkpoint!.id,
      identity: { spaceId: SPACE, userId: USER },
      canonicalRef: { type: "message", id: messageId },
      correction: { decision: "Use the corrected gateway decision." },
    }).finally(() => { correctionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settledWhileAuthorityLocked = correctionSettled;
    await authorityLock.query("COMMIT");
    authorityLock.release();
    expect(settledWhileAuthorityLocked).toBe(false);
    const correctionId = await correctionPromise;
    expect((await pool.query<{ jobs: number; micros: number }>(
      `SELECT
        (SELECT count(*)::int FROM jobs WHERE space_id=$1 AND job_type='runtime_context_checkpoint') AS jobs,
        (SELECT count(*)::int FROM context_micro_checkpoints WHERE space_id=$1 AND work_context_scope_id=$2) AS micros`,
      [SPACE, RUN],
    )).rows[0]).toEqual({ jobs: 1, micros: 1 });
    const corrected = await continuity.runSemanticExtraction({
      spaceId: SPACE,
      workContextScopeId: RUN,
      force: true,
    });
    expect(corrected).toMatchObject({
      version: 2,
      decisions: [{ text: "Use the corrected gateway decision.", confirmation_state: "corrected" }],
      correction_refs: [{ type: "checkpoint_correction", id: correctionId }],
    });
    await pool.query(
      `UPDATE runs SET owner_user_id=NULL,instructed_by_user_id=NULL WHERE id=$1`,
      [RUN],
    );
    await expect(continuity.correctSemanticCheckpoint({
      spaceId: SPACE,
      workContextScopeId: RUN,
      checkpointId: corrected!.id,
      identity: { spaceId: SPACE, userId: USER },
      canonicalRef: { type: "message", id: messageId },
      correction: { decision: "This revoked mutation must not commit." },
    })).rejects.toMatchObject({ statusCode: 404 });
    const versions = await pool.query<{ id: string; status: string; supersedes_id: string | null }>(
      `SELECT id,status,supersedes_id FROM context_semantic_checkpoints
        WHERE space_id=$1 AND work_context_scope_id=$2 ORDER BY version`,
      [SPACE, RUN],
    );
    expect(versions.rows).toEqual([
      expect.objectContaining({ id: checkpoint!.id, status: "superseded", supersedes_id: null }),
      expect.objectContaining({ id: corrected!.id, status: "active", supersedes_id: checkpoint!.id }),
    ]);
  });

  it("rejects canonical Messages that belong to a different work scope", async () => {
    if (!available || !pool) return;
    const otherSessionId = randomUUID();
    const otherMessageId = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,'active',now(),now())`,
      [otherSessionId, SPACE, USER],
    );
    await pool.query(
      `INSERT INTO messages (id,space_id,session_id,user_id,role,content,created_at)
       VALUES ($1,$2,$3,$4,'user','private other scope',now())`,
      [otherMessageId, SPACE, otherSessionId, USER],
    );
    const continuity = new RuntimeContextContinuityService(pool);
    await expect(continuity.ingest({
      invocation_id: RUN,
      event_type: "user_message_received",
      canonical_ref: { type: "message", id: otherMessageId },
      semantic_role: "user_input",
      token_estimate: 0,
    })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("loads the checkpoint and raw tail at the triggering Message watermark", async () => {
    if (!available || !pool) return;
    const sessionId = randomUUID();
    const earlierId = randomUUID();
    const currentId = randomUUID();
    const futureId = randomUUID();
    await pool.query(`INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ($1,$2,$3,'active',now(),now())`, [sessionId, SPACE, USER]);
    await pool.query(
      `INSERT INTO messages (id,space_id,session_id,user_id,role,content,created_at) VALUES
       ($1,$4,$5,$6,'user','earlier',now()-interval '3 minutes'),
       ($2,$4,$5,$6,'user','current',now()-interval '2 minutes'),
       ($3,$4,$5,$6,'user','future',now()-interval '1 minute')`,
      [earlierId, currentId, futureId, SPACE, sessionId, USER],
    );
    await pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`, [RUN, sessionId]);
    const continuity = new RuntimeContextContinuityService(pool, {
      async extract() {
        return {
          extraction: { goals: [], user_intent: [], decisions: [], constraints: [], facts: [], open_questions: [], tasks: [], artifact_refs: [], tool_refs: [], correction_refs: [] },
          extractorRef: { type: "provider_task", id: randomUUID(), version: "test.v1" },
        };
      },
    });
    const ingestMessage = (id: string) => continuity.ingest({
      invocation_id: RUN, event_type: "user_message_received",
      canonical_ref: { type: "message", id }, semantic_role: "user_input", token_estimate: 1,
    });
    await ingestMessage(earlierId);
    const earlierCheckpoint = await continuity.runSemanticExtraction({ spaceId: SPACE, workContextScopeId: RUN, force: true });
    await ingestMessage(currentId);
    await ingestMessage(futureId);
    await continuity.runSemanticExtraction({ spaceId: SPACE, workContextScopeId: RUN, force: true });
    const visible = await loadConversationContinuityThroughMessage(pool, {
      spaceId: SPACE, sessionId, workContextScopeId: RUN, currentMessageId: currentId,
    });
    expect(visible.checkpoint?.id).toBe(earlierCheckpoint?.id);
    expect(visible.messages.map((message) => message.content)).toEqual(["current"]);
  });

  it("keeps earlier messages that share the triggering message timestamp", async () => {
    if (!available || !pool) return;
    const sessionId = randomUUID();
    const earlierId = "30000000-0000-4000-8000-000000000020";
    const currentId = "30000000-0000-4000-8000-000000000021";
    const futureId = "30000000-0000-4000-8000-000000000022";
    const timestamp = "2026-08-17T14:00:00.000Z";
    await pool.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,'active',now(),now())`,
      [sessionId, SPACE, USER],
    );
    await pool.query(
      `INSERT INTO messages (id,space_id,session_id,user_id,role,content,created_at) VALUES
       ($1,$4,$5,$6,'user','earlier same timestamp',$7),
       ($2,$4,$5,$6,'user','current same timestamp',$7),
       ($3,$4,$5,$6,'user','future same timestamp',$7)`,
      [earlierId, currentId, futureId, SPACE, sessionId, USER, timestamp],
    );

    const visible = await loadConversationContinuityThroughMessage(pool, {
      spaceId: SPACE,
      sessionId,
      workContextScopeId: RUN,
      currentMessageId: currentId,
    });

    expect(visible.messages.map((message) => message.content)).toEqual([
      "earlier same timestamp",
      "current same timestamp",
    ]);
  });

  it("rejects concurrent extraction output based on a superseded checkpoint", async () => {
    if (!available || !pool) return;
    const releases: Array<() => void> = [];
    const continuity = new RuntimeContextContinuityService(pool, {
      async extract() {
        await new Promise<void>((resolve) => releases.push(resolve));
        return {
          extraction: { goals: [], user_intent: [], decisions: [], constraints: [], facts: [], open_questions: [], tasks: [], artifact_refs: [], tool_refs: [], correction_refs: [] },
          extractorRef: { type: "provider_task", id: randomUUID(), version: "test.v1" },
        };
      },
    });
    await continuity.ingest({
      invocation_id: RUN, event_type: "invocation_finalized",
      canonical_ref: { type: "run", id: RUN }, semantic_role: null, token_estimate: 0,
    });
    const first = continuity.runSemanticExtraction({ spaceId: SPACE, workContextScopeId: RUN, force: true });
    const second = continuity.runSemanticExtraction({ spaceId: SPACE, workContextScopeId: RUN, force: true });
    while (releases.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    releases[0]!();
    await expect(first).resolves.toBeDefined();
    releases[1]!();
    await expect(second).rejects.toMatchObject({ statusCode: 409 });
  });

  it("builds each Micro Checkpoint from the prior Micro event head", async () => {
    if (!available || !pool) return;
    const sessionId = randomUUID();
    const assistantId = randomUUID();
    await pool.query(`INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ($1,$2,$3,'active',now(),now())`, [sessionId, SPACE, USER]);
    await pool.query(`INSERT INTO messages (id,space_id,session_id,sender_agent_id,role,content,created_at) VALUES ($1,$2,$3,$4,'assistant','done',now())`, [assistantId, SPACE, sessionId, AGENT]);
    await pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`, [RUN, sessionId]);
    const continuity = new RuntimeContextContinuityService(pool);
    const first = await continuity.finalizeChatTurn({ invocationId: RUN, messageId: assistantId });
    await pool.query(
      `UPDATE jobs SET status='failed' WHERE space_id=$1 AND job_type='runtime_context_checkpoint'`,
      [SPACE],
    );
    const second = await continuity.finalizeChatTurn({ invocationId: RUN, messageId: assistantId });
    expect(first.message_refs).toEqual([{ type: "message", id: assistantId }]);
    expect(second.message_refs).toEqual([]);
    expect(second.event_head_cursor).toBe(first.event_head_cursor);
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs
        WHERE space_id=$1 AND job_type='runtime_context_checkpoint'`,
      [SPACE],
    )).rows[0]?.count).toBe(2);
  });
});

describe("Invocation Delivery and Snapshot persistence", () => {
  it("resolves direct Chat by invocation id and carries prior session turns behind the Gateway", async () => {
    if (!available || !pool) return;
    const sessionId = randomUUID();
    const priorMessageId = randomUUID();
    const priorReplyId = randomUUID();
    // Ties on created_at break on id (proven by the "keeps earlier messages
    // that share the triggering message timestamp" test above), so this
    // must sort lexically after MESSAGE (id ...007) to actually land after
    // the triggering point, not before it.
    const futureMessageId = "30000000-0000-4000-8000-000000000008";
    const decisionId = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,'active',now(),now())`,
      [sessionId, SPACE, USER],
    );
    await pool.query(
      `INSERT INTO messages
         (id,session_id,space_id,user_id,sender_agent_id,role,content,metadata_json,created_at)
       VALUES
         ($1,$4,$5,$6,NULL,'user','Remember the blue launch code.','{}',now()-interval '3 minutes'),
         ($2,$4,$5,NULL,$7,'assistant','I will remember blue.','{}',now()-interval '2 minutes'),
         ($3,$4,$5,$6,NULL,'user','What code did I choose?',jsonb_build_object('run_id',$8::text),now()-interval '1 minute'),
         ($9,$4,$5,$6,NULL,'user','This later turn must stay invisible.','{}',now()-interval '1 minute')`,
      [priorMessageId, priorReplyId, MESSAGE, sessionId, SPACE, USER, AGENT, RUN, futureMessageId],
    );
    await pool.query(
      `INSERT INTO policy_decision_records (
         id,space_id,actor_type,actor_id,action,resource_type,resource_id,
         decision,risk_level,policy_source,metadata_json,created_at
       ) VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,
                 'allow','medium','test','{}',now())`,
      [decisionId, SPACE, USER, SETUP],
    );
    await pool.query(
      `INSERT INTO work_context_setups (
         id,space_id,work_context_scope_id,scope_kind,version,user_id,
         project_id,project_folder_id,agent_id,runtime_ref_json,pinned_refs_json,
         excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,
         project_brief_version_id,project_instruction_version_id,project_instruction_enabled,
         governing_policy_refs_json,setup_fingerprint,base_version,typed_diff_json,reason,
         policy_decision_record_id,created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'direct_session',1,$4,NULL,NULL,$5,NULL,'[]','[]',
                 '{"enabled":false}','{}',NULL,NULL,TRUE,'[]','chat-setup',NULL,'{}',
                 'test',$6,$4,now())`,
      [SETUP, SPACE, sessionId, USER, AGENT, decisionId],
    );
    await pool.query(
      `INSERT INTO model_providers (
         id,space_id,owner_user_id,name,provider_type,base_url,enabled,
         capabilities_json,config_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'Local','ollama','http://localhost:11434',TRUE,'{}','{}',now(),now())`,
      [PROVIDER, SPACE, USER],
    );
    await pool.query(
      `INSERT INTO model_provider_space_grants (
         id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$4,TRUE,FALSE,now(),now())`,
      [randomUUID(), PROVIDER, SPACE, USER],
    );
    await pool.query(
      `UPDATE agent_versions SET model_config_json='{"model":"gpt-4o"}'::jsonb WHERE id=$1`,
      [VERSION],
    );
    await pool.query(
      `UPDATE runs SET session_id=$2,prompt='What code did I choose?',model_provider_id=$3,
         model_override_json=$4::jsonb WHERE id=$1`,
      [RUN, sessionId, PROVIDER, JSON.stringify({
        chat_turn: {
          schema_version: "chat_turn.v1",
          session_id: sessionId,
          user_id: USER,
          user_message_id: MESSAGE,
          agent_id: AGENT,
          agent_version_id: VERSION,
          project_id: null,
        },
      })],
    );
    const authoritative = control();
    authoritative.work_context_scope_id = sessionId;
    authoritative.work_context_setup_ref = {
      type: "work_context_setup",
      id: SETUP,
      version: "1",
    };
    authoritative.egress.sensitivity_ceiling = "highly_restricted";
    authoritative.readable_scope.sensitivity_ceiling = "highly_restricted";
    await pool.query(
      `UPDATE execution_control_snapshots SET snapshot_json=$2::jsonb WHERE id=$1`,
      [CONTROL, JSON.stringify(authoritative)],
    );

    const result = await createProductionRuntimeContextPlanningService(pool).planExecution({
      identity: { spaceId: SPACE, userId: USER },
      invocationId: RUN,
      deliveryId: randomUUID(),
      turn: {
        work_context_scope_id: sessionId,
        expected_setup_version: 1,
        current_message_ref: { type: "message", id: MESSAGE },
        one_off_refs: [],
        invocation_purpose: "agent_task",
      },
    });

    expect(result.envelope.items.find((item) => item.source_ref.id === MESSAGE)?.payload.text)
      .toBe("What code did I choose?");
    const continuity = result.envelope.items.find((item) => item.acquisition === "continuity");
    expect(continuity?.source_ref).toEqual({
      type: "session",
      id: sessionId,
    });
    expect(continuity?.payload.text).toContain("Remember the blue launch code.");
    expect(continuity?.payload.text).toContain("I will remember blue.");
    expect(continuity?.payload.text).not.toContain("This later turn must stay invisible.");
    expect(continuity?.payload.text).not.toContain("What code did I choose?");
    const snapshots = new InvocationSnapshotService(
      pool,
      undefined,
      new PgInvocationDeliveryAuthorizer(),
    );
    const create = (plannedEnvelope = result.envelope) => snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: plannedEnvelope,
      control: authoritative,
      adapterType: "model_api",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:chat`,
      viewerUserId: USER,
      requireLiveAuthorization: true,
    });
    await expect(create()).resolves.toBeDefined();
    await pool.query(
      `UPDATE runs
          SET model_override_json=jsonb_set(model_override_json,'{chat_turn,user_message_id}',$2::jsonb)
        WHERE id=$1`,
      [RUN, JSON.stringify(priorMessageId)],
    );
    await expect(create()).rejects.toMatchObject({ statusCode: 409 });
    await pool.query(
      `UPDATE runs
          SET model_override_json=jsonb_set(model_override_json,'{chat_turn,user_message_id}',$2::jsonb)
        WHERE id=$1`,
      [RUN, JSON.stringify(MESSAGE)],
    );
    const requiredTokens = result.envelope.items
      .filter((item) => item.selection !== "ranked")
      .reduce((sum, item) => sum + item.token_estimate, 0);
    const trimmedEnvelope = new RuntimeContextPlanner().plan({
      executionControlSnapshotId: CONTROL,
      setupRef: authoritative.work_context_setup_ref,
      turn: result.envelope.turn_request,
      model: "gpt-4o",
      outputReserveTokens: 0,
      modelWindowOverride: {
        contextWindowTokens: requiredTokens + 12,
        defaultOutputReserveTokens: 0,
        providerOverheadTokens: 0,
        catalogVersion: "test.trimmed-continuity.v1",
      },
      directItems: result.envelope.items.filter((item) => item.acquisition === "direct"),
      explicitItems: result.envelope.items.filter((item) => item.acquisition === "explicit"),
      continuityItems: result.envelope.items.filter((item) => item.acquisition === "continuity"),
      retrievalItems: result.envelope.items.filter((item) => item.acquisition === "retrieval"),
    });
    expect(trimmedEnvelope.window_plan.decisions.find((entry) => entry.item_id === continuity?.id))
      .toMatchObject({ decision: "trimmed", planned_tokens: 12 });
    await expect(create(trimmedEnvelope)).resolves.toBeDefined();
    await pool.query(`UPDATE sessions SET status='archived',updated_at=now() WHERE id=$1`, [sessionId]);
    await expect(create()).rejects.toMatchObject({ statusCode: 409 });
  });

  it("binds and atomically consumes the exact Runtime Host request", async () => {
    if (!available || !pool) return;
    const snapshots = new InvocationSnapshotService(pool);
    const first = await snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(),
      adapterType: "model_api",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:dispatch:1`,
    });
    const request = runtimeHostRequest(first.delivery);
    await expect(bindRuntimeHostDeliveryRequest(pool, request)).resolves.toBeUndefined();
    await expect(authorizeRuntimeHostDelivery(pool, request)).resolves.toBeUndefined();
    await expect(authorizeRuntimeHostDelivery(pool, request)).rejects.toMatchObject({ statusCode: 409 });
    const dispatched = (await pool.query<{ safe_snapshot_json: Record<string, unknown> }>(
      `SELECT safe_snapshot_json FROM invocation_snapshots WHERE id=$1`,
      [first.snapshot.id],
    )).rows[0]?.safe_snapshot_json;
    expect(dispatched).toMatchObject({
      dispatch: { request_fingerprint: expect.any(String), dispatched_at: expect.any(String) },
    });

    const second = await snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(),
      adapterType: "model_api",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:dispatch:2`,
    });
    const secondRequest = runtimeHostRequest(second.delivery);
    await expect(bindRuntimeHostDeliveryRequest(pool, secondRequest)).resolves.toBeUndefined();
    await expect(authorizeRuntimeHostDelivery(pool, {
      ...secondRequest,
      max_tokens: 999,
    })).rejects.toMatchObject({ statusCode: 409 });
    await expect(authorizeRuntimeHostDelivery(pool, secondRequest)).resolves.toBeUndefined();

    const third = await snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(),
      adapterType: "model_api",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:dispatch:3`,
    });
    const thirdRequest = runtimeHostRequest(third.delivery);
    await expect(bindRuntimeHostDeliveryRequest(pool, {
      ...thirdRequest,
      messages: [
        ...thirdRequest.messages!,
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call-a", name: "retrieval.search", arguments_json: "{}" },
            { id: "call-b", name: "retrieval.brief", arguments_json: "{}" },
          ],
        },
        { role: "tool", content: "a", tool_call_id: "call-a", name: "retrieval.search" },
        { role: "tool", content: "duplicate", tool_call_id: "call-a", name: "retrieval.search" },
      ],
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("stores safe attempts separately and audits authorized sealed replay reads", async () => {
    if (!available || !pool) return;
    const cipher = new SealedPayloadCipher(Buffer.alloc(32, 9));
    const snapshots = new InvocationSnapshotService(pool, cipher);
    const first = await snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(),
      adapterType: "model_api",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:attempt:1`,
      rawReplayPayload: { rendered_prompt: "never expose this raw replay" },
    });
    expect(first.snapshot.attempt).toBe(1);
    const stored = (await pool.query(
      `SELECT d.delivery_metadata_json,s.safe_snapshot_json,p.encrypted_payload
         FROM invocation_deliveries d
         JOIN invocation_snapshots s ON s.delivery_id=d.id
         JOIN sealed_invocation_payloads p ON p.invocation_snapshot_id=s.id
        WHERE d.id=$1`,
      [first.delivery.id],
    )).rows[0];
    expect(JSON.stringify(stored.delivery_metadata_json)).not.toContain("never expose");
    expect(JSON.stringify(stored.safe_snapshot_json)).not.toContain("never expose");
    expect(stored.encrypted_payload).not.toContain("never expose");

    const acknowledged = await snapshots.acknowledge({
      spaceId: SPACE,
      deliveryId: first.delivery.id,
      status: "accepted",
      actualTokens: 17,
    });
    expect(acknowledged).toMatchObject({ actual_tokens: 17, capture_status: "partial" });
    await expect(snapshots.acknowledge({
      spaceId: SPACE,
      deliveryId: first.delivery.id,
      status: "accepted",
      actualTokens: 17,
    })).resolves.toEqual(acknowledged);
    const finalized = await snapshots.finalize({
      spaceId: SPACE,
      invocationId: RUN,
      deliveryId: first.delivery.id,
      errorCode: "terminal-after-delivery",
    });
    expect(finalized.error_code).toBe("terminal-after-delivery");
    await expect(snapshots.finalize({
      spaceId: SPACE,
      invocationId: RUN,
      deliveryId: first.delivery.id,
      errorCode: "terminal-after-delivery",
    })).resolves.toEqual(finalized);
    await expect(snapshots.finalize({
      spaceId: SPACE,
      invocationId: RUN,
      deliveryId: first.delivery.id,
      errorCode: "different-final-state",
    })).rejects.toMatchObject({ statusCode: 409 });
    await expect(snapshots.acknowledge({
      spaceId: SPACE,
      deliveryId: first.delivery.id,
      status: "accepted",
      actualTokens: 17,
    })).resolves.toEqual(finalized);
    expect((await pool.query(
      `SELECT delivery_id FROM context_window_reconciliations WHERE delivery_id=$1`,
      [first.delivery.id],
    )).rows).toEqual([{ delivery_id: first.delivery.id }]);

    const second = await snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(),
      adapterType: "model_api",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:attempt:2`,
    });
    expect(second.snapshot.attempt).toBe(2);
    expect(second.delivery.id).not.toBe(first.delivery.id);
    const safeAttempts = await snapshots.listSafeForInvocation(SPACE, RUN);
    expect(safeAttempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(safeAttempts[0]).toMatchObject({
      id: first.snapshot.id,
      invocation_id: RUN,
      delivery_id: first.delivery.id,
    });
    expect(JSON.stringify(safeAttempts)).not.toContain("never expose this raw replay");
    expect(safeAttempts[0]).not.toHaveProperty("rendered_prompt");
    expect(safeAttempts[0]).not.toHaveProperty("context_body");
    expect(safeAttempts[0]).not.toHaveProperty("sealed_payload");
    await expect(snapshots.finalize({
      spaceId: SPACE,
      invocationId: RUN,
      deliveryId: second.delivery.id,
    })).rejects.toMatchObject({ statusCode: 409 });

    const denied = new SealedPayloadService(pool, cipher, { async authorize() { return false; } });
    await expect(denied.read({
      spaceId: SPACE,
      snapshotId: first.snapshot.id,
      viewerUserId: USER,
      reason: "incident review",
    })).rejects.toMatchObject({ statusCode: 403 });
    expect((await pool.query("SELECT 1 FROM sealed_invocation_payload_access_audits")).rows).toHaveLength(0);

    let authorizationDb: unknown;
    const sealed = new SealedPayloadService(pool, cipher, {
      async authorize(db) {
        authorizationDb = db;
        await db.query("SELECT 1");
        return true;
      },
    });
    await expect(sealed.read({
      spaceId: SPACE,
      snapshotId: first.snapshot.id,
      viewerUserId: USER,
      reason: "incident review",
    })).resolves.toEqual({ rendered_prompt: "never expose this raw replay" });
    expect(authorizationDb).not.toBe(pool);
    expect((await pool.query("SELECT reason FROM sealed_invocation_payload_access_audits")).rows)
      .toEqual([{ reason: "incident review" }]);
    await pool.query(
      `UPDATE sealed_invocation_payloads SET retention_deadline=retention_deadline+interval '1 hour'
        WHERE invocation_snapshot_id=$1`,
      [first.snapshot.id],
    );
    await expect(sealed.read({
      spaceId: SPACE,
      snapshotId: first.snapshot.id,
      viewerUserId: USER,
      reason: "tamper check",
    })).rejects.toThrow();
  });

  it("rejects caller controls that differ from the persisted authority", async () => {
    if (!available || !pool) return;
    const snapshots = new InvocationSnapshotService(pool, new SealedPayloadCipher(Buffer.alloc(32, 11)));
    const forged = control(60);
    forged.egress.allowed_provider_ids = ["30000000-0000-4000-8000-000000000099"];
    await expect(snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: forged,
      adapterType: "model_api",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: "usage-forged",
    })).rejects.toMatchObject({ statusCode: 409 });
    expect((await pool.query("SELECT 1 FROM invocation_deliveries")).rows).toHaveLength(0);
  });

  it("reauthorizes the persisted Run adapter and provider inside attempt creation", async () => {
    if (!available || !pool) return;
    const authoritative = control(0);
    authoritative.work_context_setup_ref = { type: "work_context_setup", id: SETUP, version: "1" };
    authoritative.project_id = PROJECT;
    authoritative.project_folder_id = FOLDER;
    authoritative.readable_scope.retrieval_enabled = true;
    authoritative.readable_scope.retrieval_max_candidates = 10;
    await pool.query(
      `INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at)
       VALUES ($1,$2,$3,'Delivery Project','active',now(),now())`,
      [PROJECT, SPACE, USER],
    );
    await pool.query(
      `INSERT INTO project_folders (
         id,space_id,project_id,created_by_user_id,name,status,kind,is_primary,
         execution_enabled,protected,system_managed,host_id,host_kind,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,'Delivery Folder','active','code',TRUE,TRUE,FALSE,FALSE,$5,'server',now(),now())`,
      [FOLDER, SPACE, PROJECT, USER, HOST],
    );
    const instructionId = randomUUID();
    await pool.query(
      `INSERT INTO project_instruction_versions (
         id,space_id,project_id,version,title,instruction_text,status,
         reviewed_by_user_id,reviewed_at,published_by_user_id,published_at,
         created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'v1','Delivery instruction','Follow delivery rules.','published',
                 $4,now(),$4,now(),$4,now())`,
      [instructionId, SPACE, PROJECT, USER],
    );
    await pool.query(
      `UPDATE projects SET active_instruction_version_id=$1 WHERE id=$2 AND space_id=$3`,
      [instructionId, PROJECT, SPACE],
    );
    authoritative.project_instruction_ref = {
      type: "project_instruction_version",
      id: instructionId,
      version: "v1",
    };
    await pool.query(
      `INSERT INTO policy_decision_records (
         id,space_id,actor_type,actor_id,action,resource_type,resource_id,
         decision,risk_level,policy_source,metadata_json,created_at
       ) VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,
                 'allow','medium','test','{}',now())`,
      [randomUUID(), SPACE, USER, SETUP],
    );
    const decision = (await pool.query<{ id: string }>(
      `SELECT id FROM policy_decision_records WHERE resource_id=$1`, [SETUP],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO work_context_setups (
         id,space_id,work_context_scope_id,scope_kind,version,user_id,
         project_id,project_folder_id,agent_id,runtime_ref_json,pinned_refs_json,
         excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,
         project_brief_version_id,project_instruction_version_id,project_instruction_enabled,
         governing_policy_refs_json,setup_fingerprint,base_version,typed_diff_json,reason,
         policy_decision_record_id,created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'root_task',1,$4,$7,$8,$5,NULL,'[]','[]','{}','{}',
                 NULL,NULL,TRUE,'[]','delivery-authority',NULL,'{}','test',$6,$4,now())`,
      [SETUP, SPACE, RUN, USER, AGENT, decision, PROJECT, FOLDER],
    );
    await pool.query(
      `INSERT INTO model_providers (
         id,space_id,owner_user_id,name,provider_type,base_url,enabled,
         capabilities_json,config_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'Local','ollama','http://localhost:11434',TRUE,'{}','{}',now(),now())`,
      [PROVIDER, SPACE, USER],
    );
    await pool.query(
      `INSERT INTO model_provider_space_grants (
         id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$4,TRUE,FALSE,now(),now())`,
      [randomUUID(), PROVIDER, SPACE, USER],
    );
    await pool.query(
      `UPDATE runs SET model_provider_id=$2,project_id=$3,project_folder_id=$4,prompt='Private question' WHERE id=$1`,
      [RUN, PROVIDER, PROJECT, FOLDER],
    );
    await pool.query(
      `UPDATE execution_control_snapshots SET snapshot_json=$2::jsonb WHERE id=$1`,
      [CONTROL, JSON.stringify(authoritative)],
    );
    const runRequest = normalizeContextItem({
      sourceRef: { type: "run_request", id: RUN },
      acquisition: "direct",
      selection: "required",
      semanticRole: "user_input",
      trust: "user_confirmed",
      sensitivity: "normal",
      visibility: "private",
      ownerUserId: USER,
      spaceId: SPACE,
      egressEligible: true,
      text: "Private question",
      revalidation: { status: "live", checked_at: "2026-08-09T00:00:00.000Z" },
    });
    const instruction = normalizeContextItem({
      sourceRef: authoritative.project_instruction_ref,
      acquisition: "direct",
      selection: "required",
      semanticRole: "delegated_instruction",
      trust: "system_approved",
      sensitivity: "normal",
      visibility: "private",
      ownerUserId: USER,
      spaceId: SPACE,
      egressEligible: true,
      text: "Follow delivery rules.",
      revalidation: { status: "live", checked_at: "2026-08-09T00:00:00.000Z" },
    });
    const planned = new RuntimeContextPlanner().plan({
      executionControlSnapshotId: CONTROL,
      setupRef: authoritative.work_context_setup_ref,
      turn: {
        work_context_scope_id: RUN,
        expected_setup_version: 1,
        current_message_ref: { type: "run_request", id: RUN },
        one_off_refs: [],
        invocation_purpose: "agent_task",
      },
      model: "gpt-4o",
      directItems: [runRequest, instruction],
    });
    const snapshots = new InvocationSnapshotService(
      pool,
      undefined,
      new PgInvocationDeliveryAuthorizer(),
    );
    const create = (adapterType: string) => snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: planned,
      control: authoritative,
      adapterType,
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:${adapterType}`,
      viewerUserId: USER,
      requireLiveAuthorization: true,
    });
    await expect(create("model_api")).resolves.toBeDefined();
    await expect(create("ts_agent_host")).rejects.toMatchObject({ statusCode: 409 });
    await pool.query(
      `UPDATE model_provider_space_grants SET enabled=FALSE WHERE provider_id=$1 AND space_id=$2`,
      [PROVIDER, SPACE],
    );
    await expect(create("model_api")).rejects.toMatchObject({ statusCode: 409 });
    await pool.query(
      `UPDATE model_provider_space_grants SET enabled=TRUE WHERE provider_id=$1 AND space_id=$2`,
      [PROVIDER, SPACE],
    );
    await pool.query(`UPDATE project_folders SET status='archived',updated_at=now() WHERE id=$1`, [FOLDER]);
    await expect(create("model_api")).rejects.toMatchObject({ statusCode: 404 });

    await pool.query(`UPDATE project_folders SET status='active',updated_at=now() WHERE id=$1`, [FOLDER]);
    const sourceUpdatedAt = "2026-08-09T01:00:00.000Z";
    await pool.query(
      `INSERT INTO project_public_summaries (
         id,space_id,project_id,summary_text,topics_json,highlights_json,source_refs_json,
         redaction_version,review_status,updated_by_user_id,created_at,updated_at
       ) VALUES ($1,$2,$3,'Current summary','[]','[]','[]','v1','approved',$4,$5,$5)`,
      [randomUUID(), SPACE, PROJECT, USER, sourceUpdatedAt],
    );
    const retrieved = normalizeContextItem({
      sourceRef: { type: "project_public_summary", id: PROJECT },
      acquisition: "retrieval",
      selection: "ranked",
      rank: 1,
      semanticRole: "reference_data",
      trust: "derived",
      sensitivity: "normal",
      visibility: "private",
      ownerUserId: USER,
      spaceId: SPACE,
      egressEligible: true,
      text: "Delivery Project\nCurrent summary",
      revalidation: {
        status: "live",
        checked_at: sourceUpdatedAt,
        source_updated_at: sourceUpdatedAt,
        source_connection_ids: [],
      },
    });
    const sourcePlan = new RuntimeContextPlanner().plan({
      executionControlSnapshotId: CONTROL,
      setupRef: authoritative.work_context_setup_ref,
      turn: planned.turn_request,
      model: "gpt-4o",
      directItems: planned.items,
      retrievalItems: [retrieved],
    });
    const createWithSource = () => snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: sourcePlan,
      control: authoritative,
      adapterType: "model_api",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:source`,
      viewerUserId: USER,
      requireLiveAuthorization: true,
    });
    await expect(createWithSource()).resolves.toBeDefined();
    await pool.query(
      `UPDATE project_public_summaries SET review_status='archived',updated_at=now() WHERE project_id=$1`,
      [PROJECT],
    );
    await expect(createWithSource()).rejects.toMatchObject({ statusCode: 409 });

    const replacementInstructionId = randomUUID();
    await pool.query(
      `UPDATE project_instruction_versions SET status='archived' WHERE id=$1`,
      [instructionId],
    );
    await pool.query(
      `INSERT INTO project_instruction_versions (
         id,space_id,project_id,version,title,instruction_text,status,
         reviewed_by_user_id,reviewed_at,published_by_user_id,published_at,
         created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'v2','Replacement instruction','Use the replacement.','published',
                 $4,now(),$4,now(),$4,now())`,
      [replacementInstructionId, SPACE, PROJECT, USER],
    );
    await pool.query(
      `UPDATE projects SET active_instruction_version_id=$1 WHERE id=$2 AND space_id=$3`,
      [replacementInstructionId, PROJECT, SPACE],
    );
    await expect(create("model_api")).rejects.toMatchObject({ statusCode: 409 });
  });

  /**
   * Reauthorizing an Inquiry Thread pins the viewer's project membership row
   * for the transaction. The lock was written against the nullable side of an
   * outer join, which PostgreSQL rejects outright — so every Delivery carrying
   * a Thread failed with a database error, not a policy decision, and screening
   * reported "0/N items classified". A fake `Queryable` accepts that SQL
   * happily; only a real server refuses it.
   */
  it("locks Inquiry Thread membership without tripping PostgreSQL's outer-join lock rule", async () => {
    if (!available || !pool) return;
    const authoritative = control(0);
    authoritative.project_id = PROJECT;
    authoritative.work_context_setup_ref = { type: "work_context_setup", id: SETUP, version: "1" };
    authoritative.readable_scope.retrieval_enabled = true;
    authoritative.readable_scope.retrieval_max_candidates = 10;
    await pool.query(
      `INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at)
       VALUES ($1,$2,$3,'Inquiry Project','active',now(),now())`,
      [PROJECT, SPACE, USER],
    );
    const threadSessionId = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ($1,$2,$3,'active',now(),now())`,
      [threadSessionId, SPACE, USER],
    );
    await pool.query(
      `INSERT INTO messages (id,space_id,session_id,user_id,role,content,metadata_json,created_at)
       VALUES ($1,$2,$3,$4,'user','Private question',$5::jsonb,now())`,
      [MESSAGE, SPACE, threadSessionId, USER, JSON.stringify({ run_id: RUN })],
    );
    const setupDecisionId = randomUUID();
    await pool.query(
      `INSERT INTO policy_decision_records (
         id,space_id,actor_type,actor_id,action,resource_type,resource_id,
         decision,risk_level,policy_source,metadata_json,created_at
       ) VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,
                 'allow','medium','test','{}',now())`,
      [setupDecisionId, SPACE, USER, SETUP],
    );
    await pool.query(
      `INSERT INTO work_context_setups (
         id,space_id,work_context_scope_id,scope_kind,version,user_id,project_id,agent_id,
         runtime_ref_json,pinned_refs_json,excluded_refs_json,retrieval_preferences_json,
         continuity_preferences_json,project_instruction_enabled,governing_policy_refs_json,
         setup_fingerprint,base_version,typed_diff_json,reason,policy_decision_record_id,
         created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'root_task',1,$4,$5,$6,NULL,'[]','[]','{}','{}',FALSE,'[]',
                 'inquiry-thread-authority',NULL,'{}','test',$7,$4,now())`,
      [SETUP, SPACE, RUN, USER, PROJECT, AGENT, setupDecisionId],
    );
    const statement = "Does the control group hold?";
    const threadUpdatedAt = "2026-08-12T02:00:00.000Z";
    await pool.query(
      `INSERT INTO space_objects (id,space_id,object_type,title,visibility,access_level,owner_user_id,primary_project_id,created_at,updated_at)
       VALUES ($1,$2,'inquiry_thread',$3,'space_shared','full',$4,$5,$6,$6)`,
      [THREAD, SPACE, statement, USER, PROJECT, threadUpdatedAt],
    );
    await pool.query(
      `INSERT INTO inquiry_threads (object_id,space_id,project_id,kind,statement,lifecycle_status)
       VALUES ($1,$2,$3,'question',$4,'active')`,
      [THREAD, SPACE, PROJECT, statement],
    );
    await pool.query(
      `INSERT INTO model_providers (
         id,space_id,owner_user_id,name,provider_type,base_url,enabled,
         capabilities_json,config_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'Local','ollama','http://localhost:11434',TRUE,'{}','{}',now(),now())`,
      [PROVIDER, SPACE, USER],
    );
    await pool.query(
      `INSERT INTO model_provider_space_grants (
         id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$4,TRUE,FALSE,now(),now())`,
      [randomUUID(), PROVIDER, SPACE, USER],
    );
    await pool.query(
      `UPDATE runs SET model_provider_id=$2,project_id=$3,session_id=$4,prompt='Private question',
         model_override_json=$5::jsonb WHERE id=$1`,
      [RUN, PROVIDER, PROJECT, threadSessionId, JSON.stringify({
        chat_turn: {
          schema_version: "chat_turn.v1",
          session_id: threadSessionId,
          user_id: USER,
          user_message_id: MESSAGE,
          agent_id: AGENT,
          agent_version_id: VERSION,
          project_id: PROJECT,
        },
      })],
    );
    await pool.query(
      `UPDATE execution_control_snapshots SET snapshot_json=$2::jsonb WHERE id=$1`,
      [CONTROL, JSON.stringify(authoritative)],
    );

    const thread = normalizeContextItem({
      sourceRef: { type: "inquiry_thread", id: THREAD },
      acquisition: "retrieval",
      selection: "ranked",
      rank: 1,
      semanticRole: "reference_data",
      trust: "derived",
      sensitivity: "normal",
      visibility: "private",
      ownerUserId: USER,
      spaceId: SPACE,
      egressEligible: true,
      text: statement,
      revalidation: {
        status: "live",
        checked_at: threadUpdatedAt,
        source_updated_at: threadUpdatedAt,
        source_connection_ids: [],
      },
    });
    // This test exercises requireLiveAuthorization: true, which checks the
    // message's trust classification against its role (gateway.ts
    // authorizeMessageSource) — a 'user' role message must carry
    // user_confirmed, not the shared helper's default domain_approved.
    const planned = envelope("user_confirmed");
    const plan = new RuntimeContextPlanner().plan({
      executionControlSnapshotId: CONTROL,
      setupRef: authoritative.work_context_setup_ref,
      turn: planned.turn_request,
      model: "gpt-4o",
      directItems: planned.items,
      retrievalItems: [thread],
    });
    const snapshots = new InvocationSnapshotService(
      pool,
      new SealedPayloadCipher(Buffer.alloc(32, 13)),
      new PgInvocationDeliveryAuthorizer(),
    );
    const createAttempt = () => snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: plan,
      control: authoritative,
      adapterType: "model_api",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:thread`,
      viewerUserId: USER,
      requireLiveAuthorization: true,
    });

    await expect(createAttempt()).resolves.toBeDefined();

    // A non-member has no membership row to pin, which is an ordinary outcome
    // and not an error — the reason the join was written outer in the first
    // place. Personal-Space read authority still admits the read.
    await pool.query(`DELETE FROM project_members WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT]);
    await expect(createAttempt()).resolves.toBeDefined();
  });

  it("rolls back the window plan when Delivery rendering fails", async () => {
    if (!available || !pool) return;
    const deliveryId = "30000000-0000-4000-8000-000000000099";
    const snapshots = new InvocationSnapshotService(pool);
    await expect(snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(),
      adapterType: "model_api",
      providerId: PROVIDER,
      model: "wrong-model",
      usageSourceId: "failed-render",
      deliveryId,
    })).rejects.toThrow("planned model");
    expect((await pool.query(
      `SELECT 1 FROM context_window_reconciliations WHERE delivery_id=$1`, [deliveryId],
    )).rows).toHaveLength(0);
  });

  it("fails closed when retention disables raw persistence and deletes expired ciphertext", async () => {
    if (!available || !pool) return;
    const cipher = new SealedPayloadCipher(Buffer.alloc(32, 10));
    const snapshots = new InvocationSnapshotService(pool, cipher);
    await pool.query(
      `UPDATE execution_control_snapshots SET snapshot_json=$2::jsonb WHERE id=$1`,
      [CONTROL, JSON.stringify(control(0))],
    );
    await expect(snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(0),
      adapterType: "model_api",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: "usage-disabled",
      rawReplayPayload: { raw: true },
    })).rejects.toThrow("prohibit");
    expect((await pool.query("SELECT 1 FROM invocation_snapshots")).rows).toHaveLength(0);

    await pool.query(
      `UPDATE execution_control_snapshots SET snapshot_json=$2::jsonb WHERE id=$1`,
      [CONTROL, JSON.stringify(control(60))],
    );
    const created = await snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(60),
      adapterType: "model_api",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: "usage-expiring",
      rawReplayPayload: { raw: true },
    });
    await pool.query(
      `UPDATE sealed_invocation_payloads SET retention_deadline=now()-interval '1 second'
        WHERE invocation_snapshot_id=$1`,
      [created.snapshot.id],
    );
    const sealed = new SealedPayloadService(pool, cipher, { async authorize() { return true; } });
    await expect(sealed.read({
      spaceId: SPACE,
      snapshotId: created.snapshot.id,
      viewerUserId: USER,
      reason: "expired check",
    })).rejects.toMatchObject({ statusCode: 410 });
    expect((await pool.query(
      `SELECT encrypted_payload,deleted_at FROM sealed_invocation_payloads WHERE invocation_snapshot_id=$1`,
      [created.snapshot.id],
    )).rows[0]).toMatchObject({ encrypted_payload: null });
  });
});
