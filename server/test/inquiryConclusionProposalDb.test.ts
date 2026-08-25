import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import { PgProjectRepository } from "../src/modules/projects/repository";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import { InquiryConclusionProposalService } from "../src/modules/inquiry/inquiryConclusionProposalService";
import { registerInquiryConclusionProposalAppliers } from "../src/modules/inquiry/inquiryConclusionProposalApplier";
import { InquiryThreadProposalService } from "../src/modules/inquiry/inquiryThreadProposalService";
import { registerInquiryThreadProposalAppliers } from "../src/modules/inquiry/inquiryThreadProposalApplier";
import { ProjectDefinitionProposalService } from "../src/modules/projects/projectDefinitionProposalService";
import { registerProjectDefinitionProposalAppliers } from "../src/modules/projects/projectDefinitionProposalApplier";
import { ProjectOverviewService } from "../src/modules/projects/overviewService";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository";
import type { ServerConfig } from "../src/config";
import { HttpError } from "../src/modules/routeUtils/common";
import { loadConfig } from "../src/config";
import { PgRunRepository } from "../src/modules/runs/repository";
import { SystemActionDispatcher } from "../src/modules/systemActions/systemActionDispatcher";
import type { CanonicalToolCall, RuntimeHostExecuteRequest } from "@agent-space/protocol" with { "resolution-mode": "import" };

// Real-Postgres coverage for `inquiry.record_conclusion` (plan:
// `.agent/plans/project-conversational-advancement-plan.md`, Phase A): an
// agent-drafted conclusion becomes a reviewable `inquiry_conclusion`
// Proposal, and accepting it materializes an Iteration through the same
// write authority a direct user edit uses.

const SPACE = "21111111-1111-4111-8111-111111111111";
const OWNER = "2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "2bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_VERSION_ID = "2ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN_ID = "2ccccccc-cccc-4ccc-8ccc-cccccccccccc";


const db = useTestDatabase(__filename);

let PROJECT: string;

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["inquiry_thread_work_events", "inquiry_iterations", "inquiry_thread_statement_revisions", "inquiry_thread_personal_focus", "inquiry_question_states", "inquiry_hypothesis_states", "inquiry_threads", "inquiry_project_settings", "proposals", "runs", "agent_versions", "agents", "notes", "space_objects", "projects", "project_members", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'active', $2, $2)`, [OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
     VALUES ($1, $2, $3, 'Room Agent', 'active', NULL, $4, $4, 'space_shared')`,
    [AGENT_ID, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions
       (id, agent_id, space_id, version_label, system_prompt, model_config_json, runtime_config_json,
        context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json, runtime_policy_json, created_at)
     VALUES ($1, $2, $3, 'v1', 'Test', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
    [AGENT_VERSION_ID, AGENT_ID, SPACE, now],
  );
  await db.pool.query("UPDATE agents SET current_version_id = $2 WHERE id = $1", [AGENT_ID, AGENT_VERSION_ID]);
  const project = await new PgProjectRepository(db.pool).create({ spaceId: SPACE, userId: OWNER }, { name: "Inquiry Conclusion Project" });
  PROJECT = project.id as string;
  await db.pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, created_at, updated_at, owner_user_id, visibility, access_level, project_id, instructed_by_user_id)
     VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',$5,$5,$6,'private','full',$7,$6)`,
    [RUN_ID, SPACE, AGENT_ID, AGENT_VERSION_ID, now, OWNER, PROJECT],
  );
  await db.pool.query(
    `UPDATE runs
        SET permission_snapshot_json = $2::jsonb
      WHERE id = $1 AND space_id = $3`,
    [RUN_ID, JSON.stringify({ tool_grants: [{ action_id: "project.propose_definition" }] }), SPACE],
  );
});

const ownerIdentity = () => ({ spaceId: SPACE, userId: OWNER });

