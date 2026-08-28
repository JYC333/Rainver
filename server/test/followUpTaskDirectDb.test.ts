import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { loadConfig } from "../src/config.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { RunMaterializationService } from "../src/modules/runs/materializationService.js";
import { PgProposalApplyService } from "../src/modules/proposals/applyService.js";
import { createFollowUpTask, parseFollowUpTaskPayload } from "../src/modules/tasks/followUpTask.js";
import {
  applyAttendedFollowUpTasks,
  registerFollowUpTaskFinalizationReconciler,
} from "../src/modules/tasks/followUpTaskReconciler.js";
import { runFinalizationReconcilerRegistry } from "../src/modules/runs/finalizationReconcilerRegistry.js";
import type { RunAdapterResultEnvelope } from "@rainver/protocol";

// The follow-up Task a Run asks for at the end of its work (ADR 0017 §2).
// A person who asked for the work does not approve it a second time — the
// Task is applied for them once the Run has actually succeeded. An unattended
// origin still waits, because a Task nobody asked for is a commitment made on
// the Project's behalf, and so does everything the output was provisional
// about: a failed Run, a dry run, an egress owner who has not decided.

const SPACE = "41111111-1111-4111-8111-111111111111";
const OWNER = "4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_VERSION_ID = "4ddddddd-dddd-4ddd-8ddd-dddddddddddd";

const db = useTestDatabase(import.meta.filename);

let PROJECT: string;

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["project_work_events", "actors", "tasks", "proposals", "runs", "agent_versions", "agents", "space_objects", "projects", "project_members", "space_memberships", "users", "spaces"],
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
     VALUES ($1, $2, $3, 'Worker', 'active', NULL, $4, $4, 'space_shared')`,
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
  const project = await new PgProjectRepository(db.pool).create({ spaceId: SPACE, userId: OWNER }, { name: "Follow-up Project" });
  PROJECT = project.id as string;
});

async function runWithOrigin(triggerOrigin: string) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, created_at, updated_at, owner_user_id, visibility, access_level, project_id, instructed_by_user_id)
     VALUES ($1,$2,$3,$4,'agent',$5,'succeeded','live',$6,$6,$7,'private','full',$8,$7)`,
    [id, SPACE, AGENT_ID, AGENT_VERSION_ID, triggerOrigin, now, OWNER, PROJECT],
  );
  return (await new PgRunRepository(db.pool).getRun(SPACE, id))!;
}

function adapterResult(): RunAdapterResultEnvelope {
  return {
    adapter_type: "model_api",
    adapter_kind: "managed_api",
    success: true,
    output_text: "",
    output_json: {
      proposed_changes: [{
        proposal_type: "follow_up_task",
        payload_json: { task: { title: "Read the two papers it found", priority: "high" } },
      }],
    },
  } as unknown as RunAdapterResultEnvelope;
}

const service = () => new RunMaterializationService(
  loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
  db.pool,
);

/** What a Run's successful termination does to its staged output. */
async function promoteStagedProposals(runId: string) {
  await db.pool.query(
    `UPDATE proposals SET status = 'pending' WHERE space_id = $1 AND created_by_run_id = $2 AND status = 'staged'`,
    [SPACE, runId],
  );
}

async function tasks() {
  const rows = await db.pool.query<{ id: string; title: string; status: string; project_id: string | null; source_proposal_id: string | null; metadata_json: Record<string, unknown> }>(
    `SELECT id, title, status, project_id, source_proposal_id, metadata_json FROM tasks WHERE space_id = $1`,
    [SPACE],
  );
  return rows.rows;
}

