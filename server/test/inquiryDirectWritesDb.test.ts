import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService.js";
import { ProjectDefinitionProposalService } from "../src/modules/projects/projectDefinitionProposalService.js";
import { registerProjectDefinitionProposalAppliers } from "../src/modules/projects/projectDefinitionProposalApplier.js";
import { ProjectOverviewService } from "../src/modules/projects/overviewService.js";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository.js";
import type { ServerConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { getProjectUpdates } from "../src/modules/projectWork/updatesReadModel.js";
import { THREAD_FAN_OUT_PER_TURN } from "../src/modules/inquiry/threadFanOut.js";
import { SystemActionDispatcher } from "../src/modules/systemActions/systemActionDispatcher.js";
import type { RuntimeHostExecuteRequest } from "@rainver/protocol";

// Real-Postgres coverage for the two Inquiry writes that stopped being
// proposals (ADR 0017 §2), and the one that did not. A person asking in the
// turn is the authorization: opening a question and recording a conclusion
// happen immediately, bounded per turn, deduped, and undoable from the
// Project's updates. `project.propose_definition` is still a proposal — the
// Project's direction is a decision, not an advancement — so its cases stay
// here as the contrast.

const SPACE = "21111111-1111-4111-8111-111111111111";
const OWNER = "2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "2bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_VERSION_ID = "2ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN_ID = "2ccccccc-cccc-4ccc-8ccc-cccccccccccc";
// A second turn: the bound is per Run, so this one starts with a fresh budget.
const SECOND_RUN_ID = "2eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";


const db = useTestDatabase(import.meta.filename);

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
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, created_at, updated_at, owner_user_id, visibility, access_level, project_id, instructed_by_user_id)
     VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',$5,$5,$6,'private','full',$7,$6)`,
    [SECOND_RUN_ID, SPACE, AGENT_ID, AGENT_VERSION_ID, now, OWNER, PROJECT],
  );
  await db.pool.query(
    `UPDATE runs
        SET permission_snapshot_json = $2::jsonb
      WHERE id = ANY ($1::varchar[]) AND space_id = $3`,
    [[RUN_ID, SECOND_RUN_ID], JSON.stringify({ tool_grants: [
      { action_id: "project.propose_definition" },
      { action_id: "inquiry.create_thread" },
      { action_id: "inquiry.record_conclusion" },
    ] }), SPACE],
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

describe("inquiry.create_thread, direct (real Postgres)", () => {
  // ADR 0017 §2. Splitting a question into sub-questions is one judgement a
  // person made when they asked; drafting it into N proposals they approve one
  // by one is that judgement taken N times, and one Room turn once produced
  // six pending cards for it. What replaces the gate is the trigger origin,
  // the per-turn bound, and Updates.
  it("opens the Thread in the turn, with no proposal, and records it for the person", async () => {
    if (!db.available) return;
    const run = await new PgRunRepository(db.pool).getRun(SPACE, RUN_ID);
    if (!run) throw new Error("Test Run was not created");
    const dispatcher = await SystemActionDispatcher.create(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      run,
      {} as RuntimeHostExecuteRequest,
    );

    const result = await dispatcher.dispatch({
      id: "create-thread-1",
      name: "inquiry.create_thread",
      arguments_json: JSON.stringify({ kind: "question", statement: "How should agent memory be classified?" }),
    });
    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ ok: true });

    const threads = await db.pool.query<{ object_id: string; statement: string; lifecycle_status: string }>(
      `SELECT object_id, statement, lifecycle_status FROM inquiry_threads WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    expect(threads.rows).toHaveLength(1);
    expect(threads.rows[0]).toMatchObject({ statement: "How should agent memory be classified?", lifecycle_status: "active" });
    // Nothing to approve: the question exists.
    const proposals = await db.pool.query(
      `SELECT id FROM proposals WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT],
    );
    expect(proposals.rows).toHaveLength(0);
    // And the person can see it and take it back.
    const updates = await getProjectUpdates(db.pool, ownerIdentity(), PROJECT, null);
    expect(updates.items.find((item) => item.event_kind === "thread.created")).toMatchObject({
      undo: { action: "archive_thread", target_id: threads.rows[0]!.object_id },
    });
  });

  it("stops at the per-turn bound and tells the Agent to continue next turn", async () => {
    if (!db.available) return;
    const run = await new PgRunRepository(db.pool).getRun(SPACE, RUN_ID);
    if (!run) throw new Error("Test Run was not created");
    const dispatcher = await SystemActionDispatcher.create(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      run,
      {} as RuntimeHostExecuteRequest,
    );
    const open = (index: number) => dispatcher.dispatch({
      id: `create-thread-bound-${index}`,
      name: "inquiry.create_thread",
      arguments_json: JSON.stringify({ kind: "question", statement: `Axis ${index}` }),
    });

    for (let index = 0; index < THREAD_FAN_OUT_PER_TURN; index += 1) {
      expect((await open(index)).modelResult).toMatchObject({ ok: true });
    }
    // Refusing costs a turn, not a decision — the message says so.
    const refused = await open(THREAD_FAN_OUT_PER_TURN);
    expect(refused.modelResult).toMatchObject({ ok: false });
    expect(JSON.stringify(refused.modelResult)).toContain("next turn");
    const threads = await db.pool.query(
      `SELECT object_id FROM inquiry_threads WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT],
    );
    expect(threads.rows).toHaveLength(THREAD_FAN_OUT_PER_TURN);

    // And the next turn may. Asserting only the refusal message would pass
    // even if the bound were keyed on the Project or the Agent, making it
    // permanent — the opposite of "costs a turn, not a decision".
    const nextTurn = await SystemActionDispatcher.create(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      { ...run, id: SECOND_RUN_ID },
      {} as RuntimeHostExecuteRequest,
    );
    const afterTurn = await nextTurn.dispatch({
      id: "create-thread-next-turn",
      name: "inquiry.create_thread",
      arguments_json: JSON.stringify({ kind: "question", statement: "Axis 6" }),
    });
    expect(afterTurn.modelResult, JSON.stringify(afterTurn.modelResult)).toMatchObject({ ok: true });

    // What the person sees: one turn's questions are one row, each undoable.
    const updates = await getProjectUpdates(db.pool, ownerIdentity(), PROJECT, null);
    const fold = updates.items.find((item) => item.members);
    expect(fold).toMatchObject({ summary: `Opened ${THREAD_FAN_OUT_PER_TURN} questions`, undo: null });
    expect(fold!.members).toHaveLength(THREAD_FAN_OUT_PER_TURN);
    expect(fold!.members!.every((member) => member.undo?.action === "archive_thread")).toBe(true);
    // The sixth belongs to the next turn, so it is its own row.
    expect(updates.items.filter((item) => item.event_kind === "thread.created")).toHaveLength(2);
  });

  it("reopens the same question when the statement repeats under a fresh call id", async () => {
    if (!db.available) return;
    // The case a re-planned or re-sampled turn actually produces: the same
    // question worded identically, under a new tool-call id. The retired
    // proposal path coalesced this under an advisory lock; without it the
    // duplicate is durable and the person has to archive it.
    const dispatcher = await SystemActionDispatcher.create(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      (await new PgRunRepository(db.pool).getRun(SPACE, RUN_ID))!,
      {} as RuntimeHostExecuteRequest,
    );
    const ask = (callId: string) => dispatcher.dispatch({
      id: callId,
      name: "inquiry.create_thread",
      arguments_json: JSON.stringify({ kind: "question", statement: "  Asked twice  " }),
    });
    const first = await ask("call-a");
    const second = await ask("call-b");
    expect((first.modelResult as { ok: boolean }).ok, JSON.stringify(first.modelResult)).toBe(true);
    expect((second.modelResult as { thread_id: string }).thread_id)
      .toBe((first.modelResult as { thread_id: string }).thread_id);
    expect((await db.pool.query(
      `SELECT object_id FROM inquiry_threads WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT],
    )).rows).toHaveLength(1);
    // And it did not spend the turn's budget twice.
    const opened = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM project_work_events
        WHERE space_id=$1 AND project_id=$2 AND event_kind='thread.created'`, [SPACE, PROJECT],
    );
    expect(Number(opened.rows[0]!.total)).toBe(1);
  });

  it("reopens the same question when one tool call is retried", async () => {
    if (!db.available) return;
    // The retired proposal path deduped on the run's idempotency key. Without
    // a replacement a re-issued tool call — or a resumed Run — opened a second
    // identical question and spent the bound on it.
    const dispatcher = await SystemActionDispatcher.create(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      (await new PgRunRepository(db.pool).getRun(SPACE, RUN_ID))!,
      {} as RuntimeHostExecuteRequest,
    );
    const call = {
      id: "create-thread-retried",
      name: "inquiry.create_thread",
      arguments_json: JSON.stringify({ kind: "question", statement: "Asked once" }),
    };
    const first = await dispatcher.dispatch(call);
    const second = await dispatcher.dispatch(call);
    expect(first.modelResult).toMatchObject({ ok: true });
    expect((second.modelResult as { thread_id: string }).thread_id)
      .toBe((first.modelResult as { thread_id: string }).thread_id);
    expect((await db.pool.query(
      `SELECT object_id FROM inquiry_threads WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT],
    )).rows).toHaveLength(1);
  });
});

