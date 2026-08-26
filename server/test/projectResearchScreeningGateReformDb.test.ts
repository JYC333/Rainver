import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import {
  ProjectResearchScreeningCoordinator,
  type ProjectResearchScreeningPorts,
  type ScreeningOperationRow,
} from "../src/modules/projectResearch/pipeline/screeningCoordinator.js";
import { researchState } from "../src/modules/projectResearch/operationProjection.js";
import { SCREENING_AUTO_CONTINUE_CORPUS_LIMIT } from "../src/modules/projectResearch/researchCheckpointPolicy.js";
import { upsertPendingResearchCheckpoint } from "../src/modules/projectResearch/checkpointWriter.js";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow.js";

// Real-Postgres coverage for the checkpoint reform at the screening
// step: the checkpoint row still records what the machine concluded, but it
// only stops the workflow when the corpus is too big to synthesize
// unattended. Uses a real database because the reform's whole effect is on a
// persisted checkpoint row's status.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const WORKFLOW = "66666666-6666-4666-8666-666666666666";
const OPERATION = "77777777-7777-4777-8777-777777777777";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["project_research_checkpoints", "project_research_workflows", "project_operations", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await insertResearchWorkflowFixture(db.pool, {
    id: WORKFLOW, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER, now,
  });
  await db.pool.query(
    `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
     VALUES ($1,$2,$3,'research','Initial literature intake','active',$4,'{}'::jsonb,$5,$5)`,
    [OPERATION, SPACE, PROJECT, OWNER, now],
  );
});

const operationRow = (): ScreeningOperationRow => ({
  id: OPERATION, space_id: SPACE, project_id: PROJECT, progress_json: {},
});

type SpyPorts = ProjectResearchScreeningPorts & {
  setState: ReturnType<typeof vi.fn>;
  resumeAfterCheckpoint: ReturnType<typeof vi.fn>;
  notifyRoom: ReturnType<typeof vi.fn>;
  failOperation: ReturnType<typeof vi.fn>;
};

function ports(): SpyPorts {
  const createCheckpoint: ProjectResearchScreeningPorts["createCheckpoint"] =
    (spaceId, projectId, workflowId, operationId, type, result) =>
      upsertPendingResearchCheckpoint(db.pool, {
        spaceId, projectId, workflowId, operationId, checkpointType: type, machineResult: result,
      });
  return {
    createCheckpoint,
    setState: vi.fn(async () => {}),
    resumeAfterCheckpoint: vi.fn(async () => {}),
    notifyRoom: vi.fn(async () => {}),
    failOperation: vi.fn(async () => {}),
  };
}

/** Makes `countRelevantItems` report a chosen corpus size without seeding
 * that many real classified items, which is what the gate decision reads. */
function coordinatorWithCorpus(size: number, portsValue: ProjectResearchScreeningPorts) {
  const coordinator = new ProjectResearchScreeningCoordinator(db.pool, portsValue);
  vi.spyOn(coordinator, "countRelevantItems").mockResolvedValue({
    total: size, relevant: size, maybe: 0, excluded: 0,
    missing_full_text: 0, evidence_count: size, failed_items: 0,
  });
  return coordinator;
}

function state() {
  return researchState({ workflow_id: WORKFLOW, run_kind: "baseline", source_item_ids: ["a", "b"] });
}

async function checkpointRow(): Promise<{ status: string; user_decision: string | null; decided_by_user_id: string | null } | undefined> {
  const row = await db.pool.query<{ status: string; user_decision: string | null; decided_by_user_id: string | null }>(
    `SELECT status, user_decision, decided_by_user_id FROM project_research_checkpoints
      WHERE space_id=$1 AND checkpoint_type='screening_gate'`,
    [SPACE],
  );
  return row.rows[0];
}

