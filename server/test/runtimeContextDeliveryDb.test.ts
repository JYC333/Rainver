import { assertSelectedSkillBindings } from "../src/modules/skills/selectedSkills.js";
import { SkillPackageSchema } from "@rainver/protocol";
import { previewSkillFiles } from "../src/modules/skills/skillImporter.js";
import { applySkillPackageBinding } from "../src/modules/skills/skillBindings.js";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository.js";
import { loadConfig } from "../src/config.js";
import { withTransaction } from "../src/db/tx.js";
import { PgSkillsRepository, approveSkillImportInTransaction } from "../src/modules/skills/repository.js";
import { createHash, randomUUID } from "node:crypto";
import { seedServerHost, seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgRuntimeSkillProvider } from "../src/modules/skills/runtimeSkillProvider.js";
import type { ExecutionControlSnapshot } from "@rainver/protocol";
import { InvocationSnapshotService, SealedPayloadService } from "../src/modules/runtimeContext/invocationSnapshotService.js";
import { PgInvocationDeliveryAuthorizer, createProductionRuntimeContextInvocationGateway } from "../src/modules/runtimeContext/gateway.js";
import { RuntimeContextContinuityService } from "../src/modules/runtimeContext/continuity/service.js";
import { RuntimeContextPlanner } from "../src/modules/runtimeContext/planner.js";
import { SealedPayloadCipher } from "../src/modules/runtimeContext/sealedPayloadCrypto.js";
import { createProductionRuntimeContextPlanningService } from "../src/modules/runtimeContext/productionAcquisition.js";
import { loadConversationContinuityThroughMessage } from "../src/modules/runtimeContext/conversationContinuity.js";
import { normalizeContextItem } from "../src/modules/runtimeContext/itemNormalizer.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildRunToolGrants } from "../src/modules/systemActions/runToolGrants.js";
import { seedConversationMessages } from "./support/domainSeeds.js";
import { syncBuiltinSkillPackages } from "../src/modules/skills/builtinPackages.js";
import { builtinSkillFixture } from "./support/builtinSkillFixture.js";
import { PgProposalApplyService } from "../src/modules/proposals/applyService.js";

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
const PROFILE = "30000000-0000-4000-8000-000000000015";