describe("inquiry.record_conclusion, direct (real Postgres)", () => {
  it("writes the Iteration in the turn, with no proposal, and the update can revert it", async () => {
    if (!db.available) return;
    const thread = await new InquiryThreadService(db.pool).createThread(ownerIdentity(), PROJECT, {
      kind: "question", statement: "Does layering help recall?",
    });
    const run = await new PgRunRepository(db.pool).getRun(SPACE, RUN_ID);
    if (!run) throw new Error("Test Run was not created");
    const dispatcher = await SystemActionDispatcher.create(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      run,
      {} as RuntimeHostExecuteRequest,
    );

    const result = await dispatcher.dispatch({
      id: "conclusion-1",
      name: "inquiry.record_conclusion",
      arguments_json: JSON.stringify({
        thread_id: String(thread.id),
        change_summary: "Partly answered",
        answer_state: "partial",
        current_answer_summary: "Layering helps recall",
      }),
    });
    expect(result.modelResult).toMatchObject({ ok: true });

    const state = await db.pool.query<{ answer_state: string }>(
      `SELECT answer_state FROM inquiry_question_states WHERE thread_id=$1`, [thread.id],
    );
    expect(state.rows[0]!.answer_state).toBe("partial");
    expect((await db.pool.query(`SELECT id FROM proposals WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT])).rows)
      .toHaveLength(0);
    const updates = await getProjectUpdates(db.pool, ownerIdentity(), PROJECT, null);
    expect(updates.items.find((item) => item.event_kind === "thread.concluded")?.undo)
      .toMatchObject({ action: "revert_iteration" });
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

describe("Undo, once the Thread has moved on elsewhere (real Postgres)", () => {
  // The symmetric half of the memory rule: an Undo the domain command would
  // refuse is a button that can only fail, so the feed stops offering it —
  // but only where it would actually fail.
  it("stops offering to reopen a Thread the person archived and then resolved", async () => {
    if (!db.available) return;
    const run = await new PgRunRepository(db.pool).getRun(SPACE, RUN_ID);
    if (!run) throw new Error("Test Run was not created");
    const dispatcher = await SystemActionDispatcher.create(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      run,
      {} as RuntimeHostExecuteRequest,
    );
    await dispatcher.dispatch({
      id: "create-thread-undo-scope",
      name: "inquiry.create_thread",
      arguments_json: JSON.stringify({ kind: "question", statement: "Does the feed keep offering this?" }),
    });
    const thread = await db.pool.query<{ object_id: string }>(
      `SELECT object_id FROM inquiry_threads WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT],
    );
    const threadId = thread.rows[0]!.object_id;
    const iterations = new InquiryIterationService(db.pool);

    // Resolved elsewhere: archiving it is still legal, and still records the
    // reversal, so the Undo stays.
    await iterations.transitionLifecycle(ownerIdentity(), PROJECT, threadId, {
      lifecycle_status: "resolved", reason: "Answered in the Area",
    });
    const afterResolve = await getProjectUpdates(db.pool, ownerIdentity(), PROJECT, null);
    expect(afterResolve.items.find((item) => item.event_kind === "thread.created")?.undo)
      .toMatchObject({ action: "archive_thread" });

    // Archived elsewhere: archiving again is a 409, so the button goes.
    await iterations.transitionLifecycle(ownerIdentity(), PROJECT, threadId, {
      lifecycle_status: "archived", reason: "Filed away in the Area",
    });
    const afterArchive = await getProjectUpdates(db.pool, ownerIdentity(), PROJECT, null);
    expect(afterArchive.items.find((item) => item.event_kind === "thread.created")?.undo).toBeNull();
    // And the row that archiving wrote offers the reversal that does apply.
    expect(afterArchive.items.find((item) => item.event_kind === "thread.archived")?.undo)
      .toMatchObject({ action: "reopen_thread" });

    // Reopening from `resolved` is the one divergence: the transition
    // succeeds but `transitionLifecycle` records `thread.reopened` only for
    // `archived -> active`, so nothing would ever mark this row undone and it
    // would go on offering to re-activate a Thread the person had concluded.
    await iterations.transitionLifecycle(ownerIdentity(), PROJECT, threadId, {
      lifecycle_status: "resolved", reason: "Concluded after all",
    });
    const afterReResolve = await getProjectUpdates(db.pool, ownerIdentity(), PROJECT, null);
    expect(afterReResolve.items.find((item) => item.event_kind === "thread.archived")?.undo).toBeNull();

    // A superseded Thread transitions to nothing at all, so it offers nothing.
    await db.pool.query(
      `UPDATE inquiry_threads SET lifecycle_status = 'superseded', attention_state = 'archived'
        WHERE object_id = $1 AND space_id = $2`,
      [threadId, SPACE],
    );
    const afterSupersede = await getProjectUpdates(db.pool, ownerIdentity(), PROJECT, null);
    expect(afterSupersede.items.filter((item) => item.undo !== null)).toEqual([]);
  });
});