describe("follow-up Tasks from a Run's output (real Postgres)", () => {
  it("applies the follow-up itself once the Run has actually succeeded", async () => {
    if (!db.available) return;
    const run = await runWithOrigin("manual");
    const result = await service().materializeAdapterResult(
      { run, adapterResult: adapterResult() },
      // What production passes: an output is provisional until the Run ends.
      { proposal_status: "staged" },
    );
    expect(result.errors).toEqual([]);
    expect(result.items[0]).toMatchObject({ kind: "proposal", status: "succeeded" });
    // Nothing on the Board yet — the Run has not finished.
    expect(await tasks()).toEqual([]);

    await promoteStagedProposals(run.id);
    await applyAttendedFollowUpTasks(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), db.pool, run);

    const created = await tasks();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: "Read the two papers it found", status: "inbox", project_id: PROJECT });
    // No card left for the person: they asked for the work, and this is it.
    const proposals = await db.pool.query<{ status: string }>(
      `SELECT status FROM proposals WHERE space_id=$1`, [SPACE],
    );
    expect(proposals.rows).toEqual([{ status: "accepted" }]);

    // And the stream says the Agent decided it — on the Board the Task is the
    // person's either way.
    const events = await db.pool.query<{ event_kind: string; origin: string | null; agent_id: string | null; run_id: string | null }>(
      `SELECT e.event_kind, e.data_json->>'origin' AS origin, a.agent_id,
              e.data_json->>'run_id' AS run_id
         FROM project_work_events e JOIN actors a ON a.id = e.actor_id
        WHERE e.space_id = $1 AND e.project_id = $2`,
      [SPACE, PROJECT],
    );
    expect(events.rows).toContainEqual({
      event_kind: "task.created",
      origin: "agent",
      agent_id: AGENT_ID,
      // The Run it came out of, and the key a turn's Tasks would fold on if
      // the feed ever carries them.
      run_id: run.id,
    });
  });

  it("leaves the card standing when nobody asked for the work", async () => {
    if (!db.available) return;
    const run = await runWithOrigin("autonomous");
    await service().materializeAdapterResult(
      { run, adapterResult: adapterResult() },
      { proposal_status: "staged" },
    );
    await promoteStagedProposals(run.id);
    await applyAttendedFollowUpTasks(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), db.pool, run);

    expect(await tasks()).toEqual([]);
    const proposals = await db.pool.query<{ status: string; proposal_type: string }>(
      `SELECT status, proposal_type FROM proposals WHERE space_id=$1`, [SPACE],
    );
    expect(proposals.rows).toEqual([{ status: "pending", proposal_type: "follow_up_task" }]);
  });

  it("creates nothing from a Run that did not survive its own verification", async () => {
    if (!db.available) return;
    const run = await runWithOrigin("manual");
    await service().materializeAdapterResult(
      { run, adapterResult: adapterResult() },
      { proposal_status: "staged" },
    );
    // What a failed Run does to its own staged output.
    await db.pool.query(
      `UPDATE proposals SET status = 'rejected' WHERE space_id = $1 AND created_by_run_id = $2 AND status = 'staged'`,
      [SPACE, run.id],
    );
    await applyAttendedFollowUpTasks(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), db.pool, run);
    // Work the system decided never happened must not be on the Board.
    expect(await tasks()).toEqual([]);
  });

  it("leaves a dry run's follow-up alone", async () => {
    if (!db.available) return;
    const run = await runWithOrigin("manual");
    // The Run really is a dry run, so this case fails if the reconciler's own
    // mode check is removed — not only if the preview flag stops working.
    await db.pool.query(`UPDATE runs SET mode = 'dry_run' WHERE id = $1`, [run.id]);
    const dryRun = { ...run, mode: "dry_run" as const };
    await service().materializeAdapterResult(
      { run: dryRun, adapterResult: adapterResult() },
      { proposal_status: "staged" },
    );
    await db.pool.query(
      `UPDATE proposals SET preview = false, status = 'pending' WHERE space_id = $1 AND created_by_run_id = $2`,
      [SPACE, run.id],
    );
    await applyAttendedFollowUpTasks(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), db.pool, dryRun);
    expect(await tasks()).toEqual([]);
  });

  it("leaves a follow-up naming another Project to the person", async () => {
    if (!db.available) return;
    const elsewhere = await new PgProjectRepository(db.pool).create({ spaceId: SPACE, userId: OWNER }, { name: "Somewhere else" });
    const run = await runWithOrigin("manual");
    await service().materializeAdapterResult({
      run,
      adapterResult: {
        ...adapterResult(),
        output_json: {
          proposed_changes: [{
            proposal_type: "follow_up_task",
            project_id: elsewhere.id,
            payload_json: { task: { title: "Work over there" } },
          }],
        },
      } as unknown as RunAdapterResultEnvelope,
    }, { proposal_status: "staged" });
    await promoteStagedProposals(run.id);
    await applyAttendedFollowUpTasks(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), db.pool, run);

    // `task.create` refuses the same input outright; here it becomes a card,
    // because writing into a Project the person may not be working in is
    // their decision, not the Agent's.
    expect(await tasks()).toEqual([]);
    const proposals = await db.pool.query<{ status: string; project_id: string }>(
      `SELECT status, project_id FROM proposals WHERE space_id=$1`, [SPACE],
    );
    expect(proposals.rows).toEqual([{ status: "pending", project_id: elsewhere.id }]);
  });

  it("waits for the content owner when the turn was assembled from their private material", async () => {
    if (!db.available) return;
    const other = "4fffffff-ffff-4fff-8fff-ffffffffffff";
    await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Other', 'active', now(), now())`, [other]);
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE, other],
    );
    const run = await runWithOrigin("manual");
    // What `persistRunContextTaint` records when the turn read someone else's
    // private content (ADR 0013).
    await db.pool.query(
      `UPDATE runs SET has_context_taint = true, context_taint_json = $2::jsonb WHERE id = $1`,
      [run.id, JSON.stringify({
        schema_version: 1,
        narrowest_visibility: "private",
        input_owner_user_ids: [other],
        non_instructing_owner_user_ids: [other],
        personal_memory_grant_ids: [],
      })],
    );
    const tainted = (await new PgRunRepository(db.pool).getRun(SPACE, run.id))!;
    await service().materializeAdapterResult(
      { run: tainted, adapterResult: adapterResult() },
      { proposal_status: "staged" },
    );
    await promoteStagedProposals(run.id);
    await applyAttendedFollowUpTasks(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), db.pool, tainted);

    // A Task paraphrasing their content must not become Space-readable
    // because a Run finished — the owner decides that, and until they do the
    // card stands.
    expect(await tasks()).toEqual([]);
    const proposals = await db.pool.query<{ status: string; payload_json: Record<string, unknown> }>(
      `SELECT status, payload_json FROM proposals WHERE space_id=$1`, [SPACE],
    );
    expect(proposals.rows[0]).toMatchObject({ status: "pending" });
    expect(proposals.rows[0]!.payload_json).toMatchObject({ requires_approval_type: "egress_content_owner" });
  });

  it("is actually registered, so finalizing a Run applies it", async () => {
    if (!db.available) return;
    runFinalizationReconcilerRegistry.__resetForTests();
    registerFollowUpTaskFinalizationReconciler(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }));
    const run = await runWithOrigin("manual");
    await service().materializeAdapterResult(
      { run, adapterResult: adapterResult() },
      { proposal_status: "staged" },
    );
    await promoteStagedProposals(run.id);
    // Through the registry, not the function: deleting the registration line
    // is the failure this case exists to catch.
    await runFinalizationReconcilerRegistry.reconcileAll(db.pool, run);
    expect(await tasks()).toHaveLength(1);
  });

  it("refuses the write itself when the person cannot write into that Project", async () => {
    if (!db.available) return;
    const outsider = "4eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Reviewer', 'active', now(), now())`, [outsider]);
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'reviewer', 'active', now(), now())`,
      [randomUUID(), SPACE, outsider],
    );
    // The gate itself, not one of the gates in front of it: a space role that
    // may apply a medium-risk proposal still says nothing about whether that
    // person may write into this Project, and both routes reach the write
    // through here.
    await expect(createFollowUpTask(db.pool, { spaceId: SPACE, userId: outsider }, {
      pool: db.pool,
      fields: parseFollowUpTaskPayload({ task: { title: "Not theirs to add" } }),
      projectId: PROJECT,
      projectFolderId: null,
      origin: { runId: null },
      source: "test",
    // Not `/project/`: that would also match "Project not found" and
    // "Project is archived", so a drift from 403 to either would pass.
    })).rejects.toThrow(/writer|permission|forbidden/i);
    expect(await tasks()).toEqual([]);
  });

  it("refuses the accept once the Project has been archived", async () => {
    if (!db.available) return;
    const run = await runWithOrigin("autonomous");
    await service().materializeAdapterResult(
      { run, adapterResult: adapterResult() },
      { proposal_status: "staged" },
    );
    await promoteStagedProposals(run.id);
    await db.pool.query(`UPDATE projects SET status = 'archived' WHERE id = $1`, [PROJECT]);
    const proposal = await db.pool.query<{ id: string }>(`SELECT id FROM proposals WHERE space_id=$1`, [SPACE]);
    // The card can then only be rejected, which is what PROPOSALS.md says.
    await expect(
      PgProposalApplyService
        .fromConfig(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }))
        .accept(proposal.rows[0]!.id, { spaceId: SPACE, userId: OWNER }),
    ).rejects.toThrow();
    expect(await tasks()).toEqual([]);
  });

  it("accepting the card by hand produces the same Task, through the same writer", async () => {
    if (!db.available) return;
    const run = await runWithOrigin("autonomous");
    await service().materializeAdapterResult(
      { run, adapterResult: adapterResult() },
      { proposal_status: "staged" },
    );
    await promoteStagedProposals(run.id);
    const proposal = await db.pool.query<{ id: string }>(
      `SELECT id FROM proposals WHERE space_id=$1`, [SPACE],
    );
    await PgProposalApplyService
      .fromConfig(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }))
      .accept(proposal.rows[0]!.id, { spaceId: SPACE, userId: OWNER });

    const created = await tasks();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      title: "Read the two papers it found",
      status: "inbox",
      project_id: PROJECT,
      source_proposal_id: proposal.rows[0]!.id,
    });
  });
});