async function proposalRowToApplyProposal(proposalId: string): Promise<ApplyProposal> {
  const row = await db.pool.query(
    `SELECT id, space_id, proposal_type, status, risk_level, title, payload_json, project_folder_id,
            created_by_user_id, created_by_agent_id, created_by_run_id, project_id, required_approver_role
       FROM proposals WHERE id=$1`,
    [proposalId],
  );
  return row.rows[0] as ApplyProposal;
}

describe("inquiry.propose_thread Proposal (real Postgres)", () => {
  it("dispatches a declarative system action through the gateway and creates only a Proposal", async () => {
    if (!db.available) return;
    const run = await new PgRunRepository(db.pool).getRun(SPACE, RUN_ID);
    if (!run) throw new Error("Test Run was not created");
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    const dispatcher = await SystemActionDispatcher.create(
      config,
      run,
      {} as RuntimeHostExecuteRequest,
    );

    // Project creation seeds one initial Brief version; the dispatch must not
    // add another — accepting the Proposal is what publishes a new version.
    const briefsBefore = await db.pool.query<{ id: string }>(
      "SELECT id FROM project_brief_versions WHERE project_id = $1 ORDER BY id",
      [PROJECT],
    );

    const call: CanonicalToolCall = {
      id: "project-definition-call-1",
      name: "project.propose_definition",
      arguments_json: JSON.stringify({ goal: "Make the Project goal reviewable." }),
    };
    const result = await dispatcher.dispatch(call);

    expect(result.modelResult).toMatchObject({ ok: true });
    expect(result.summary).toMatchObject({
      tool_name: "project.propose_definition",
      ok: true,
    });
    const proposals = await db.pool.query<{ status: string; action_id: string; created_by_run_id: string }>(
      `SELECT status, payload_json->>'action_id' AS action_id, created_by_run_id
         FROM proposals
        WHERE space_id = $1 AND project_id = $2 AND proposal_type = 'project_brief_publish'`,
      [SPACE, PROJECT],
    );
    expect(proposals.rows).toEqual([{
      status: "pending",
      action_id: "project.propose_definition",
      created_by_run_id: RUN_ID,
    }]);
    const briefsAfter = await db.pool.query<{ id: string }>(
      "SELECT id FROM project_brief_versions WHERE project_id = $1 ORDER BY id",
      [PROJECT],
    );
    expect(briefsAfter.rows).toEqual(briefsBefore.rows);
  });

  it("keeps the draft reviewable, then creates the canonical Thread on acceptance", async () => {
    if (!db.available) return;
    const identity = ownerIdentity();
    const service = new InquiryThreadProposalService(db.pool);
    const { proposal } = await service.proposeThread(identity, PROJECT, {
      kind: "question",
      statement: "How should personal agent memory be evaluated?",
      answerability: "Answerable with an MVP benchmark suite.",
      resolution_criteria: "Compare layered memory with the vector-only baseline.",
    }, {
      agentId: AGENT_ID,
      runId: RUN_ID,
      idempotencyKey: "thread-1",
    });

    expect(proposal).toMatchObject({
      proposal_type: "inquiry_thread_create",
      status: "pending",
    });
    const beforeAccept = await db.pool.query(
      "SELECT 1 FROM inquiry_threads WHERE project_id=$1",
      [PROJECT],
    );
    expect(beforeAccept.rowCount).toBe(0);

    const registry = new ProposalApplierRegistry();
    registerInquiryThreadProposalAppliers(registry);
    const result = await registry.apply({
      config: {} as ServerConfig,
      db: db.pool,
      proposal: await proposalRowToApplyProposal(proposal.id as string),
      userId: OWNER,
    });

    expect(result.result_type).toBe("inquiry_thread");
    const detail = await new InquiryThreadService(db.pool).getThread(
      identity,
      PROJECT,
      (result.result as { thread_id: string }).thread_id,
    );
    expect(detail).toMatchObject({
      kind: "question",
      statement: "How should personal agent memory be evaluated?",
      question_state: {
        answerability: "Answerable with an MVP benchmark suite.",
        resolution_criteria: "Compare layered memory with the vector-only baseline.",
      },
    });
  });

  it("returns the same proposal when a tool call is retried", async () => {
    if (!db.available) return;
    const service = new InquiryThreadProposalService(db.pool);
    const actor = { agentId: AGENT_ID, runId: RUN_ID, idempotencyKey: "thread-retry" };
    const first = await service.proposeThread(ownerIdentity(), PROJECT, {
      statement: "Can the memory MVP recall updated preferences?",
    }, actor);
    const second = await service.proposeThread(ownerIdentity(), PROJECT, {
      statement: "This retry must not create a second proposal.",
    }, actor);

    expect(second.proposal.id).toBe(first.proposal.id);
    const count = await db.pool.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM proposals WHERE proposal_type='inquiry_thread_create'",
    );
    expect(count.rows[0]?.total).toBe("1");
  });

  it("coalesces a same-statement retry that does not reuse an idempotency key (room-advancement-reliability-plan Phase 1)", async () => {
    if (!db.available) return;
    const service = new InquiryThreadProposalService(db.pool);
    const first = await service.proposeThread(ownerIdentity(), PROJECT, {
      statement: "How should layered memory be evaluated?",
    }, { agentId: AGENT_ID, runId: RUN_ID, idempotencyKey: "decompose-call-1" });
    const second = await service.proposeThread(ownerIdentity(), PROJECT, {
      // Different casing/whitespace, no reused idempotency key — the case a
      // re-planned decomposition run actually produces.
      statement: "  How should layered memory be evaluated?  ",
    }, { agentId: AGENT_ID, runId: RUN_ID, idempotencyKey: "decompose-call-2" });

    expect(second.proposal.id).toBe(first.proposal.id);
    const count = await db.pool.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM proposals WHERE proposal_type='inquiry_thread_create'",
    );
    expect(count.rows[0]?.total).toBe("1");
  });

  it("serializes two truly concurrent same-statement calls to one proposal (advisory lock, not just sequential coalesce)", async () => {
    if (!db.available) return;
    const service = new InquiryThreadProposalService(db.pool);
    const [first, second] = await Promise.all([
      service.proposeThread(ownerIdentity(), PROJECT, {
        statement: "Does the memory MVP generalize across sessions?",
      }, { agentId: AGENT_ID, runId: RUN_ID, idempotencyKey: "race-call-1" }),
      service.proposeThread(ownerIdentity(), PROJECT, {
        statement: "Does the memory MVP generalize across sessions?",
      }, { agentId: AGENT_ID, runId: RUN_ID, idempotencyKey: "race-call-2" }),
    ]);

    expect(second.proposal.id).toBe(first.proposal.id);
    const count = await db.pool.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM proposals WHERE proposal_type='inquiry_thread_create'",
    );
    expect(count.rows[0]?.total).toBe("1");
  });

  it("does not coalesce two distinct statements from the same run", async () => {
    if (!db.available) return;
    const service = new InquiryThreadProposalService(db.pool);
    await service.proposeThread(ownerIdentity(), PROJECT, {
      statement: "How should layered memory be evaluated?",
    }, { agentId: AGENT_ID, runId: RUN_ID, idempotencyKey: "distinct-1" });
    await service.proposeThread(ownerIdentity(), PROJECT, {
      statement: "How should retrieval latency be measured?",
    }, { agentId: AGENT_ID, runId: RUN_ID, idempotencyKey: "distinct-2" });

    const count = await db.pool.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM proposals WHERE proposal_type='inquiry_thread_create'",
    );
    expect(count.rows[0]?.total).toBe("2");
  });
});