describe("screening gate reform (real Postgres)", () => {
  it("records the checkpoint and continues when the corpus fits the budget", async () => {
    if (!db.available) return;
    const portsValue = ports();
    const coordinator = coordinatorWithCorpus(12, portsValue);
    const next = state();

    await coordinator.createGate(operationRow(), next);

    // The record survives — the reform removed the interruption, not the
    // evidence of what screening concluded.
    expect(await checkpointRow()).toMatchObject({ status: "waived", user_decision: null, decided_by_user_id: null });
    expect(next.stage_state).toBe("running");
    expect(portsValue.resumeAfterCheckpoint).toHaveBeenCalledWith(expect.anything(), WORKFLOW, expect.any(String));
    expect(portsValue.notifyRoom).not.toHaveBeenCalled();
  });

  it("stops and tells the Room when the corpus exceeds the budget", async () => {
    if (!db.available) return;
    const portsValue = ports();
    const coordinator = coordinatorWithCorpus(SCREENING_AUTO_CONTINUE_CORPUS_LIMIT + 1, portsValue);
    const next = state();

    await coordinator.createGate(operationRow(), next);

    expect(await checkpointRow()).toMatchObject({ status: "pending" });
    expect(next.stage_state).toBe("waiting_review");
    expect(portsValue.resumeAfterCheckpoint).not.toHaveBeenCalled();
    expect(portsValue.notifyRoom).toHaveBeenCalledWith(
      expect.anything(),
      "waiting_review",
      expect.stringContaining(String(SCREENING_AUTO_CONTINUE_CORPUS_LIMIT)),
    );
  });

  it("does not auto-continue while classification is still in flight", async () => {
    if (!db.available) return;
    const portsValue = ports();
    const coordinator = coordinatorWithCorpus(3, portsValue);
    const next = state();
    next.screening_progress = {
      phase: "screening_batches", total_items: 3, classified_items: 1, unclassified_items: 2,
      relevant_items: 1, maybe_items: 0, excluded_items: 0, missing_full_text: 0,
      evidence_count: 1, failed_items: 0, batch_size: 10, total_batches: 1,
      completed_batches: 0, active_batches: 1, queued_batches: 0, running_batches: 1,
      failed_batches: 0, started_at: null, updated_at: new Date().toISOString(), message: "",
    };

    await coordinator.createGate(operationRow(), next);

    // The incremental path opens this checkpoint before classification
    // drains, and each later tick refreshes it — which only works while the
    // row is still pending. Waiving now would both freeze that snapshot and
    // send a partly-classified corpus to synthesis.
    expect(await checkpointRow()).toMatchObject({ status: "pending" });
    expect(portsValue.resumeAfterCheckpoint).not.toHaveBeenCalled();
    expect(next.stage_state).toBe("running");
  });

  it("fails the operation when classification stalls, so retry becomes reachable", async () => {
    if (!db.available) return;
    const portsValue = ports();
    const coordinator = coordinatorWithCorpus(3, portsValue);
    const next = state();
    next.screening_progress = {
      phase: "failed", total_items: 3, classified_items: 1, unclassified_items: 2,
      relevant_items: 1, maybe_items: 0, excluded_items: 0, missing_full_text: 0,
      evidence_count: 1, failed_items: 0, batch_size: 10, total_batches: 1,
      completed_batches: 0, active_batches: 0, queued_batches: 0, running_batches: 0,
      failed_batches: 1, started_at: null, updated_at: new Date().toISOString(), message: "",
    };

    await coordinator.createGate(operationRow(), next);

    // A permanently failed batch never classifies its items, so waiting would
    // show "running" forever. An earlier version parked the operation in
    // `waiting_review` and told the Room to retry — a 409, since retry
    // requires `failed`. Failing is the only state whose advertised remedies
    // (retry, cancel) both actually work, and `failOperation` owns the Room
    // notification.
    expect(portsValue.failOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("stalled"),
    );
    expect(portsValue.notifyRoom).not.toHaveBeenCalled();
    expect(portsValue.resumeAfterCheckpoint).not.toHaveBeenCalled();
    expect(portsValue.setState).not.toHaveBeenCalled();
  });

  it("fails a classification that stops moving even with no failed batch to point at", async () => {
    if (!db.available) return;
    const portsValue = ports();
    const coordinator = coordinatorWithCorpus(3, portsValue);
    const inFlightSnapshot = {
      phase: "preparing_batches" as const, total_items: 3, classified_items: 1, unclassified_items: 2,
      relevant_items: 1, maybe_items: 0, excluded_items: 0, missing_full_text: 0,
      evidence_count: 1, failed_items: 0, batch_size: 10, total_batches: 0,
      completed_batches: 0, active_batches: 0, queued_batches: 0, running_batches: 0,
      // The incremental path enqueues no recovery batches, so every batch
      // counter reads zero and there is no failed batch to detect.
      failed_batches: 0, started_at: null, updated_at: new Date().toISOString(), message: "",
    };

    // First observation only records the watermark.
    const first = state();
    first.screening_progress = { ...inFlightSnapshot };
    await coordinator.createGate(operationRow(), first);
    expect(portsValue.failOperation).not.toHaveBeenCalled();
    expect(first.screening_stall_watch).toMatchObject({ classified_items: 1 });

    // Progress moved: the clock restarts even though the count is still short.
    const moved = state();
    moved.screening_progress = { ...inFlightSnapshot, classified_items: 2, unclassified_items: 1 };
    moved.screening_stall_watch = { classified_items: 1, since: new Date(Date.now() - 5 * 60 * 60_000).toISOString() };
    await coordinator.createGate(operationRow(), moved);
    expect(portsValue.failOperation).not.toHaveBeenCalled();
    expect(moved.screening_stall_watch).toMatchObject({ classified_items: 2 });

    // Same count, long past the window, nothing in flight: stuck, not slow.
    const stuck = state();
    stuck.screening_progress = { ...inFlightSnapshot };
    stuck.screening_stall_watch = { classified_items: 1, since: new Date(Date.now() - 5 * 60 * 60_000).toISOString() };
    await coordinator.createGate(operationRow(), stuck);
    expect(portsValue.failOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("stalled"),
    );
  });

  it("never calls a screening stuck while classification work is in flight", async () => {
    if (!db.available) return;
    const portsValue = ports();
    const coordinator = coordinatorWithCorpus(3, portsValue);
    const next = state();
    next.screening_progress = {
      phase: "screening_batches", total_items: 3, classified_items: 1, unclassified_items: 2,
      relevant_items: 1, maybe_items: 0, excluded_items: 0, missing_full_text: 0,
      evidence_count: 1, failed_items: 0, batch_size: 10, total_batches: 1,
      completed_batches: 0, active_batches: 1, queued_batches: 0, running_batches: 1,
      failed_batches: 0, started_at: null, updated_at: new Date().toISOString(), message: "",
    };
    // A long-running batch is slow, not stuck — however old the watermark is.
    next.screening_stall_watch = { classified_items: 1, since: new Date(Date.now() - 5 * 60 * 60_000).toISOString() };

    await coordinator.createGate(operationRow(), next);

    expect(portsValue.failOperation).not.toHaveBeenCalled();
    expect(next.stage_state).toBe("running");
  });

  it("notifies the Room once per pause, not once per reconcile tick", async () => {
    if (!db.available) return;
    const portsValue = ports();
    const coordinator = coordinatorWithCorpus(SCREENING_AUTO_CONTINUE_CORPUS_LIMIT + 1, portsValue);

    await coordinator.createGate(operationRow(), state());
    // The next tick re-enters createGate while the checkpoint is pending; the
    // operation row now carries the paused stage_state.
    const pausedRow: ScreeningOperationRow = {
      ...operationRow(),
      progress_json: { workflow_id: WORKFLOW, run_kind: "baseline", stage_state: "waiting_review" },
    };
    await coordinator.createGate(pausedRow, state());
    await coordinator.createGate(pausedRow, state());

    expect(portsValue.notifyRoom).toHaveBeenCalledTimes(1);
  });

  it("persists the advance before waiving, so a dropped write replays", async () => {
    if (!db.available) return;
    const portsValue = ports();
    // A setState that never lands (the stage-advancing writer is
    // `onStale: "noop"`, so this is silent in production).
    portsValue.setState.mockRejectedValueOnce(new Error("stale write"));
    const coordinator = coordinatorWithCorpus(5, portsValue);

    await expect(coordinator.createGate(operationRow(), state())).rejects.toThrow("stale write");

    // Still pending: had it been waived first, `screeningGateDecided` would
    // treat screening as finished and never re-enter this transition, leaving
    // the operation stranded with no failed status to retry from.
    expect(await checkpointRow()).toMatchObject({ status: "pending" });
    expect(portsValue.resumeAfterCheckpoint).not.toHaveBeenCalled();
  });

  it("marks the screening step done rather than blocked when it auto-continues", async () => {
    if (!db.available) return;
    const portsValue = ports();
    const coordinator = coordinatorWithCorpus(3, portsValue);

    await coordinator.createGate(operationRow(), state());

    const steps = portsValue.setState.mock.calls[0]![2] as Array<{ seq: number; status: string; detail?: Record<string, unknown> }>;
    const screeningStep = steps.find(step => step.seq === 2)!;
    expect(screeningStep.status).toBe("done");
    expect(screeningStep.detail).toMatchObject({ auto_continued: true });
    // The next stage must be shown as under way, or the operation reads as
    // finished-at-screening in every surface that renders these steps.
    expect(steps.find(step => step.seq === 3)!.status).toBe("active");
  });
});