const db = useTestDatabase(import.meta.filename, { max: 2 });
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["context_checkpoint_corrections", "context_semantic_checkpoints", "context_micro_checkpoints", "context_capture_gaps", "context_events", "context_event_scopes", "sealed_invocation_payload_access_audits", "sealed_invocation_payloads", "invocation_snapshots", "invocation_deliveries", "context_window_reconciliations", "execution_control_snapshots", "workspace_locations", "users", "spaces", "hosts", "machines"],
    { cascade: true },
  );
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Delivery','personal',now(),now())`, [SPACE]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,'Owner','active',now(),now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [USER]);
  await seedServerHost(db.pool, {
    id: HOST,
    installations: {
      opencode: [{ id: "managed:1.0.0", version: "1.0.0", logged_in: true, options: null, health_check_protocol: "acp" }],
    },
  });
  await db.pool.query(
    `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
     VALUES ($1,$2,$3,'owner','active',now(),now())`,
    ["30000000-0000-4000-8000-000000000010", SPACE, USER],
  );
  await db.pool.query(
    `INSERT INTO agents (id,space_id,owner_user_id,name,status,agent_kind,created_at,updated_at,visibility,access_level)
     VALUES ($1,$2,$3,'Agent','active','standard',now(),now(),'private','full')`,
    [AGENT, SPACE, USER],
  );
  await db.pool.query(
    `INSERT INTO agent_versions (id,agent_id,space_id,version_label,system_prompt,context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,created_at)
     VALUES ($1,$2,$3,'v1','test','{}','{}','[]','{}',now())`,
    [VERSION, AGENT, SPACE],
  );
  await db.pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [AGENT, VERSION]);
  await db.pool.query(
    `INSERT INTO agent_runtime_profiles (
       id,space_id,agent_id,execution_host_id,workspace_mode,runtime_installation,
       name,runtime_key,backend_mode,runtime_config_json,runtime_policy_json,
       enabled,is_default,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,'managed','managed:1.0.0','Default','opencode','runtime_native','{}','{}',true,true,now(),now())`,
    [PROFILE, SPACE, AGENT, HOST],
  );
  await db.pool.query(
    `INSERT INTO runs (
       id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
       runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,
       required_sandbox_level,instructed_by_user_id,owner_user_id,created_at,updated_at,execution_kind
     ) VALUES (
       $1,$2,$3,$4,'agent','manual','running','live',$6,'default','opencode',
       '{"id":"30000000-0000-4000-8000-000000000015","runtime_key":"opencode","backend_mode":"runtime_native","runtime_config_json":{},"runtime_policy_json":{}}'::jsonb,
       'none',$5,$5,now(),now(),'agent'
     )`,
    [RUN, SPACE, AGENT, VERSION, USER, PROFILE],
  );
  await db.pool.query(
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

describe("Context Event continuity and checkpoints", () => {
  it("allocates dense idempotent scope sequences and exposes durable gaps", async () => {
    if (!db.available) return;
    const continuity = new RuntimeContextContinuityService(db.pool);
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
    const state = await db.pool.query<{ event_head_cursor: number; checkpoint_cursor: number; capture_status: string }>(
      `SELECT event_head_cursor,checkpoint_cursor,capture_status FROM context_event_scopes
        WHERE space_id=$1 AND work_context_scope_id=$2`,
      [SPACE, RUN],
    );
    expect(state.rows[0]).toMatchObject({ event_head_cursor: 2, checkpoint_cursor: 0, capture_status: "partial" });
    // The gap stays on record with the event it buffered: the ledger is an
    // audit of what was captured, and nothing rewrites it afterwards.
    const gap = await db.pool.query<{ status: string; replay_event_json: { event_type: string } }>(
      `SELECT status,replay_event_json FROM context_capture_gaps WHERE space_id=$1 AND work_context_scope_id=$2`,
      [SPACE, RUN],
    );
    expect(gap.rows[0]).toMatchObject({ status: "open", replay_event_json: { event_type: "buffered_runtime_notice" } });
  });

  it("marks a snapshot complete only with its committed terminal event and checkpoint", async () => {
    if (!db.available) return;
    const continuity = new RuntimeContextContinuityService(db.pool);
    const snapshots = new InvocationSnapshotService(db.pool, undefined, undefined, continuity);
    const created = await snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(),
      runtimeKey: "opencode",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: "continuity-finalize",
    });
    const taint = await db.pool.query<{
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
    expect((await db.pool.query(
      `SELECT scope_sequence,event_type,canonical_ref_json->>'id' AS ref_id
         FROM context_events WHERE space_id=$1 AND work_context_scope_id=$2`,
      [SPACE, RUN],
    )).rows).toEqual([{ scope_sequence: 1, event_type: "invocation_finalized", ref_id: created.snapshot.id }]);
    // The ledger is audited, not extracted from: finalization schedules no job.
    expect((await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs WHERE space_id=$1 AND job_type LIKE 'runtime_context%'`,
      [SPACE],
    )).rows[0]?.count).toBe(0);
  });

  it("rejects canonical Messages that belong to a different work scope", async () => {
    if (!db.available) return;
    const otherSessionId = randomUUID();
    const otherMessageId = randomUUID();
    await db.pool.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,'active',now(),now())`,
      [otherSessionId, SPACE, USER],
    );
    await seedConversationMessages(db.pool, {
      space: SPACE, session: otherSessionId,
      messages: [{ id: otherMessageId, role: "user", content: "private other scope", userId: USER }],
    });
    const continuity = new RuntimeContextContinuityService(db.pool);
    await expect(continuity.ingest({
      invocation_id: RUN,
      event_type: "user_message_received",
      canonical_ref: { type: "message", id: otherMessageId },
      semantic_role: "user_input",
      token_estimate: 0,
    })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("keeps earlier messages that share the triggering message timestamp", async () => {
    if (!db.available) return;
    const sessionId = randomUUID();
    const earlierId = "30000000-0000-4000-8000-000000000020";
    const currentId = "30000000-0000-4000-8000-000000000021";
    const futureId = "30000000-0000-4000-8000-000000000022";
    const timestamp = "2026-08-17T14:00:00.000Z";
    await db.pool.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,'active',now(),now())`,
      [sessionId, SPACE, USER],
    );
    await seedConversationMessages(db.pool, {
      space: SPACE, session: sessionId,
      messages: [
        { id: earlierId, role: "user", content: "earlier same timestamp", userId: USER, createdAt: timestamp },
        { id: currentId, role: "user", content: "current same timestamp", userId: USER, createdAt: timestamp },
        { id: futureId, role: "user", content: "future same timestamp", userId: USER, createdAt: timestamp },
      ],
    });

    const visible = await loadConversationContinuityThroughMessage(db.pool, {
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

  it.each(["partial", "out-of-order", "complete"])("keeps canonical message order and the trigger boundary with %s ledger capture", async (capture) => {
    if (!db.available) return;
    const sessionId = randomUUID();
    const earlierId = randomUUID();
    const currentId = randomUUID();
    const futureId = randomUUID();
    await db.pool.query(`INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ($1,$2,$3,'active',now(),now())`, [sessionId, SPACE, USER]);
    await seedConversationMessages(db.pool, {
      space: SPACE, session: sessionId,
      messages: [
        { id: earlierId, role: "user", content: "earlier on the path", userId: USER, createdAt: "2026-08-17T14:03:00.000Z" },
        { id: currentId, role: "user", content: "current trigger", userId: USER, createdAt: "2026-08-17T14:02:00.000Z" },
        { id: futureId, role: "user", content: "later on the path", userId: USER, createdAt: "2026-08-17T14:01:00.000Z" },
      ],
    });
    await db.pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`, [RUN, sessionId]);
    const continuity = new RuntimeContextContinuityService(db.pool);
    const capturedIds = capture === "partial" ? [currentId]
      : capture === "out-of-order" ? [futureId, currentId, earlierId]
        : [earlierId, currentId, futureId];
    for (const id of capturedIds) await continuity.ingest({
      invocation_id: RUN, event_type: "user_message_received",
      canonical_ref: { type: "message", id }, semantic_role: "user_input", token_estimate: 1,
    });
    const visible = await loadConversationContinuityThroughMessage(db.pool, {
      spaceId: SPACE, sessionId, workContextScopeId: RUN, currentMessageId: currentId,
    });
    expect(visible.messages.map((message) => message.content)).toEqual(["earlier on the path", "current trigger"]);
  });

  it("builds each Micro Checkpoint from the prior Micro event head", async () => {
    if (!db.available) return;
    const sessionId = randomUUID();
    const assistantId = randomUUID();
    await db.pool.query(`INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ($1,$2,$3,'active',now(),now())`, [sessionId, SPACE, USER]);
    await seedConversationMessages(db.pool, {
      space: SPACE, session: sessionId,
      messages: [{ id: assistantId, role: "assistant", content: "done", senderAgentId: AGENT }],
    });
    await db.pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`, [RUN, sessionId]);
    const continuity = new RuntimeContextContinuityService(db.pool);
    const first = await continuity.finalizeChatTurn({ invocationId: RUN, messageId: assistantId });
    const second = await continuity.finalizeChatTurn({ invocationId: RUN, messageId: assistantId });
    expect(first.message_refs).toEqual([{ type: "message", id: assistantId }]);
    expect(second.message_refs).toEqual([]);
    expect(second.event_head_cursor).toBe(first.event_head_cursor);
  });
});

describe("Invocation Delivery and Snapshot persistence", () => {
  it.each(["none", "saved", "draft", "skill", "skill_project", "builtin_skill"] as const)("authorizes direct Chat with %s input resources and prior session turns", async (sourceState) => {
    if (!db.available) return;
    const skillMode = sourceState === "skill" || sourceState === "skill_project" || sourceState === "builtin_skill";
    const candidates = skillMode ? vi.spyOn(PgRuntimeSkillProvider.prototype, "loadCandidatesForRun") : null;
    const sessionId = randomUUID();
    const priorMessageId = randomUUID();
    const priorReplyId = randomUUID();
    // Ties on created_at break on id (proven by the "keeps earlier messages
    // that share the triggering message timestamp" test above), so this
    // must sort lexically after MESSAGE (id ...007) to actually land after
    // the triggering point, not before it.
    const futureMessageId = "30000000-0000-4000-8000-000000000008";
    const decisionId = randomUUID();
    await db.pool.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,'active',now(),now())`,
      [sessionId, SPACE, USER],
    );
    // The last turn sits after the triggering message on the same branch: the
    // window is bounded by the trigger, so it must not appear in it.
    await seedConversationMessages(db.pool, {
      space: SPACE, session: sessionId,
      messages: [
        { id: priorMessageId, role: "user", content: "Remember the blue launch code.", userId: USER, metadata: {} },
        { id: priorReplyId, role: "assistant", content: "I will remember blue.", senderAgentId: AGENT, metadata: {} },
        { id: MESSAGE, role: "user", content: "What code did I choose?", userId: USER, runId: RUN, metadata: {} },
        { id: futureMessageId, role: "user", content: "This later turn must stay invisible.", userId: USER, metadata: {} },
      ],
    });
    if (sourceState === "saved" || sourceState === "draft") {
      const content = "Captured file body";
      const hash = createHash("sha256").update(content).digest("hex");
      const blobId = randomUUID();
      const resourceId = randomUUID();
      await db.pool.query(
        `INSERT INTO conversation_input_resource_blobs
           (id,space_id,owner_user_id,sha256,byte_size,line_count,content,created_at)
         VALUES ($1,$2,$3,$4,$5,1,$6,now())`,
        [blobId, SPACE, USER, hash, Buffer.byteLength(content), content],
      );
      await db.pool.query(
        `INSERT INTO conversation_input_resources
           (id,space_id,session_id,message_id,blob_id,source_kind,source_state,
            relative_path,display_name,media_type,byte_size,sha256,draft_id,draft_version,captured_at)
         VALUES ($1,$2,$3,$4,$5,CASE WHEN $6='draft' THEN 'project_file_draft' ELSE 'project_file' END,
                 $6,'README.md','README.md','text/markdown',
                 $7,$8,$9,$10,now())`,
        [resourceId, SPACE, sessionId, MESSAGE, blobId, sourceState, Buffer.byteLength(content), hash,
          sourceState === "draft" ? randomUUID() : null, sourceState === "draft" ? 1 : null],
      );
      await db.pool.query(
        `INSERT INTO message_input_parts
           (id,space_id,session_id,message_id,position,kind,resource_id,display_name,media_type,byte_size,sha256)
         VALUES ($1,$2,$3,$4,0,'input_resource',$5,'README.md','text/markdown',$6,$7)`,
        [randomUUID(), SPACE, sessionId, MESSAGE, resourceId, Buffer.byteLength(content), hash],
      );
    }
    let skillPackageId: string | undefined;
    const declaredActions = ["package.private_tool", "package.private_hook", "package.private_mcp"];
    const originalSkill = sourceState === "builtin_skill" ? Buffer.from(builtinSkillFixture().files[0]!.content_base64, "base64")
      : Buffer.from("\ufeff---\r\nname: delivery-skill\r\ndescription: Follow this original package.\r\nallowed-tools: [package.private_tool]\r\nhooks:\r\n  SessionStart: package.private_hook\r\nmcpServers:\r\n  package-private:\r\n    command: package.private_mcp\r\n---\r\nRead references/note.bin.\r\n");
    if (skillMode) {
      if (sourceState === "skill_project") {
        await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Skill Project','active',now(),now())`, [PROJECT, SPACE, USER]);
        await seedMainlineRoomsForAllProjects(db.pool);
      }
      const preview = previewSkillFiles({ files: [
        { path: "SKILL.md", content_base64: originalSkill.toString("base64") },
        { path: "references/note.bin", content_base64: "AP+A" },
      ] });
      const repo = new PgSkillsRepository(db.pool);
      const identity = { spaceId: SPACE, userId: USER };
      let pkg: ReturnType<typeof SkillPackageSchema.parse>;
      if (sourceState === "builtin_skill") {
        await syncBuiltinSkillPackages(db.pool, [builtinSkillFixture()]);
        const seeded = (await db.pool.query(`SELECT sp.id FROM skill_packages sp JOIN skill_sources ss ON ss.id=sp.source_id
          WHERE sp.space_id=$1 AND ss.source_type='builtin' AND sp.version='1.0.0'`, [SPACE])).rows[0]!;
        pkg = SkillPackageSchema.parse(await repo.getSkillPackage(identity, seeded.id));
        expect(pkg.source?.source_type).toBe("builtin");
        expect(await repo.listAvailableSkills(identity, {})).toEqual([]);
        expect((await db.pool.query("SELECT id FROM skill_bindings")).rows).toEqual([]);
      } else {
        pkg = SkillPackageSchema.parse(await repo.saveImportedSkill(identity, preview));
        await approveSkillImportInTransaction({ db: db.pool, spaceId: SPACE, userId: USER, proposalId: randomUUID(), skillPackageId: pkg.id });
      }
      skillPackageId = pkg.id;
      // Agent-bound selection must work even though a direct session has no agent_id.
      const proposal = await new PgSkillsRepository(db.pool).createSkillBindingProposal({ spaceId: SPACE, userId: USER }, pkg.id, { scope_type: sourceState === "skill_project" ? "project" : "agent", scope_id: sourceState === "skill_project" ? PROJECT : AGENT, enabled: true });
      if (sourceState === "builtin_skill") {
        expect((await db.pool.query("SELECT id FROM skill_bindings")).rows).toEqual([]);
        await new PgProposalApplyService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri })).accept(proposal.id, identity);
        // Upgrading the shipped release must not move the accepted binding.
        await syncBuiltinSkillPackages(db.pool, [builtinSkillFixture("2.0.0")]);
        expect((await repo.listSkillBindings(identity, pkg.id))[0]).toMatchObject({ skill_package_id: pkg.id, enabled: true, proposal_id: proposal.id });
      } else await withTransaction(db.pool, async client => {
        const row = (await client.query<ApplyProposal>("SELECT * FROM proposals WHERE id=$1", [proposal.id])).rows[0]!;
        await applySkillPackageBinding({ db: client, proposal: row, userId: USER, config: loadConfig({ SERVER_DATABASE_URL: db.connectionUri }) });
        await client.query("UPDATE proposals SET status='accepted' WHERE id=$1", [proposal.id]);
      });
      await db.pool.query(`UPDATE messages SET content='' WHERE id=$1`, [MESSAGE]);
      await db.pool.query(`INSERT INTO message_input_parts (id,space_id,session_id,message_id,position,kind,skill_package_id,display_name,media_type,byte_size,sha256) VALUES ($1,$2,$3,$4,0,'skill',$5,'delivery-skill','application/vnd.rainver.skill',0,$6)`, [randomUUID(), SPACE, sessionId, MESSAGE, pkg.id, preview.package_hash]);
      // Even a permissive Agent declaration cannot register package actions.
      // Keep one genuine grant so the check cannot pass on an empty snapshot.
      const requested = ["retrieval.search", ...declaredActions];
      const grants = await buildRunToolGrants(requested, { allowed_tools: requested });
      await db.pool.query(`UPDATE runs SET permission_snapshot_json=$2::jsonb WHERE id=$1`,
        [RUN, JSON.stringify({ tool_grants: grants })]);
    }
    await db.pool.query(
      `INSERT INTO policy_decision_records (
         id,space_id,actor_type,actor_id,action,resource_type,resource_id,
         decision,risk_level,policy_source,metadata_json,created_at
       ) VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,
                 'allow','medium','test','{}',now())`,
      [decisionId, SPACE, USER, SETUP],
    );
    await db.pool.query(
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
    if (sourceState === "skill_project") {
      await db.pool.query("UPDATE work_context_setups SET project_id=$2 WHERE id=$1", [SETUP, PROJECT]);
    }
    if (skillMode) {
      const selections = [{ kind: "skill", skill_package_id: skillPackageId!, package_hash: String((await db.pool.query("SELECT manifest_json->>'package_hash' AS hash FROM skill_packages WHERE id=$1", [skillPackageId])).rows[0]!.hash), display_name: "delivery-skill" }];
      await expect(assertSelectedSkillBindings(db.pool, { space_id: SPACE, user_id: USER, project_id: null, agent_id: AGENT, session_id: sessionId }, selections)).resolves.toBeUndefined();
      expect(await new PgSkillsRepository(db.pool).listAvailableSkills({ spaceId: SPACE, userId: USER }, { session_id: sessionId, agent_id: AGENT })).toEqual(selections);
    }
    await db.pool.query(
      `INSERT INTO model_providers (
         id,space_id,owner_user_id,name,provider_type,base_url,enabled,
         capabilities_json,config_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'Local','ollama','http://localhost:11434',TRUE,'{}','{"deployment":"trusted_local"}',now(),now())`,
      [PROVIDER, SPACE, USER],
    );
    await db.pool.query(
      `INSERT INTO model_provider_space_grants (
         id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$4,TRUE,FALSE,now(),now())`,
      [randomUUID(), PROVIDER, SPACE, USER],
    );
    await db.pool.query(
      `UPDATE agent_runtime_profiles
          SET backend_mode='model_provider', model_provider_id=$2, model_name='gpt-4o'
        WHERE id=$1`,
      [PROFILE, PROVIDER],
    );
    await db.pool.query(
      `UPDATE runs SET session_id=$2,model_provider_id=$3,prompt='What code did I choose?',
         runtime_profile_snapshot_json = runtime_profile_snapshot_json ||
           jsonb_build_object('backend_mode','model_provider','model_provider_id',$3::varchar(36),'model_name','gpt-4o'),
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
    if (sourceState === "skill_project") {
      authoritative.project_id = PROJECT;
    }
    authoritative.work_context_scope_id = sessionId;
    authoritative.work_context_setup_ref = {
      type: "work_context_setup",
      id: SETUP,
      version: "1",
    };
    authoritative.egress.sensitivity_ceiling = "highly_restricted";
    authoritative.readable_scope.sensitivity_ceiling = "highly_restricted";
    await db.pool.query(
      `UPDATE execution_control_snapshots SET snapshot_json=$2::jsonb WHERE id=$1`,
      [CONTROL, JSON.stringify(authoritative)],
    );

    const result = await createProductionRuntimeContextPlanningService(db.pool).planExecution({
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

    expect(result.envelope.window_plan.total_window_tokens).toBe(128_000);
    const messageText = result.envelope.items.find((item) => item.source_ref.id === MESSAGE)?.payload.text;
    if (sourceState === "none") {
      expect(messageText).toBe("What code did I choose?");
    } else if (skillMode) {
      expect(messageText).toContain("[Explicitly selected Skills]");
      expect(messageText).toContain(skillPackageId);
      expect(messageText).not.toContain("Follow this original package");
    } else {
      expect(messageText).toContain("What code did I choose?\n\n[Attached immutable input resources]");
      expect(messageText).toContain(`"source_state":"${sourceState}"`);
      expect(messageText).toContain('"relative_path":"README.md"');
      expect(messageText).not.toContain("Captured file body");
    }
    // A vendor CLI Run's session holds the conversation: the Delivery carries
    // no continuity replay of earlier turns (ADR 0014 §11).
    expect(result.envelope.items.some((item) => item.acquisition === "continuity")).toBe(false);
    const snapshots = new InvocationSnapshotService(
      db.pool,
      undefined,
      new PgInvocationDeliveryAuthorizer(),
    );
    const create = (plannedEnvelope = result.envelope) => snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: plannedEnvelope,
      control: authoritative,
      runtimeKey: "opencode",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:chat`,
      viewerUserId: USER,
      requireLiveAuthorization: true,
    });
    const accepted = await create();
    if (skillMode) {
      // Acquisition, initial Delivery validation and its locked authoritative
      // reload must all resolve the same original package under live scope.
      const resolutions = await Promise.all(candidates!.mock.results.map(result => result.value));
      expect(resolutions).toHaveLength(3);
      for (const resolution of resolutions) {
        expect(resolution).toEqual([expect.objectContaining({
          content: expect.objectContaining({ skill_package_id: skillPackageId }),
        })]);
      }
      expect(candidates!.mock.calls.map(([scope]) => scope)).toEqual([
        expect.objectContaining({ space_id: SPACE, run_id: RUN, agent_id: AGENT,
          project_id: sourceState === "skill_project" ? PROJECT : null, session_id: sessionId, message_id: MESSAGE }),
        expect.objectContaining({ space_id: SPACE, run_id: RUN, session_id: sessionId, message_id: MESSAGE }),
        expect.objectContaining({ space_id: SPACE, run_id: RUN, session_id: sessionId, message_id: MESSAGE, lock: true }),
      ]);
      const plannedSkill = result.envelope.items.find(item => item.source_ref.type === "skill_package_binding")!;
      expect(plannedSkill).toMatchObject({ selection: "required", semantic_role: "delegated_instruction", trust: "system_approved" });
      expect(accepted.delivery.skill_packages?.[0]?.source_item_id).toBe(plannedSkill.id);
      expect(accepted.delivery.planned_items).toContainEqual(expect.objectContaining({
        item_id: plannedSkill.id, required: true, semantic_role: "delegated_instruction",
      }));
      expect(accepted.delivery.skill_packages?.[0]?.content.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "SKILL.md", content_base64: originalSkill.toString("base64") }),
        expect.objectContaining({ path: "references/note.bin", content_base64: "AP+A" }),
      ]));
      const permissions = (await db.pool.query(`SELECT permission_snapshot_json FROM runs WHERE id=$1`, [RUN]))
        .rows[0]!.permission_snapshot_json;
      expect(permissions.tool_grants).toContainEqual(expect.objectContaining({ action_id: "retrieval.search" }));
      for (const name of declaredActions) {
        // Declaration bytes deliberately remain in the delivered package;
        // neither they nor review/binding can add callable authority.
        expect(JSON.stringify(permissions)).not.toContain(name);
        expect(JSON.stringify(accepted.delivery.tool_grant_refs)).not.toContain(name);
      }
      const forged = structuredClone(result.envelope);
      const skillItem = forged.items.find(item => item.source_ref.type === "skill_package_binding")!;
      (skillItem.payload.skill_package as { files: Array<{ content_base64: string }> }).files[0]!.content_base64 = "Zm9yZ2Vk";
      await expect(create(forged)).rejects.toMatchObject({ statusCode: 409 });
    }
    // Neither a forged body nor forged attachment metadata can reach the model.
    for (const replacement of skillMode ? ["Forged selection"] : sourceState === "none" ? ["Forged question"] : ["Forged question", "OTHER.md"]) {
      const tampered = structuredClone(result.envelope);
      const messageItem = tampered.items.find((item) => item.source_ref.id === MESSAGE)!;
      messageItem.payload.text = replacement === "OTHER.md"
        ? String(messageItem.payload.text).replaceAll("README.md", replacement)
        : skillMode ? "Forged selection" : String(messageItem.payload.text).replace("What code did I choose?", replacement);
      await expect(create(tampered)).rejects.toMatchObject({ statusCode: 409 });
    }
    await db.pool.query(
      `UPDATE runs
          SET model_override_json=jsonb_set(model_override_json,'{chat_turn,user_message_id}',$2::jsonb)
        WHERE id=$1`,
      [RUN, JSON.stringify(priorMessageId)],
    );
    await expect(create()).rejects.toMatchObject({ statusCode: 409 });
    await db.pool.query(
      `UPDATE runs
          SET model_override_json=jsonb_set(model_override_json,'{chat_turn,user_message_id}',$2::jsonb)
        WHERE id=$1`,
      [RUN, JSON.stringify(MESSAGE)],
    );
    if (sourceState === "saved" || sourceState === "draft") {
      const missingAttachment = structuredClone(result.envelope);
      missingAttachment.items.find((item) => item.source_ref.id === MESSAGE)!.payload.text = "What code did I choose?";
      await expect(create(missingAttachment)).rejects.toMatchObject({ statusCode: 409 });
      // Revalidation reads live canonical metadata, rather than trusting the plan.
      await db.pool.query(
        `UPDATE conversation_input_resources SET display_name='Changed.md' WHERE message_id=$1`, [MESSAGE],
      );
      await expect(create()).rejects.toMatchObject({ statusCode: 409 });
    }
    if (skillMode) {
      await db.pool.query("UPDATE skill_bindings SET enabled=false WHERE skill_package_id=$1", [skillPackageId]);
      await expect(create()).rejects.toMatchObject({ statusCode: 422 });
      await db.pool.query("UPDATE skill_bindings SET enabled=true WHERE skill_package_id=$1", [skillPackageId]);
      await db.pool.query("UPDATE skill_package_files SET content_base64='YQ==' WHERE skill_package_id=$1 AND path='SKILL.md'", [skillPackageId]);
      await expect(create()).rejects.toMatchObject({ statusCode: 409 });
      await db.pool.query("UPDATE skill_package_files SET content_base64=$2 WHERE skill_package_id=$1 AND path='SKILL.md'", [skillPackageId, originalSkill.toString("base64")]);
    }
    await db.pool.query(`UPDATE sessions SET status='archived',updated_at=now() WHERE id=$1`, [sessionId]);
    await expect(create()).rejects.toMatchObject({ statusCode: 409 });
  });

  it("stores safe attempts separately and audits authorized sealed replay reads", async () => {
    if (!db.available) return;
    const cipher = new SealedPayloadCipher(Buffer.alloc(32, 9));
    const snapshots = new InvocationSnapshotService(db.pool, cipher);
    const first = await snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(),
      runtimeKey: "opencode",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:attempt:1`,
      rawReplayPayload: { rendered_prompt: "never expose this raw replay" },
    });
    expect(first.snapshot.attempt).toBe(1);
    const stored = (await db.pool.query(
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
    expect((await db.pool.query(
      `SELECT delivery_id FROM context_window_reconciliations WHERE delivery_id=$1`,
      [first.delivery.id],
    )).rows).toEqual([{ delivery_id: first.delivery.id }]);

    const second = await snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(),
      runtimeKey: "opencode",
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

    const denied = new SealedPayloadService(db.pool, cipher, { async authorize() { return false; } });
    await expect(denied.read({
      spaceId: SPACE,
      snapshotId: first.snapshot.id,
      viewerUserId: USER,
      reason: "incident review",
    })).rejects.toMatchObject({ statusCode: 403 });
    expect((await db.pool.query("SELECT 1 FROM sealed_invocation_payload_access_audits")).rows).toHaveLength(0);

    let authorizationDb: unknown;
    const sealed = new SealedPayloadService(db.pool, cipher, {
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
    expect(authorizationDb).not.toBe(db.pool);
    expect((await db.pool.query("SELECT reason FROM sealed_invocation_payload_access_audits")).rows)
      .toEqual([{ reason: "incident review" }]);
    await db.pool.query(
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

  it.each([false, true])("sends standing items only when changed across resumed Runs (Room: %s)", async (room) => {
    if (!db.available) return;
    let activeRun = RUN;
    let activeMessage = MESSAGE;
    if (room) {
      const group = randomUUID();
      await db.pool.query(
        `INSERT INTO agent_run_groups (id,space_id,root_run_id,manager_user_id,title,goal,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'Room','Work','active',now(),now())`,
        [group, SPACE, RUN, USER],
      );
      await db.pool.query(`UPDATE runs SET run_group_id=$2 WHERE id=$1`, [RUN, group]);
    }
    const standingTypes = room ? ["agent_version", "message", "run_group_agent_identity"] : ["agent_version", "message"];
    const sessionId = randomUUID();
    const decisionId = randomUUID();
    const vendorSession = "vendor-standing";
    await db.pool.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ($1,$2,$3,'active',now(),now())`,
      [sessionId, SPACE, USER],
    );
    await seedConversationMessages(db.pool, {
      space: SPACE, session: sessionId,
      messages: [{ id: MESSAGE, role: "user", content: "Carry on.", userId: USER, runId: RUN, metadata: {} }],
    });
    await db.pool.query(
      `INSERT INTO policy_decision_records (
         id,space_id,actor_type,actor_id,action,resource_type,resource_id,
         decision,risk_level,policy_source,metadata_json,created_at
       ) VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,
                 'allow','medium','test','{}',now())`,
      [decisionId, SPACE, USER, SETUP],
    );
    await db.pool.query(
      `INSERT INTO work_context_setups (
         id,space_id,work_context_scope_id,scope_kind,version,user_id,
         project_id,project_folder_id,agent_id,runtime_ref_json,pinned_refs_json,
         excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,
         project_brief_version_id,project_instruction_version_id,project_instruction_enabled,
         governing_policy_refs_json,setup_fingerprint,base_version,typed_diff_json,reason,
         policy_decision_record_id,created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'direct_session',1,$4,NULL,NULL,$5,NULL,'[]','[]',
                 '{"enabled":false}','{}',NULL,NULL,TRUE,'[]','standing-setup',NULL,'{}',
                 'test',$6,$4,now())`,
      [SETUP, SPACE, sessionId, USER, AGENT, decisionId],
    );
    await db.pool.query(
      `INSERT INTO host_threads (id, space_id, execution_host_id, workspace_mode, session_id, agent_id,
         container_kind, runtime_key, vendor_session_id, retired_vendor_session_ids, status,
         created_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'managed', $4, $5, 'conversation', 'opencode', $6, '[]', 'active', $7, now(), now())`,
      [THREAD, SPACE, HOST, sessionId, AGENT, vendorSession, USER],
    );
    const hostThread = (runtimeSessionId: string | null) => ({
      chat_turn: { schema_version: "chat_turn.v1", session_id: sessionId, user_id: USER, user_message_id: MESSAGE, agent_id: AGENT, agent_version_id: VERSION, project_id: null },
      host_thread: { schema_version: "host_thread.v1", thread_id: THREAD, runtime_session_id: runtimeSessionId, fresh: runtimeSessionId === null },
    });
    await db.pool.query(
      `INSERT INTO model_providers (
         id,space_id,owner_user_id,name,provider_type,base_url,enabled,
         capabilities_json,config_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'Local','ollama','http://localhost:11434',TRUE,'{}','{"deployment":"trusted_local"}',now(),now())`,
      [PROVIDER, SPACE, USER],
    );
    await db.pool.query(
      `INSERT INTO model_provider_space_grants (
         id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$4,TRUE,FALSE,now(),now())`,
      [randomUUID(), PROVIDER, SPACE, USER],
    );
    await db.pool.query(
      `UPDATE agent_runtime_profiles SET backend_mode='model_provider', model_provider_id=$2, model_name='gpt-4o' WHERE id=$1`,
      [PROFILE, PROVIDER],
    );
    await db.pool.query(
      `UPDATE runs SET session_id=$2, host_task_thread_id=$3, prompt='Carry on.', model_provider_id=$5,
         runtime_profile_snapshot_json = runtime_profile_snapshot_json ||
           jsonb_build_object('backend_mode','model_provider','model_provider_id',$5::varchar(36),'model_name','gpt-4o'),
         model_override_json=$4::jsonb WHERE id=$1`,
      [RUN, sessionId, THREAD, JSON.stringify(hostThread(vendorSession)), PROVIDER],
    );
    const authoritative = control();
    authoritative.work_context_scope_id = sessionId;
    authoritative.work_context_setup_ref = { type: "work_context_setup", id: SETUP, version: "1" };
    authoritative.egress.sensitivity_ceiling = "highly_restricted";
    authoritative.readable_scope.sensitivity_ceiling = "highly_restricted";
    await db.pool.query(`UPDATE execution_control_snapshots SET snapshot_json=$2::jsonb WHERE id=$1`, [CONTROL, JSON.stringify(authoritative)]);
    const plan = async () => (await createProductionRuntimeContextPlanningService(db.pool).planExecution({
      identity: { spaceId: SPACE, userId: USER },
      invocationId: activeRun,
      deliveryId: randomUUID(),
      turn: { work_context_scope_id: sessionId, expected_setup_version: 1, current_message_ref: { type: "message", id: activeMessage }, one_off_refs: [], invocation_purpose: "agent_task" },
    })).envelope.items.map((item) => item.source_ref.type).sort();
    const dispatched = async () => (await db.pool.query<{ standing: { digest: string; sent: boolean } }>(
      `SELECT jsonb_build_object('digest', model_override_json->'host_thread'->>'standing_digest',
                                 'sent', (model_override_json->'host_thread'->>'standing_sent')::boolean) AS standing
         FROM runs WHERE id=$1`, [activeRun],
    )).rows[0]!.standing;

    // The session holds nothing yet: the Agent instruction goes with the message.
    expect(await plan()).toEqual(standingTypes);
    const first = await dispatched();
    expect(first.sent).toBe(true);

    // The Run landed; the thread now records what that session holds.
    await db.pool.query(`UPDATE host_threads SET standing_digest=$2, standing_digest_run_id=$3 WHERE id=$1`, [THREAD, first.digest, RUN]);
    expect(await plan()).toEqual(["message"]);
    expect(await dispatched()).toEqual({ digest: first.digest, sent: false });

    // A new Run resumes the same session: audit refs change, content does not.
    const nextRun = randomUUID();
    const nextControl = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (
         id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
         runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,
         required_sandbox_level,instructed_by_user_id,owner_user_id,created_at,updated_at,execution_kind,
         run_group_id,prompt,session_id,host_task_thread_id,model_override_json,model_provider_id
       ) SELECT $2,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
                runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,
                required_sandbox_level,instructed_by_user_id,owner_user_id,now(),now(),execution_kind,
                run_group_id,prompt,session_id,host_task_thread_id,model_override_json,model_provider_id
           FROM runs WHERE id=$1`,
      [RUN, nextRun],
    );
    await db.pool.query(
      `INSERT INTO execution_control_snapshots (id,space_id,run_id,snapshot_json,created_at)
       VALUES ($1,$2,$3,$4::jsonb,now())`,
      [nextControl, SPACE, nextRun, JSON.stringify({ ...authoritative, id: nextControl })],
    );
    activeRun = nextRun;
    activeMessage = randomUUID();
    await seedConversationMessages(db.pool, {
      space: SPACE, session: sessionId,
      messages: [{ id: activeMessage, role: "user", content: "Next turn.", userId: USER, runId: nextRun, metadata: {} }],
    });
    expect(await plan()).toEqual(["message"]);
    expect(await dispatched()).toEqual({ digest: first.digest, sent: false });
    if (room) {
      await db.pool.query(`UPDATE agents SET name='Renamed' WHERE id=$1`, [AGENT]);
      expect(await plan()).toEqual(standingTypes);
      expect((await dispatched()).digest).not.toBe(first.digest);
      await db.pool.query(`UPDATE agents SET name='Agent' WHERE id=$1`, [AGENT]);
      expect(await plan()).toEqual(["message"]);
    }

    // A revised Agent instruction is a new version, and goes out again.
    const revised = randomUUID();
    await db.pool.query(
      `INSERT INTO agent_versions (id,agent_id,space_id,version_label,system_prompt,context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,created_at)
       VALUES ($1,$2,$3,'v2','revised','{}','{}','[]','{}',now())`,
      [revised, AGENT, SPACE],
    );
    await db.pool.query(`UPDATE runs SET agent_version_id=$2 WHERE id=$1`, [activeRun, revised]);
    expect(await plan()).toEqual(standingTypes);
    expect((await dispatched()).digest).not.toBe(first.digest);

    // A fresh session holds nothing, whatever the thread recorded for the old one.
    await db.pool.query(`UPDATE runs SET agent_version_id=$2, model_override_json=$3::jsonb WHERE id=$1`, [activeRun, VERSION, JSON.stringify(hostThread(null))]);
    expect(await plan()).toEqual(standingTypes);
  });

  it("rejects caller controls that differ from the persisted authority", async () => {
    if (!db.available) return;
    const snapshots = new InvocationSnapshotService(db.pool, new SealedPayloadCipher(Buffer.alloc(32, 11)));
    const forged = control(60);
    forged.egress.allowed_provider_ids = ["30000000-0000-4000-8000-000000000099"];
    await expect(snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: forged,
      runtimeKey: "opencode",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: "usage-forged",
    })).rejects.toMatchObject({ statusCode: 409 });
    expect((await db.pool.query("SELECT 1 FROM invocation_deliveries")).rows).toHaveLength(0);
  });

  it.each([
    { setupProject: PROJECT, setupFolder: FOLDER },
    { setupProject: PROJECT, setupFolder: null },
    { setupProject: null, setupFolder: null },
  ])("reauthorizes Run bindings with Setup project=$setupProject folder=$setupFolder", async ({ setupProject, setupFolder }) => {
    if (!db.available) return;
    const authoritative = control(0);
    authoritative.work_context_setup_ref = { type: "work_context_setup", id: SETUP, version: "1" };
    authoritative.project_id = PROJECT;
    authoritative.project_folder_id = FOLDER;
    authoritative.readable_scope.retrieval_enabled = true;
    authoritative.readable_scope.retrieval_max_candidates = 10;
    await db.pool.query(
      `INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at)
       VALUES ($1,$2,$3,'Delivery Project','active',now(),now())`,
      [PROJECT, SPACE, USER],
    );
    await seedMainlineRoomsForAllProjects(db.pool);
    await db.pool.query(
      `INSERT INTO project_folders (
         id,space_id,project_id,created_by_user_id,name,status,kind,is_primary,
         protected,system_managed,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,'Delivery Folder','active','code',TRUE,FALSE,FALSE,now(),now())`,
      [FOLDER, SPACE, PROJECT, USER],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (
         id,space_id,project_folder_id,execution_host_id,execution_host_kind,
         execution_ready,status,created_at,updated_at
       ) VALUES (gen_random_uuid()::varchar,$1,$2,$3,'server',true,'active',now(),now())`,
      [SPACE, FOLDER, HOST],
    );
    const instructionId = randomUUID();
    await db.pool.query(
      `INSERT INTO project_instruction_versions (
         id,space_id,project_id,version,title,instruction_text,status,
         reviewed_by_user_id,reviewed_at,published_by_user_id,published_at,
         created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'v1','Delivery instruction','Follow delivery rules.','published',
                 $4,now(),$4,now(),$4,now())`,
      [instructionId, SPACE, PROJECT, USER],
    );
    await db.pool.query(
      `UPDATE projects SET active_instruction_version_id=$1 WHERE id=$2 AND space_id=$3`,
      [instructionId, PROJECT, SPACE],
    );
    authoritative.project_instruction_ref = {
      type: "project_instruction_version",
      id: instructionId,
      version: "v1",
    };
    await db.pool.query(
      `INSERT INTO policy_decision_records (
         id,space_id,actor_type,actor_id,action,resource_type,resource_id,
         decision,risk_level,policy_source,metadata_json,created_at
       ) VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,
                 'allow','medium','test','{}',now())`,
      [randomUUID(), SPACE, USER, SETUP],
    );
    const decision = (await db.pool.query<{ id: string }>(
      `SELECT id FROM policy_decision_records WHERE resource_id=$1`, [SETUP],
    )).rows[0]!.id;
    await db.pool.query(
      `INSERT INTO work_context_setups (
         id,space_id,work_context_scope_id,scope_kind,version,user_id,
         project_id,project_folder_id,agent_id,runtime_ref_json,pinned_refs_json,
         excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,
         project_brief_version_id,project_instruction_version_id,project_instruction_enabled,
         governing_policy_refs_json,setup_fingerprint,base_version,typed_diff_json,reason,
         policy_decision_record_id,created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'root_task',1,$4,$7,$8,$5,NULL,'[]','[]','{}','{}',
                 NULL,NULL,TRUE,'[]','delivery-authority',NULL,'{}','test',$6,$4,now())`,
      [SETUP, SPACE, RUN, USER, AGENT, decision, setupProject, setupFolder],
    );
    await db.pool.query(
      `INSERT INTO model_providers (
         id,space_id,owner_user_id,name,provider_type,base_url,enabled,
         capabilities_json,config_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'Local','ollama','http://localhost:11434',TRUE,'{}','{"deployment":"trusted_local"}',now(),now())`,
      [PROVIDER, SPACE, USER],
    );
    await db.pool.query(
      `INSERT INTO model_provider_space_grants (
         id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$4,TRUE,FALSE,now(),now())`,
      [randomUUID(), PROVIDER, SPACE, USER],
    );
    await db.pool.query(
      `UPDATE runs SET model_provider_id=$2,project_id=$3,project_folder_id=$4,prompt='Private question' WHERE id=$1`,
      [RUN, PROVIDER, PROJECT, FOLDER],
    );
    await db.pool.query(
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
      db.pool,
      undefined,
      new PgInvocationDeliveryAuthorizer(),
    );
    const create = (runtimeKey: string) => snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: planned,
      control: authoritative,
      runtimeKey,
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:${runtimeKey}`,
      viewerUserId: USER,
      requireLiveAuthorization: true,
    });
    await expect(create("opencode")).resolves.toBeDefined();
    if (setupFolder === null) {
      await db.pool.query(`UPDATE runs SET project_folder_id=NULL WHERE id=$1`, [RUN]);
      await expect(create("opencode")).rejects.toMatchObject({ statusCode: 409 });
      await db.pool.query(`UPDATE runs SET project_folder_id=$2 WHERE id=$1`, [RUN, FOLDER]);
    }
    if (setupProject === null) {
      await db.pool.query(`UPDATE runs SET project_id=NULL WHERE id=$1`, [RUN]);
      await expect(create("opencode")).rejects.toMatchObject({ statusCode: 409 });
      await db.pool.query(`UPDATE runs SET project_id=$2 WHERE id=$1`, [RUN, PROJECT]);
    }
    await expect(create("claude_code")).rejects.toMatchObject({ statusCode: 409 });
    await db.pool.query(
      `UPDATE model_provider_space_grants SET enabled=FALSE WHERE provider_id=$1 AND space_id=$2`,
      [PROVIDER, SPACE],
    );
    await expect(create("opencode")).rejects.toMatchObject({ statusCode: 409 });
    await db.pool.query(
      `UPDATE model_provider_space_grants SET enabled=TRUE WHERE provider_id=$1 AND space_id=$2`,
      [PROVIDER, SPACE],
    );
    await db.pool.query(`UPDATE project_folders SET status='archived',updated_at=now() WHERE id=$1`, [FOLDER]);
    await expect(create("opencode")).rejects.toMatchObject({ statusCode: 404 });

    await db.pool.query(`UPDATE project_folders SET status='active',updated_at=now() WHERE id=$1`, [FOLDER]);
    const sourceUpdatedAt = "2026-08-09T01:00:00.000Z";
    await db.pool.query(
      `INSERT INTO project_public_summary_publications (
         id,space_id,project_id,summary_text,topics_json,highlights_json,source_refs_json,
         redaction_version,source_draft_version,published_by_user_id,published_at
       ) VALUES ($1,$2,$3,'Current summary','[]','[]','[]','v1',1,$4,$5)`,
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
      runtimeKey: "opencode",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:source`,
      viewerUserId: USER,
      requireLiveAuthorization: true,
    });
    await expect(createWithSource()).resolves.toBeDefined();
    await db.pool.query(
      `DELETE FROM project_public_summary_publications WHERE project_id=$1`,
      [PROJECT],
    );
    await expect(createWithSource()).rejects.toMatchObject({ statusCode: 409 });

    const replacementInstructionId = randomUUID();
    await db.pool.query(
      `UPDATE project_instruction_versions SET status='archived' WHERE id=$1`,
      [instructionId],
    );
    await db.pool.query(
      `INSERT INTO project_instruction_versions (
         id,space_id,project_id,version,title,instruction_text,status,
         reviewed_by_user_id,reviewed_at,published_by_user_id,published_at,
         created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'v2','Replacement instruction','Use the replacement.','published',
                 $4,now(),$4,now(),$4,now())`,
      [replacementInstructionId, SPACE, PROJECT, USER],
    );
    await db.pool.query(
      `UPDATE projects SET active_instruction_version_id=$1 WHERE id=$2 AND space_id=$3`,
      [replacementInstructionId, PROJECT, SPACE],
    );
    await expect(create("opencode")).rejects.toMatchObject({ statusCode: 409 });
  });

  /**
   * Reauthorizing an Inquiry Thread pins the viewer's project membership row
   * for the transaction. Lock that row. Do not lock the nullable side of an
   * outer join: PostgreSQL rejects it, and every Delivery carrying a Thread
   * would fail with a database error rather than a policy decision. A fake
   * `Queryable` accepts that SQL happily; only a real server refuses it.
   */
  it("locks Inquiry Thread membership without tripping PostgreSQL's outer-join lock rule", async () => {
    if (!db.available) return;
    const authoritative = control(0);
    authoritative.project_id = PROJECT;
    authoritative.work_context_setup_ref = { type: "work_context_setup", id: SETUP, version: "1" };
    authoritative.readable_scope.retrieval_enabled = true;
    authoritative.readable_scope.retrieval_max_candidates = 10;
    await db.pool.query(
      `INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at)
       VALUES ($1,$2,$3,'Inquiry Project','active',now(),now())`,
      [PROJECT, SPACE, USER],
    );
    await seedMainlineRoomsForAllProjects(db.pool);
    const threadSessionId = randomUUID();
    await db.pool.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ($1,$2,$3,'active',now(),now())`,
      [threadSessionId, SPACE, USER],
    );
    await seedConversationMessages(db.pool, {
      space: SPACE, session: threadSessionId,
      messages: [{ id: MESSAGE, role: "user", content: "Private question", userId: USER, runId: RUN }],
    });
    const setupDecisionId = randomUUID();
    await db.pool.query(
      `INSERT INTO policy_decision_records (
         id,space_id,actor_type,actor_id,action,resource_type,resource_id,
         decision,risk_level,policy_source,metadata_json,created_at
       ) VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,
                 'allow','medium','test','{}',now())`,
      [setupDecisionId, SPACE, USER, SETUP],
    );
    await db.pool.query(
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
    await db.pool.query(
      `INSERT INTO space_objects (id,space_id,object_type,title,visibility,access_level,owner_user_id,primary_project_id,created_at,updated_at)
       VALUES ($1,$2,'inquiry_thread',$3,'space_shared','full',$4,$5,$6,$6)`,
      [THREAD, SPACE, statement, USER, PROJECT, threadUpdatedAt],
    );
    await db.pool.query(
      `INSERT INTO inquiry_threads (object_id,space_id,project_id,kind,statement,lifecycle_status)
       VALUES ($1,$2,$3,'question',$4,'active')`,
      [THREAD, SPACE, PROJECT, statement],
    );
    await db.pool.query(
      `INSERT INTO model_providers (
         id,space_id,owner_user_id,name,provider_type,base_url,enabled,
         capabilities_json,config_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'Local','ollama','http://localhost:11434',TRUE,'{}','{"deployment":"trusted_local"}',now(),now())`,
      [PROVIDER, SPACE, USER],
    );
    await db.pool.query(
      `INSERT INTO model_provider_space_grants (
         id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$4,TRUE,FALSE,now(),now())`,
      [randomUUID(), PROVIDER, SPACE, USER],
    );
    await db.pool.query(
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
    await db.pool.query(
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
      db.pool,
      new SealedPayloadCipher(Buffer.alloc(32, 13)),
      new PgInvocationDeliveryAuthorizer(),
    );
    const createAttempt = () => snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: plan,
      control: authoritative,
      runtimeKey: "opencode",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:thread`,
      viewerUserId: USER,
      requireLiveAuthorization: true,
    });

    await expect(createAttempt()).resolves.toBeDefined();

    // A non-member has no membership row to pin. That is an ordinary outcome.
    // The join is outer. Do not treat a missing membership as an error.
    // Personal-Space read authority still admits the read.
    await db.pool.query(`DELETE FROM project_members WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT]);
    await expect(createAttempt()).resolves.toBeDefined();
  });

  it("delivers retrieved content readable through its own Project though it is shared to another", async () => {
    if (!db.available) return;
    const OTHER = randomUUID();
    const SHARED_TO = randomUUID();
    const CLAIM = randomUUID();
    const authoritative = control(0);
    authoritative.project_id = PROJECT;
    authoritative.work_context_setup_ref = { type: "work_context_setup", id: SETUP, version: "1" };
    authoritative.readable_scope.retrieval_enabled = true;
    authoritative.readable_scope.retrieval_max_candidates = 10;
    await db.pool.query(`UPDATE spaces SET type='team' WHERE id=$1`, [SPACE]);
    await db.pool.query(
      `INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source)
       VALUES ($1,'Other','active',now(),now(),lower(gen_random_uuid()::text || '@test.invalid'),'system')`,
      [OTHER],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'member','active',now(),now())`,
      [randomUUID(), SPACE, OTHER],
    );
    await db.pool.query(
      `INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at)
       VALUES ($1,$3,$4,'Own Project','active',now(),now()),($2,$3,$4,'Shared-to Project','active',now(),now())`,
      [PROJECT, SHARED_TO, SPACE, OTHER],
    );
    await seedMainlineRoomsForAllProjects(db.pool);
    await db.pool.query(
      `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
      [randomUUID(), SPACE, PROJECT, USER],
    );
    const sessionId = randomUUID();
    await db.pool.query(
      `INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ($1,$2,$3,'active',now(),now())`,
      [sessionId, SPACE, USER],
    );
    await seedConversationMessages(db.pool, {
      space: SPACE, session: sessionId,
      messages: [{ id: MESSAGE, role: "user", content: "Private question", userId: USER, runId: RUN }],
    });
    const setupDecisionId = randomUUID();
    await db.pool.query(
      `INSERT INTO policy_decision_records (
         id,space_id,actor_type,actor_id,action,resource_type,resource_id,
         decision,risk_level,policy_source,metadata_json,created_at
       ) VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,
                 'allow','medium','test','{}',now())`,
      [setupDecisionId, SPACE, USER, SETUP],
    );
    await db.pool.query(
      `INSERT INTO work_context_setups (
         id,space_id,work_context_scope_id,scope_kind,version,user_id,project_id,agent_id,
         runtime_ref_json,pinned_refs_json,excluded_refs_json,retrieval_preferences_json,
         continuity_preferences_json,project_instruction_enabled,governing_policy_refs_json,
         setup_fingerprint,base_version,typed_diff_json,reason,policy_decision_record_id,
         created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'root_task',1,$4,$5,$6,NULL,'[]','[]','{}','{}',FALSE,'[]',
                 'shared-claim-authority',NULL,'{}','test',$7,$4,now())`,
      [SETUP, SPACE, RUN, USER, PROJECT, AGENT, setupDecisionId],
    );
    const claimUpdatedAt = "2026-08-12T02:00:00.000Z";
    await db.pool.query(
      `INSERT INTO space_objects (id,space_id,object_type,title,visibility,access_level,owner_user_id,primary_project_id,created_at,updated_at)
       VALUES ($1,$2,'claim','Retention claim','space_shared','full',$3,$4,$5,$5)`,
      [CLAIM, SPACE, OTHER, PROJECT, claimUpdatedAt],
    );
    await db.pool.query(
      `INSERT INTO claims (object_id,space_id,subject_text,claim_kind,status,claim_text,normalized_claim_hash,confidence_method,resolution_state)
       VALUES ($1,$2,'Retention','fact','active','Retention holds at ninety percent.','retention-hash','human_confirmed','unreviewed')`,
      [CLAIM, SPACE],
    );
    await db.pool.query(
      `INSERT INTO space_object_project_shares (id,space_id,object_id,project_id,shared_by_user_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,now(),now())`,
      [randomUUID(), SPACE, CLAIM, SHARED_TO, OTHER],
    );
    await db.pool.query(
      `INSERT INTO model_providers (
         id,space_id,owner_user_id,name,provider_type,base_url,enabled,
         capabilities_json,config_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'Local','ollama','http://localhost:11434',TRUE,'{}','{"deployment":"trusted_local"}',now(),now())`,
      [PROVIDER, SPACE, USER],
    );
    await db.pool.query(
      `INSERT INTO model_provider_space_grants (
         id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$4,TRUE,FALSE,now(),now())`,
      [randomUUID(), PROVIDER, SPACE, USER],
    );
    await db.pool.query(
      `UPDATE runs SET model_provider_id=$2,project_id=$3,session_id=$4,prompt='Private question',
         model_override_json=$5::jsonb WHERE id=$1`,
      [RUN, PROVIDER, PROJECT, sessionId, JSON.stringify({
        chat_turn: {
          schema_version: "chat_turn.v1",
          session_id: sessionId,
          user_id: USER,
          user_message_id: MESSAGE,
          agent_id: AGENT,
          agent_version_id: VERSION,
          project_id: PROJECT,
        },
      })],
    );
    await db.pool.query(
      `UPDATE execution_control_snapshots SET snapshot_json=$2::jsonb WHERE id=$1`,
      [CONTROL, JSON.stringify(authoritative)],
    );
    const claim = normalizeContextItem({
      sourceRef: { type: "claim", id: CLAIM },
      acquisition: "retrieval",
      selection: "ranked",
      rank: 1,
      semanticRole: "reference_data",
      trust: "derived",
      sensitivity: "normal",
      visibility: "space_shared",
      ownerUserId: OTHER,
      spaceId: SPACE,
      egressEligible: true,
      text: "Retention claim\nRetention holds at ninety percent.",
      revalidation: {
        status: "live",
        checked_at: claimUpdatedAt,
        source_updated_at: claimUpdatedAt,
        source_connection_ids: [],
      },
    });
    const planned = envelope("user_confirmed");
    const plan = new RuntimeContextPlanner().plan({
      executionControlSnapshotId: CONTROL,
      setupRef: authoritative.work_context_setup_ref,
      turn: planned.turn_request,
      model: "gpt-4o",
      directItems: planned.items,
      retrievalItems: [claim],
    });
    const snapshots = new InvocationSnapshotService(
      db.pool,
      new SealedPayloadCipher(Buffer.alloc(32, 13)),
      new PgInvocationDeliveryAuthorizer(),
    );

    await expect(snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: plan,
      control: authoritative,
      runtimeKey: "opencode",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: `run:${RUN}:claim`,
      viewerUserId: USER,
      requireLiveAuthorization: true,
    })).resolves.toBeDefined();
  });

  it("rolls back the window plan when Delivery rendering fails", async () => {
    if (!db.available) return;
    const deliveryId = "30000000-0000-4000-8000-000000000099";
    const snapshots = new InvocationSnapshotService(db.pool);
    await expect(snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(),
      runtimeKey: "opencode",
      providerId: PROVIDER,
      model: "wrong-model",
      usageSourceId: "failed-render",
      deliveryId,
    })).rejects.toThrow("planned model");
    expect((await db.pool.query(
      `SELECT 1 FROM context_window_reconciliations WHERE delivery_id=$1`, [deliveryId],
    )).rows).toHaveLength(0);
  });

  it.each([
    { selectedModel: null },
    { selectedModel: "opencode/big-pickle" },
    { selectedModel: "opencode/mimo-v2.6-flash-free" },
    { selectedModel: "opencode/mimo-v2.5-free" },
    { selectedModel: null, instruction: "Keep this independent requirement." },
  ])("delegates the native ACP model $selectedModel window to its runtime", async ({ selectedModel, instruction }) => {
    if (!db.available) return;
    const decisionId = randomUUID();
    await db.pool.query(
      `INSERT INTO policy_decision_records (
         id,space_id,actor_type,actor_id,action,resource_type,resource_id,
         decision,risk_level,policy_source,metadata_json,created_at
       ) VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,
                 'allow','medium','test','{}',now())`,
      [decisionId, SPACE, USER, SETUP],
    );
    await db.pool.query(
      `INSERT INTO work_context_setups (
         id,space_id,work_context_scope_id,scope_kind,version,user_id,
         project_id,project_folder_id,agent_id,runtime_ref_json,pinned_refs_json,
         excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,
         project_brief_version_id,project_instruction_version_id,project_instruction_enabled,
         governing_policy_refs_json,setup_fingerprint,base_version,typed_diff_json,reason,
         policy_decision_record_id,created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'root_task',1,$4,NULL,NULL,$5,NULL,'[]','[]',
                 '{"enabled":false}','{}',NULL,NULL,TRUE,'[]','native-setup',NULL,'{}',
                 'test',$6,$4,now())`,
      [SETUP, SPACE, RUN, USER, AGENT, decisionId],
    );
    const prompt = "x".repeat(80_000);
    await db.pool.query(`UPDATE runs SET prompt=$2,instruction=$3 WHERE id=$1`, [RUN, prompt, instruction ?? prompt]);
    if (selectedModel) {
      await db.pool.query(
        `UPDATE runs SET model_override_json=$2::jsonb WHERE id=$1`,
        [RUN, JSON.stringify({ acp_session_config: [
          { id: "model", type: "select", category: "model", value: selectedModel },
        ] })],
      );
    }
    const authoritative = control();
    authoritative.work_context_setup_ref = { type: "work_context_setup", id: SETUP, version: "1" };
    authoritative.egress = {
      destination_type: "local_cli",
      destination_id: "opencode",
      sensitivity_ceiling: "highly_restricted",
      external_egress_allowed: true,
      allowed_provider_ids: [],
    };
    authoritative.readable_scope.sensitivity_ceiling = "highly_restricted";
    await db.pool.query(
      `UPDATE execution_control_snapshots SET snapshot_json=$2::jsonb WHERE id=$1`,
      [CONTROL, JSON.stringify(authoritative)],
    );

    const delivery = await createProductionRuntimeContextInvocationGateway(db.pool).prepareInvocation({
      identity: { spaceId: SPACE, userId: USER },
      invocationId: RUN,
      executionControlSnapshotId: CONTROL,
      runtimeKey: "opencode",
      usageSourceId: `run:${RUN}:native`,
      turn: {
        work_context_scope_id: RUN,
        expected_setup_version: 1,
        current_message_ref: { type: "run_request", id: RUN },
        one_off_refs: [],
        invocation_purpose: "agent_task",
      },
    });

    expect(delivery.model).toBe(selectedModel);
    const deliveredText = delivery.message_blocks.map((block) => block.content).join("\n");
    expect(deliveredText.split(prompt)).toHaveLength(2);
    if (instruction) expect(deliveredText).toContain(instruction);
    expect((await db.pool.query<{ model: string | null }>(
      `SELECT model FROM context_window_reconciliations WHERE delivery_id=$1`,
      [delivery.id],
    )).rows).toEqual([{ model: selectedModel }]);
    const window = await db.pool.query<{
      total_window_tokens: number | null;
      model_catalog_version: string;
      planned_prompt_tokens: number;
    }>(
      `SELECT (plan_json->>'total_window_tokens')::integer AS total_window_tokens,
              model_catalog_version, planned_prompt_tokens
         FROM context_window_reconciliations WHERE delivery_id=$1`,
      [delivery.id],
    );
    expect(window.rows[0]).toMatchObject({ total_window_tokens: null, model_catalog_version: "acp-runtime-managed.v1" });
    expect(window.rows[0]?.planned_prompt_tokens).toBeGreaterThanOrEqual(20_000);
    if (selectedModel === null && !instruction) {
      const plan = await createProductionRuntimeContextPlanningService(db.pool).planExecution({
        identity: { spaceId: SPACE, userId: USER }, invocationId: RUN, deliveryId: randomUUID(),
        turn: {
          work_context_scope_id: RUN, expected_setup_version: 1,
          current_message_ref: { type: "run_request", id: RUN }, one_off_refs: [], invocation_purpose: "agent_task",
        },
      });
      await db.pool.query(`UPDATE runs SET instruction='A new independent constraint' WHERE id=$1`, [RUN]);
      const snapshots = new InvocationSnapshotService(db.pool, undefined, new PgInvocationDeliveryAuthorizer());
      await expect(snapshots.createAttempt({
        spaceId: SPACE, invocationId: RUN, envelope: plan.envelope, control: authoritative,
        runtimeKey: "opencode", providerId: null, model: null, usageSourceId: "deduplicated-race",
        viewerUserId: USER, requireLiveAuthorization: true,
      })).rejects.toMatchObject({ statusCode: 409 });
    }
  });

  it("keeps a Room's standing goal and identity one item across Runs while each names its own Run", async () => {
    if (!db.available) return;
    const groupId = randomUUID();
    const decisionId = randomUUID();
    await db.pool.query(
      `INSERT INTO agent_run_groups (id,space_id,root_run_id,manager_user_id,title,goal,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'Room','Ship the release','active',now(),now())`,
      [groupId, SPACE, RUN, USER],
    );
    await db.pool.query(
      `UPDATE runs SET run_group_id=$2,prompt='Review the plan.',instruction='Ship the release' WHERE id=$1`,
      [RUN, groupId],
    );
    await db.pool.query(
      `INSERT INTO policy_decision_records (
         id,space_id,actor_type,actor_id,action,resource_type,resource_id,
         decision,risk_level,policy_source,metadata_json,created_at
       ) VALUES ($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,
                 'allow','medium','test','{}',now())`,
      [decisionId, SPACE, USER, SETUP],
    );
    await db.pool.query(
      `INSERT INTO work_context_setups (
         id,space_id,work_context_scope_id,scope_kind,version,user_id,
         project_id,project_folder_id,agent_id,runtime_ref_json,pinned_refs_json,
         excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,
         project_brief_version_id,project_instruction_version_id,project_instruction_enabled,
         governing_policy_refs_json,setup_fingerprint,base_version,typed_diff_json,reason,
         policy_decision_record_id,created_by_user_id,created_at
       ) VALUES ($1,$2,$3,'root_task',1,$4,NULL,NULL,$5,NULL,'[]','[]',
                 '{"enabled":false}','{}',NULL,NULL,TRUE,'[]','room-setup',NULL,'{}',
                 'test',$6,$4,now())`,
      [SETUP, SPACE, RUN, USER, AGENT, decisionId],
    );
    const authoritative = control();
    authoritative.work_context_setup_ref = { type: "work_context_setup", id: SETUP, version: "1" };
    authoritative.egress = {
      destination_type: "local_cli",
      destination_id: "opencode",
      sensitivity_ceiling: "highly_restricted",
      external_egress_allowed: true,
      allowed_provider_ids: [],
    };
    authoritative.readable_scope.sensitivity_ceiling = "highly_restricted";
    await db.pool.query(
      `UPDATE execution_control_snapshots SET snapshot_json=$2::jsonb WHERE id=$1`,
      [CONTROL, JSON.stringify(authoritative)],
    );
    const turn = {
      work_context_scope_id: RUN,
      expected_setup_version: 1,
      current_message_ref: { type: "run_request" as const, id: RUN },
      one_off_refs: [],
      invocation_purpose: "agent_task" as const,
    };

    // A second Run of the same Agent in the same Room group.
    const nextRun = randomUUID();
    const nextControl = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (
         id,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
         runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,
         required_sandbox_level,instructed_by_user_id,owner_user_id,created_at,updated_at,execution_kind,
         run_group_id,prompt,instruction
       ) SELECT $2,space_id,agent_id,agent_version_id,run_type,trigger_origin,status,mode,
                runtime_profile_id,runtime_profile_selection_source,runtime_key,runtime_profile_snapshot_json,
                required_sandbox_level,instructed_by_user_id,owner_user_id,now(),now(),execution_kind,
                run_group_id,'Build it.',instruction
           FROM runs WHERE id=$1`,
      [RUN, nextRun],
    );
    await db.pool.query(
      `INSERT INTO execution_control_snapshots (id,space_id,run_id,snapshot_json,created_at)
       VALUES ($1,$2,$3,$4::jsonb,now())`,
      [nextControl, SPACE, nextRun, JSON.stringify({ ...authoritative, id: nextControl })],
    );
    const planFor = async (invocationId: string) => (await createProductionRuntimeContextPlanningService(db.pool).planExecution({
      identity: { spaceId: SPACE, userId: USER }, invocationId, deliveryId: randomUUID(),
      turn: { ...turn, current_message_ref: { type: "run_request", id: invocationId } },
    })).envelope;
    const plan = { envelope: await planFor(RUN) };
    const next = await planFor(nextRun);
    for (const type of ["run_instruction", "run_group_agent_identity"]) {
      const first = plan.envelope.items.find((item) => item.source_ref.type === type)!;
      const second = next.items.find((item) => item.source_ref.type === type)!;
      expect(first.source_ref.id).toBe(RUN);
      expect(second.source_ref.id).toBe(nextRun);
      expect(second.id).toBe(first.id);
    }

    const delivery = await createProductionRuntimeContextInvocationGateway(db.pool).prepareInvocation({
      identity: { spaceId: SPACE, userId: USER },
      invocationId: RUN,
      executionControlSnapshotId: CONTROL,
      runtimeKey: "opencode",
      usageSourceId: `run:${RUN}:room`,
      turn,
    });
    const deliveredText = delivery.message_blocks.map((block) => block.content).join("\n");
    expect(deliveredText).toContain("Ship the release");
    expect(deliveredText).toContain("- You are Agent for this run.");

    // The identity is still revalidated against the live Agent.
    await db.pool.query(`UPDATE agents SET name='Renamed' WHERE id=$1`, [AGENT]);
    const snapshots = new InvocationSnapshotService(db.pool, undefined, new PgInvocationDeliveryAuthorizer());
    await expect(snapshots.createAttempt({
      spaceId: SPACE, invocationId: RUN, envelope: plan.envelope, control: authoritative,
      runtimeKey: "opencode", providerId: null, model: null, usageSourceId: "renamed-agent",
      viewerUserId: USER, requireLiveAuthorization: true,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("fails closed when retention disables raw persistence and deletes expired ciphertext", async () => {
    if (!db.available) return;
    const cipher = new SealedPayloadCipher(Buffer.alloc(32, 10));
    const snapshots = new InvocationSnapshotService(db.pool, cipher);
    await db.pool.query(
      `UPDATE execution_control_snapshots SET snapshot_json=$2::jsonb WHERE id=$1`,
      [CONTROL, JSON.stringify(control(0))],
    );
    await expect(snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(0),
      runtimeKey: "opencode",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: "usage-disabled",
      rawReplayPayload: { raw: true },
    })).rejects.toThrow("prohibit");
    expect((await db.pool.query("SELECT 1 FROM invocation_snapshots")).rows).toHaveLength(0);

    await db.pool.query(
      `UPDATE execution_control_snapshots SET snapshot_json=$2::jsonb WHERE id=$1`,
      [CONTROL, JSON.stringify(control(60))],
    );
    const created = await snapshots.createAttempt({
      spaceId: SPACE,
      invocationId: RUN,
      envelope: envelope(),
      control: control(60),
      runtimeKey: "opencode",
      providerId: PROVIDER,
      model: "gpt-4o",
      usageSourceId: "usage-expiring",
      rawReplayPayload: { raw: true },
    });
    await db.pool.query(
      `UPDATE sealed_invocation_payloads SET retention_deadline=now()-interval '1 second'
        WHERE invocation_snapshot_id=$1`,
      [created.snapshot.id],
    );
    const sealed = new SealedPayloadService(db.pool, cipher, { async authorize() { return true; } });
    await expect(sealed.read({
      spaceId: SPACE,
      snapshotId: created.snapshot.id,
      viewerUserId: USER,
      reason: "expired check",
    })).rejects.toMatchObject({ statusCode: 410 });
    expect((await db.pool.query(
      `SELECT encrypted_payload,deleted_at FROM sealed_invocation_payloads WHERE invocation_snapshot_id=$1`,
      [created.snapshot.id],
    )).rows[0]).toMatchObject({ encrypted_payload: null });
  });
});