describe("project.propose_definition Proposal (real Postgres)", () => {
  it("publishes the formal goal on acceptance and completes initialization", async () => {
    if (!db.available) return;
    const service = new ProjectDefinitionProposalService(db.pool);
    const { proposal } = await service.proposeDefinition(ownerIdentity(), PROJECT, {
      goal: "Build a reliable personal agent memory MVP",
      success_definition: "Beat the vector-only baseline on memory accuracy.",
    }, {
      agentId: AGENT_ID,
      runId: RUN_ID,
      idempotencyKey: "definition-1",
    });
    expect(proposal).toMatchObject({ proposal_type: "project_brief_publish", status: "pending" });
    await expect(new ProjectOverviewService(db.pool).getOverview(ownerIdentity(), PROJECT))
      .resolves.toMatchObject({ definition_status: { status: "needs_definition" } });

    const registry = new ProposalApplierRegistry();
    registerProjectDefinitionProposalAppliers(registry);
    const result = await registry.apply({
      config: {} as ServerConfig,
      db: db.pool,
      proposal: await proposalRowToApplyProposal(proposal.id as string),
      userId: OWNER,
    });

    expect(result.result_type).toBe("project_brief_version");
    await expect(new ProjectOverviewService(db.pool).getOverview(ownerIdentity(), PROJECT))
      .resolves.toMatchObject({
        definition_status: {
          status: "initialized",
          goal_or_problem: "Build a reliable personal agent memory MVP",
        },
        brief: {
          success_definition: "Beat the vector-only baseline on memory accuracy.",
          status: "published",
        },
      });
  });

  it("coalesces a retry that does not reuse an idempotency key (room-advancement-reliability-plan Phase 1)", async () => {
    if (!db.available) return;
    const service = new ProjectDefinitionProposalService(db.pool);
    const first = await service.proposeDefinition(ownerIdentity(), PROJECT, {
      goal: "Build a reliable personal agent memory MVP",
    }, { agentId: AGENT_ID, runId: RUN_ID, idempotencyKey: "define-call-1" });
    const second = await service.proposeDefinition(ownerIdentity(), PROJECT, {
      goal: "Build a reliable personal agent memory MVP, revised wording",
    }, { agentId: AGENT_ID, runId: RUN_ID, idempotencyKey: "define-call-2" });

    expect(second.proposal.id).toBe(first.proposal.id);
    const count = await db.pool.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM proposals WHERE proposal_type='project_brief_publish'",
    );
    expect(count.rows[0]?.total).toBe("1");
  });
});

describe("inquiry.record_conclusion Proposal (real Postgres)", () => {
  it("drafts a conclusion as a pending Proposal, then accept materializes an Iteration", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const identity = ownerIdentity();
    const hypothesis = await threadSvc.createThread(identity, PROJECT, {
      kind: "hypothesis",
      statement: "A warm cache halves p95 latency",
      proposed_claim: "Cache hit rate above 80% halves p95 latency",
    });

    const service = new InquiryConclusionProposalService(db.pool);
    await db.pool.query("UPDATE runs SET visibility='selected_users' WHERE id=$1", [RUN_ID]);
    await db.pool.query(
      `INSERT INTO content_access_grants (
         id, space_id, resource_type, resource_id, grantee_user_id,
         granted_by_user_id, access_level, created_at, updated_at
       ) VALUES ($1,$2,'run',$3,$4,$4,'full',now(),now())`,
      [randomUUID(), SPACE, RUN_ID, OWNER],
    );
    const { proposal } = await service.proposeConclusion(identity, PROJECT, {
      thread_id: hypothesis.id,
      change_summary: "Benchmark run confirms the hypothesis",
      evaluation_state: "supported",
      confidence: 72,
      confidence_method: "human_confirmed",
    }, {
      agentId: AGENT_ID,
      runId: RUN_ID,
      idempotencyKey: "conclusion-1",
      visibility: "selected_users",
    });

    expect(proposal.status).toBe("pending");
    expect((proposal as { proposal_type: string }).proposal_type).toBe("inquiry_conclusion");
    expect((proposal.payload_json as Record<string, unknown>).thread_id).toBe(hypothesis.id);
    expect((proposal as { visibility: string }).visibility).toBe("selected_users");
    const proposalOwner = await db.pool.query<{ owner_user_id: string | null }>(
      "SELECT owner_user_id FROM proposals WHERE id=$1",
      [proposal.id],
    );
    expect(proposalOwner.rows[0]?.owner_user_id).toBe(OWNER);
    const inheritedGrant = await db.pool.query(
      `SELECT 1 FROM content_access_grants
        WHERE space_id=$1 AND resource_type='proposal' AND resource_id=$2
          AND grantee_user_id=$3 AND revoked_at IS NULL`,
      [SPACE, proposal.id, OWNER],
    );
    expect(inheritedGrant.rowCount).toBe(1);

    const registry = new ProposalApplierRegistry();
    registerInquiryConclusionProposalAppliers(registry);
    const applyProposal = await proposalRowToApplyProposal(proposal.id as string);
    const result = await registry.apply({
      config: {} as ServerConfig,
      db: db.pool,
      proposal: applyProposal,
      userId: OWNER,
    });
    expect(result.result_type).toBe("inquiry_iteration");

    const detail = await threadSvc.getThread(identity, PROJECT, hypothesis.id as string);
    expect(detail.hypothesis_state).toMatchObject({ evaluation_state: "supported", confidence: 72 });

    const iterationRow = await db.pool.query<{ trigger_kind: string; trigger_ref: string }>(
      `SELECT trigger_kind, trigger_ref FROM inquiry_iterations WHERE thread_id=$1`,
      [hypothesis.id],
    );
    expect(iterationRow.rows[0]?.trigger_kind).toBe("agent_conclusion");
    expect(iterationRow.rows[0]?.trigger_ref).toBe(proposal.id);
  });

  it("is idempotent on (run_id, action_idempotency_key): a retry returns the same proposal", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Does caching help?" });

    const service = new InquiryConclusionProposalService(db.pool);
    const actor = { agentId: AGENT_ID, runId: RUN_ID, idempotencyKey: "conclusion-retry" };
    const first = await service.proposeConclusion(identity, PROJECT, {
      thread_id: question.id,
      change_summary: "First attempt",
      answer_state: "partial",
    }, actor);
    const second = await service.proposeConclusion(identity, PROJECT, {
      thread_id: question.id,
      change_summary: "Retry with identical idempotency key",
      answer_state: "answered",
    }, actor);

    expect(second.proposal.id).toBe(first.proposal.id);
    const count = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM proposals WHERE proposal_type='inquiry_conclusion'`,
    );
    expect(count.rows[0]?.total).toBe("1");
  });

  it("coalesces a same-thread retry that does not reuse an idempotency key (room-advancement-reliability-plan Phase 1)", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Does caching help?" });

    const service = new InquiryConclusionProposalService(db.pool);
    const first = await service.proposeConclusion(identity, PROJECT, {
      thread_id: question.id,
      change_summary: "First draft",
      answer_state: "partial",
    }, { agentId: AGENT_ID, runId: RUN_ID, idempotencyKey: "conclusion-call-1" });
    const second = await service.proposeConclusion(identity, PROJECT, {
      thread_id: question.id,
      change_summary: "Re-planned draft for the same Thread",
      answer_state: "answered",
    }, { agentId: AGENT_ID, runId: RUN_ID, idempotencyKey: "conclusion-call-2" });

    expect(second.proposal.id).toBe(first.proposal.id);
    const count = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM proposals WHERE proposal_type='inquiry_conclusion'`,
    );
    expect(count.rows[0]?.total).toBe("1");
  });

  it("rejects a conclusion draft for a Thread that does not exist", async () => {
    if (!db.available) return;
    const service = new InquiryConclusionProposalService(db.pool);
    await expect(
      service.proposeConclusion(ownerIdentity(), PROJECT, {
        thread_id: randomUUID(),
        change_summary: "No such thread",
      }),
    ).rejects.toThrow(HttpError);
  });
});
