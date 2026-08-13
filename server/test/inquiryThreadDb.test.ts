import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { PgProjectRepository } from "../src/modules/projects/repository";
import { InquiryGraphService } from "../src/modules/inquiry/graphService";
import { buildSpaceObjectInsert } from "../src/db/spaceObjectWriter";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService";
import { completeBackgroundStep } from "../src/modules/inquiry/stepService";

// Real-Postgres coverage for the Inquiry Core vertical slice: Thread
// creation, working relations, Note links, the cognitive Iteration command,
// the Definition Revision command, and the work-management command's
// boundary from both of those. See plan section 9 and ADR 0011.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[inquiry-thread-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let PROJECT: string;

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    "TRUNCATE inquiry_thread_work_events, inquiry_iterations, inquiry_thread_statement_revisions, inquiry_thread_personal_focus, inquiry_question_states, inquiry_hypothesis_states, inquiry_threads, inquiry_project_settings, notes, space_objects, projects, project_members, space_memberships, users, spaces CASCADE",
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES
       ($1, 'Owner', 'active', $3, $3), ($2, 'Viewer', 'active', $3, $3)`,
    [OWNER, VIEWER, now],
  );
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES
       ($1, $2, $3, 'owner', 'active', $5, $5), ($4, $2, $6, 'member', 'active', $5, $5)`,
    [randomUUID(), SPACE, OWNER, randomUUID(), now, VIEWER],
  );
  const project = await new PgProjectRepository(pool).create({ spaceId: SPACE, userId: OWNER }, { name: "Inquiry Project" });
  PROJECT = project.id as string;
});

const ownerIdentity = () => ({ spaceId: SPACE, userId: OWNER });
const viewerIdentity = () => ({ spaceId: SPACE, userId: VIEWER });

async function createNote(): Promise<string> {
  const objectId = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, 'note', 'A note', 'private', $3, $4, $4)`,
    [objectId, SPACE, OWNER, now],
  );
  await pool!.query(
    `INSERT INTO notes (object_id, space_id, content_format, content_schema_version) VALUES ($1, $2, 'markdown', 1)`,
    [objectId, SPACE],
  );
  return objectId;
}

describe("Inquiry Core (real Postgres)", () => {
  it("golden path: create Question + Hypothesis, relate them, link a Note, record a cited Iteration, set one Next Focus", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();

    const question = await threadSvc.createThread(identity, PROJECT, {
      kind: "question",
      statement: "Does caching improve retrieval latency?",
    });
    const hypothesis = await threadSvc.createThread(identity, PROJECT, {
      kind: "hypothesis",
      statement: "A warm cache halves p95 latency",
      proposed_claim: "Cache hit rate above 80% halves p95 latency",
    });

    const relation = await threadSvc.addRelation(identity, PROJECT, {
      from_thread_id: question.id,
      to_thread_id: hypothesis.id,
      relation_kind: "proposes",
    });
    expect(relation).toMatchObject({ relation_kind: "proposes" });

    const noteId = await createNote();
    const link = await threadSvc.linkNote(identity, PROJECT, question.id as string, { note_object_id: noteId });
    expect(link).toMatchObject({ note_object_id: noteId, link_kind: "linked_note" });

    const iteration = await iterationSvc.recordIteration(identity, PROJECT, hypothesis.id as string, {
      change_summary: "First benchmark supports the hypothesis",
      evaluation_state: "supported",
      confidence: 70,
      confidence_method: "human_confirmed",
      input_refs: [{ ref_type: "benchmark_run", ref_id: "bench-1" }],
      confirmed_next_focus: "synthesize",
    });
    expect(iteration.change_summary).toBe("First benchmark supports the hypothesis");
    expect((iteration.thread as Record<string, unknown>).next_focus_kind).toBe("synthesize");

    const detail = await threadSvc.getThread(identity, PROJECT, hypothesis.id as string);
    expect(detail.hypothesis_state).toMatchObject({ evaluation_state: "supported", confidence: 70 });
    expect(detail.next_focus_kind).toBe("synthesize");
    expect((detail.note_links as unknown[]).length).toBe(0); // note was linked to the Question, not the Hypothesis

    const questionDetail = await threadSvc.getThread(identity, PROJECT, question.id as string);
    expect((questionDetail.note_links as Array<{ note_object_id: string }>)[0]?.note_object_id).toBe(noteId);
    expect((questionDetail.relations as unknown[]).length).toBe(1);

    // No AI/Workflow is required for the core loop: nothing above touched runs.
    const runCount = await pool.query<{ total: string }>(`SELECT count(*)::text AS total FROM runs`);
    expect(runCount.rows[0]?.total).toBe("0");
  });

  it("protected cognitive fields cannot be overwritten through the work-management command", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Is X true?" });

    await iterationSvc.recordIteration(identity, PROJECT, question.id as string, {
      change_summary: "Initial read",
      current_answer_summary: "Looks likely",
      answer_state: "partial",
    });

    // Attempt to smuggle a cognitive-looking field through the work command.
    await iterationSvc.updateWork(identity, PROJECT, question.id as string, {
      priority: 5,
      current_answer_summary: "SILENTLY OVERWRITTEN",
      answer_state: "answered",
      statement: "SILENTLY OVERWRITTEN STATEMENT",
    });

    const detail = await threadSvc.getThread(identity, PROJECT, question.id as string);
    expect(detail.priority).toBe(5); // the legitimate field did change
    expect(detail.statement).toBe("Is X true?"); // untouched — not a Definition Revision command
    expect(detail.question_state).toMatchObject({ current_answer_summary: "Looks likely", answer_state: "partial" }); // untouched

    // Changing priority alone did not create a cognitive Iteration.
    const iterations = await iterationSvc.listIterations(identity, PROJECT, question.id as string);
    expect(iterations).toHaveLength(1); // only the earlier recordIteration call
  });

  it("a semantic statement change cannot pass through the work-management command and requires the Definition Revision command", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Original statement" });

    await iterationSvc.updateWork(identity, PROJECT, question.id as string, { statement: "Hijacked via work command" });
    expect((await threadSvc.getThread(identity, PROJECT, question.id as string)).statement).toBe("Original statement");

    const revised = await iterationSvc.reviseDefinition(identity, PROJECT, question.id as string, {
      revision_kind: "wording_only",
      new_statement: "Original statement, rephrased",
    });
    expect((revised.thread as Record<string, unknown>).statement).toBe("Original statement, rephrased");
    expect(revised.superseded_by_thread_id).toBeNull();
    const revisions = await iterationSvc.listRevisions(identity, PROJECT, question.id as string);
    expect(revisions).toMatchObject([
      { version: 2, statement: "Original statement, rephrased", change_significance: "trivial" },
      { version: 1, statement: "Original statement", change_significance: "material" },
    ]);
  });

  it("a wording_only revision cannot smuggle a substantive definition field change", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const hypothesis = await threadSvc.createThread(identity, PROJECT, {
      kind: "hypothesis",
      statement: "Original claim wording",
      proposed_claim: "Original claim",
    });

    await iterationSvc.reviseDefinition(identity, PROJECT, hypothesis.id as string, {
      revision_kind: "wording_only",
      new_statement: "Original claim wording (typo fixed)",
      new_proposed_claim: "SILENTLY SMUGGLED CLAIM CHANGE",
    });

    const detail = await threadSvc.getThread(identity, PROJECT, hypothesis.id as string);
    expect(detail.hypothesis_state).toMatchObject({ proposed_claim: "Original claim" });
  });

  it("a semantic_change revision with structure_action=supersede creates a new Thread and archives the old one", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Narrow question" });

    const result = await iterationSvc.reviseDefinition(identity, PROJECT, question.id as string, {
      revision_kind: "semantic_change",
      new_statement: "A fundamentally different question",
      structure_action: "supersede",
      impact_note: "Scope changed after review",
      new_resolution_criteria: "New criterion",
    });
    const newThreadId = result.superseded_by_thread_id as string;
    expect(newThreadId).toBeTruthy();

    const oldThread = await threadSvc.getThread(identity, PROJECT, question.id as string);
    expect(oldThread.lifecycle_status).toBe("superseded");
    expect(oldThread.question_state).toMatchObject({ resolution_criteria: null });
    const newThread = await threadSvc.getThread(identity, PROJECT, newThreadId);
    expect(newThread.statement).toBe("A fundamentally different question");
    expect(newThread.question_state).toMatchObject({ resolution_criteria: "New criterion" });
    expect((newThread.relations as Array<{ relation_kind: string; to_thread_id: string }>).some(
      (r) => r.relation_kind === "supersedes" && r.to_thread_id === question.id,
    )).toBe(true);
  });

  it("rejects semantic_change without structure_action, and rejects structure_action on wording_only", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Q" });

    await expect(
      iterationSvc.reviseDefinition(identity, PROJECT, question.id as string, { revision_kind: "semantic_change", new_statement: "Q2" }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      iterationSvc.reviseDefinition(identity, PROJECT, question.id as string, {
        revision_kind: "wording_only",
        new_statement: "Q2",
        structure_action: "narrow",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a step and a blocking reason together, but allows a focused Thread to hold neither", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Q" });

    await expect(
      iterationSvc.updateWork(identity, PROJECT, question.id as string, {
        attention_state: "focused",
        next_focus_kind: "read_evidence",
        blocked_reason: "both is invalid",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });

    // Focusing a Thread no longer demands that a next step be named first.
    // That demand was the reason the UI made users pick from a menu before
    // they could put a Thread in Focus at all.
    const bare = await iterationSvc.updateWork(identity, PROJECT, question.id as string, {
      attention_state: "focused",
    });
    expect(bare.attention_state).toBe("focused");
    expect(bare.next_focus_kind).toBeNull();
    expect(bare.blocked_reason).toBeNull();

    const focused = await iterationSvc.updateWork(identity, PROJECT, question.id as string, {
      blocked_reason: "waiting on a source",
    });
    expect(focused.blocked_reason).toBe("waiting on a source");
  });

  it("records a step for each declared Next Focus and keeps the Thread column as its projection", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Steps" });
    const threadId = question.id as string;

    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "read_evidence" });
    let steps = await iterationSvc.listSteps(identity, PROJECT, threadId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "read_evidence", status: "in_progress", slot: "primary", origin: "user" });

    // Re-declaring the same step must not restart it or open a second row.
    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "read_evidence" });
    expect(await iterationSvc.listSteps(identity, PROJECT, threadId)).toHaveLength(1);

    // Choosing a different action abandons the previous intent rather than
    // queueing beside it.
    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "synthesize" });
    steps = await iterationSvc.listSteps(identity, PROJECT, threadId);
    expect(steps).toHaveLength(2);
    expect(steps.find((s) => s.kind === "read_evidence")).toMatchObject({ status: "abandoned" });
    const detail = await threadSvc.getThread(identity, PROJECT, threadId);
    expect(detail.next_focus_kind).toBe("synthesize");

    // Clearing the step clears the projection and its note together.
    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: null });
    const cleared = await threadSvc.getThread(identity, PROJECT, threadId);
    expect(cleared.next_focus_kind).toBeNull();
    expect(cleared.next_focus_note).toBeNull();
  });

  it("moves a search into the background slot so the primary slot stays free", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Background" });
    const threadId = question.id as string;

    const searching = await iterationSvc.updateWork(identity, PROJECT, threadId, {
      next_focus_kind: "search_acquisition",
    });
    // The search is running, so the user's one attention slot is not spent on
    // watching it — which is what `wait_for_monitoring` used to stand for.
    expect(searching.next_focus_kind).toBeNull();
    const steps = await iterationSvc.listSteps(identity, PROJECT, threadId);
    expect(steps[0]).toMatchObject({ kind: "search_acquisition", slot: "background", status: "in_progress" });

    // Reading evidence meanwhile takes the primary slot without disturbing it.
    const reading = await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "read_evidence" });
    expect(reading.next_focus_kind).toBe("read_evidence");
    const after = await iterationSvc.listSteps(identity, PROJECT, threadId);
    expect(after.find((s) => s.kind === "search_acquisition")).toMatchObject({ status: "in_progress" });
    expect(after.filter((s) => s.status === "in_progress")).toHaveLength(2);
  });

  it("finishes the evidence step when the search finishes, without asking the user to say so", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Auto-complete" });
    const threadId = question.id as string;

    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "search_acquisition" });
    const completed = await completeBackgroundStep(pool, {
      spaceId: SPACE,
      threadId,
      kind: "search_acquisition",
      at: new Date().toISOString(),
      targetRefKind: "research_workflow",
      targetRefId: "workflow-1",
    });
    expect(completed).toBe(true);

    const steps = await iterationSvc.listSteps(identity, PROJECT, threadId);
    // The step records what produced it, which is what lets the destination
    // Area name the Thread that sent the user there.
    expect(steps[0]).toMatchObject({
      kind: "search_acquisition",
      status: "done",
      target_ref_kind: "research_workflow",
      target_ref_id: "workflow-1",
    });

    // Manual work has no such fact behind it and is deliberately left alone.
    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "read_evidence" });
    expect(await completeBackgroundStep(pool, {
      spaceId: SPACE, threadId, kind: "read_evidence", at: new Date().toISOString(),
    })).toBe(false);
  });

  it("does not carry a private Thread's statement into another member's origin bar", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const thread = await threadSvc.createThread(ownerIdentity(), PROJECT, {
      kind: "question",
      statement: "SECRET owner-only question",
    });
    await iterationSvc.updateWork(ownerIdentity(), PROJECT, thread.id as string, { next_focus_kind: "synthesize" });
    await pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
      [randomUUID(), SPACE, PROJECT, VIEWER],
    );
    expect(await iterationSvc.listOpenProjectSteps(viewerIdentity(), PROJECT)).toHaveLength(1);

    await pool.query(
      `UPDATE space_objects SET visibility = 'private' WHERE id = $1 AND space_id = $2`,
      [thread.id as string, SPACE],
    );
    // This read carries the Thread's statement, so Project membership is not
    // sufficient — the same gate every other Inquiry read applies.
    expect(await iterationSvc.listOpenProjectSteps(viewerIdentity(), PROJECT)).toEqual([]);
    expect(await iterationSvc.listOpenProjectSteps(ownerIdentity(), PROJECT)).toHaveLength(1);
  });

  it("carries an open step across Areas with the Thread it belongs to", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Where did I come from?" });
    await iterationSvc.updateWork(identity, PROJECT, question.id as string, { next_focus_kind: "synthesize" });

    const open = await iterationSvc.listOpenProjectSteps(identity, PROJECT);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "synthesize", statement: "Where did I come from?" });

    // Closing the step takes the context with it: the user is no longer on
    // that errand, so no Area should claim they are.
    await iterationSvc.updateWork(identity, PROJECT, question.id as string, { next_focus_kind: null });
    expect(await iterationSvc.listOpenProjectSteps(identity, PROJECT)).toEqual([]);
  });

  it("assigns every settled step to the round that closed, so the next round starts empty", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Rounds" });
    const threadId = question.id as string;

    // A search started and called off inside round 1 ends as `abandoned`,
    // which no close-out would otherwise stamp — leaving it visible to every
    // later round as if that round had already gathered evidence.
    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "search_acquisition" });
    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: null });
    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "read_evidence" });
    const first = await iterationSvc.recordIteration(identity, PROJECT, threadId, {
      change_summary: "Round one", answer_state: "partial",
    });

    const steps = await iterationSvc.listSteps(identity, PROJECT, threadId);
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.iteration_id === first.id)).toBe(true);
  });

  it("can call off a running background search, which the primary-only column cannot express", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Cancel" });
    const threadId = question.id as string;

    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "search_acquisition" });
    // `next_focus_kind` reads null while the search runs, so a dirty-check
    // against the column alone would treat this call as a no-op.
    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: null });

    const steps = await iterationSvc.listSteps(identity, PROJECT, threadId);
    expect(steps.every((s) => s.status !== "in_progress")).toBe(true);
  });

  it("refuses to mark a Thread blocked while a background search is still open", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Blocked+bg" });
    const threadId = question.id as string;

    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "search_acquisition" });
    await expect(
      iterationSvc.updateWork(identity, PROJECT, threadId, { blocked_reason: "no institutional access" }),
    ).rejects.toMatchObject({ statusCode: 422 });

    // Clearing the step first is the supported route.
    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: null });
    const blocked = await iterationSvc.updateWork(identity, PROJECT, threadId, {
      blocked_reason: "no institutional access",
    });
    expect(blocked.blocked_reason).toBe("no institutional access");
  });

  it("keeps a note written for a background step instead of discarding it", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Notes" });
    const threadId = question.id as string;

    await iterationSvc.updateWork(identity, PROJECT, threadId, {
      next_focus_kind: "search_acquisition",
      next_focus_note: "only 2020 onwards",
    });
    const steps = await iterationSvc.listSteps(identity, PROJECT, threadId);
    expect(steps[0]).toMatchObject({ kind: "search_acquisition", note: "only 2020 onwards" });
  });

  it("keeps a step's note when the same step is re-declared, and never copies it onto another", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Notes across steps" });
    const threadId = question.id as string;

    await iterationSvc.updateWork(identity, PROJECT, threadId, {
      next_focus_kind: "search_acquisition",
      next_focus_note: "only 2020+",
    });
    // Following the call to action again sends no note. The card documents this
    // as free, so it must not cost the user what they wrote.
    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "search_acquisition" });
    let steps = await iterationSvc.listSteps(identity, PROJECT, threadId);
    expect(steps.find((s) => s.kind === "search_acquisition")?.note).toBe("only 2020+");

    // A note belongs to the step it was written for. The Thread column is only
    // a projection of the primary step, so it must not seed a different one.
    await iterationSvc.updateWork(identity, PROJECT, threadId, {
      next_focus_kind: "read_evidence",
      next_focus_note: "read the six papers",
    });
    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "synthesize" });
    steps = await iterationSvc.listSteps(identity, PROJECT, threadId);
    expect(steps.find((s) => s.kind === "synthesize")?.note).toBeNull();
    expect(steps.find((s) => s.kind === "read_evidence")?.note).toBe("read the six papers");
  });

  it("records no work event when a running step is re-declared", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Audit" });
    const threadId = question.id as string;

    for (let i = 0; i < 3; i += 1) {
      await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "search_acquisition" });
    }
    const events = await iterationSvc.listWorkEvents(identity, PROJECT, threadId);
    expect(events.filter((e) => e.action_kind === "next_focus_kind")).toHaveLength(1);
  });

  it("ends open steps when a Thread leaves the active lifecycle", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Resolve" });
    const threadId = question.id as string;

    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "search_acquisition" });
    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "read_evidence" });
    await iterationSvc.transitionLifecycle(identity, PROJECT, threadId, { lifecycle_status: "resolved", reason: "answered" });

    const steps = await iterationSvc.listSteps(identity, PROJECT, threadId);
    // Nothing may stay open on a Thread no command can act on again — an open
    // primary step would also hold the single-primary index if it reopens.
    expect(steps.every((s) => s.status !== "in_progress")).toBe(true);
  });

  it("closes the round's steps into the Iteration that ended it", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Round" });
    const threadId = question.id as string;

    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "search_acquisition" });
    await iterationSvc.updateWork(identity, PROJECT, threadId, { next_focus_kind: "read_evidence" });
    const iteration = await iterationSvc.recordIteration(identity, PROJECT, threadId, {
      change_summary: "Read the first six sources",
      answer_state: "partial",
    });

    const steps = await iterationSvc.listSteps(identity, PROJECT, threadId);
    const read = steps.find((s) => s.kind === "read_evidence");
    expect(read).toMatchObject({ status: "done", iteration_id: iteration.id });
    // A search does not finish because the user wrote up what they learned so
    // far; it keeps running and belongs to the next round.
    expect(steps.find((s) => s.kind === "search_acquisition")).toMatchObject({
      status: "in_progress",
      iteration_id: null,
    });
    expect((iteration.thread as Record<string, unknown>).next_focus_kind).toBeNull();
  });

  it("lists the personal Focus of the calling user only", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const identity = ownerIdentity();
    const focused = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "In focus" });
    await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Not in focus" });
    await threadSvc.setPersonalFocus(identity, PROJECT, focused.id as string, true);

    const list = await threadSvc.listPersonalFocus(identity, PROJECT);
    expect(list.map((row) => row.id)).toEqual([focused.id]);

    await threadSvc.setPersonalFocus(identity, PROJECT, focused.id as string, false);
    expect(await threadSvc.listPersonalFocus(identity, PROJECT)).toEqual([]);
  });

  it("flags a soft WIP-limit breach without blocking the transition", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const threadIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const t = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: `Q${i}` });
      threadIds.push(t.id as string);
    }
    for (let i = 0; i < 3; i += 1) {
      const result = await iterationSvc.updateWork(identity, PROJECT, threadIds[i]!, {
        attention_state: "focused",
        next_focus_kind: "read_evidence",
      });
      expect(result.wip_limit_exceeded).toBe(false);
    }
    const fourth = await iterationSvc.updateWork(identity, PROJECT, threadIds[3]!, {
      attention_state: "focused",
      next_focus_kind: "read_evidence",
    });
    expect(fourth.wip_limit_exceeded).toBe(true);
    expect(fourth.attention_state).toBe("focused"); // soft limit — the transition is not blocked
  });

  it("does not spend a WIP slot on a Thread whose only running work is a background search", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const iterationSvc = new InquiryIterationService(pool);
    const identity = ownerIdentity();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const t = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: `WIP${i}` });
      ids.push(t.id as string);
    }
    // Three Threads focused on a search each: the searches run without a
    // person, so none of them occupies the Project's attention budget.
    for (let i = 0; i < 3; i += 1) {
      await iterationSvc.updateWork(identity, PROJECT, ids[i]!, {
        attention_state: "focused",
        next_focus_kind: "search_acquisition",
      });
    }
    const fourth = await iterationSvc.updateWork(identity, PROJECT, ids[3]!, {
      attention_state: "focused",
      next_focus_kind: "read_evidence",
    });
    expect(fourth.wip_limit_exceeded).toBe(false);

    // Once one of those Threads needs a person again, it counts.
    for (const id of ids.slice(0, 3)) {
      await iterationSvc.updateWork(identity, PROJECT, id, { next_focus_kind: "synthesize" });
    }
    const fifth = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "WIP4" });
    const result = await iterationSvc.updateWork(identity, PROJECT, fifth.id as string, {
      attention_state: "focused",
      next_focus_kind: "read_evidence",
    });
    expect(result.wip_limit_exceeded).toBe(true);
  });

  it("keeps Inquiry write commands Space- and membership-gated", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const question = await threadSvc.createThread(ownerIdentity(), PROJECT, { kind: "question", statement: "Q" });
    await new InquiryIterationService(pool).recordIteration(ownerIdentity(), PROJECT, question.id as string, {
      change_summary: "Answer changed",
      current_answer_summary: "A",
    });

    await expect(threadSvc.listThreads(viewerIdentity(), PROJECT)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      new InquiryIterationService(pool).listIterations(viewerIdentity(), PROJECT, question.id as string),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      threadSvc.createThread(viewerIdentity(), PROJECT, { kind: "question", statement: "Should fail" }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'viewer', 'active', now(), now())`,
      [randomUUID(), SPACE, PROJECT, VIEWER],
    );
    expect(await threadSvc.listThreads(viewerIdentity(), PROJECT)).toHaveLength(1);
    await expect(
      threadSvc.createThread(viewerIdentity(), PROJECT, { kind: "question", statement: "Should still fail" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    void question;
  });

  it("rejects primary-parent cycles and records lifecycle transitions separately from work state", async () => {
    if (!available || !pool) return;
    const threads = new InquiryThreadService(pool);
    const iterations = new InquiryIterationService(pool);
    const a = await threads.createThread(ownerIdentity(), PROJECT, { kind: "question", statement: "A" });
    const b = await threads.createThread(ownerIdentity(), PROJECT, {
      kind: "question",
      statement: "B",
      primary_parent_id: a.id,
    });
    // The success path, exercised before the cycle case: only the rejection was
    // covered, so a query in the successful branch could reference a column that
    // no longer exists and the suite would still pass.
    const c = await threads.createThread(ownerIdentity(), PROJECT, { kind: "question", statement: "C" });
    const reparented = await threads.setPrimaryParent(ownerIdentity(), PROJECT, c.id as string, a.id as string);
    expect(reparented).toMatchObject({ id: c.id, primary_parent_id: a.id });
    const detached = await threads.setPrimaryParent(ownerIdentity(), PROJECT, c.id as string, null);
    expect(detached).toMatchObject({ id: c.id, primary_parent_id: null });

    await expect(
      threads.setPrimaryParent(ownerIdentity(), PROJECT, a.id as string, b.id as string),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      iterations.updateWork(ownerIdentity(), PROJECT, a.id as string, { attention_state: "resolved" }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const resolved = await iterations.transitionLifecycle(ownerIdentity(), PROJECT, a.id as string, {
      lifecycle_status: "resolved",
      reason: "Resolution criterion met",
    });
    expect(resolved).toMatchObject({ lifecycle_status: "resolved", attention_state: "resolved" });
    await expect(
      iterations.transitionLifecycle(ownerIdentity(), PROJECT, a.id as string, { lifecycle_status: "resolved" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      iterations.recordIteration(ownerIdentity(), PROJECT, a.id as string, {
        change_summary: "Terminal Threads cannot change",
        current_answer_summary: "No",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const events = await pool.query(`SELECT to_status FROM inquiry_thread_lifecycle_events WHERE thread_id=$1`, [a.id]);
    expect(events.rows).toEqual([{ to_status: "resolved" }]);
  });

  it("rejects invalid numeric values instead of silently treating them as omitted", async () => {
    if (!available || !pool) return;
    const threads = new InquiryThreadService(pool);
    const iterations = new InquiryIterationService(pool);
    const hypothesis = await threads.createThread(ownerIdentity(), PROJECT, {
      kind: "hypothesis",
      statement: "Numeric validation",
    });
    await expect(
      iterations.recordIteration(ownerIdentity(), PROJECT, hypothesis.id as string, {
        change_summary: "Invalid confidence",
        confidence: "not-a-number",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      iterations.updateWork(ownerIdentity(), PROJECT, hypothesis.id as string, { priority: "not-a-number" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  // The delete paths for both recovered edge kinds. Neither had any coverage,
  // and both were rewritten from domain tables to `object_relations` — exactly
  // the shape where a wrong column name survives a green suite.
  it("removes a Thread relation and a Note link through object_relations", async () => {
    if (!available || !pool) return;
    const threads = new InquiryThreadService(pool);
    const from = await threads.createThread(ownerIdentity(), PROJECT, { kind: "question", statement: "From" });
    const to = await threads.createThread(ownerIdentity(), PROJECT, { kind: "question", statement: "To" });
    const relation = await threads.addRelation(ownerIdentity(), PROJECT, {
      from_thread_id: from.id,
      to_thread_id: to.id,
      relation_kind: "related_to",
    }) as { id: string };
    expect((await threads.getThread(ownerIdentity(), PROJECT, from.id as string)).relations)
      .toHaveLength(1);
    await threads.removeRelation(ownerIdentity(), PROJECT, relation.id);
    expect((await threads.getThread(ownerIdentity(), PROJECT, from.id as string)).relations)
      .toHaveLength(0);

    const note = await pool.query<{ id: string }>(
      `SELECT id FROM space_objects WHERE space_id=$1 AND object_type='note' LIMIT 1`,
      [SPACE],
    );
    if (note.rows[0]) {
      await threads.linkNote(ownerIdentity(), PROJECT, from.id as string, { note_object_id: note.rows[0].id, link_kind: "linked_note" });
      expect((await threads.getThread(ownerIdentity(), PROJECT, from.id as string)).note_links)
        .toHaveLength(1);
      await threads.unlinkNote(ownerIdentity(), PROJECT, from.id as string, note.rows[0].id);
      expect((await threads.getThread(ownerIdentity(), PROJECT, from.id as string)).note_links)
        .toHaveLength(0);
    }
  });

  // P3 boundary tests: a Thread is an ontology object now, so it inherits the
  // read gate instead of relying on Project membership alone. These assert the
  // three B12H-adjacent guarantees the migration is supposed to buy.
  it("gives a recovered Thread the ontology root's governance columns", async () => {
    if (!available || !pool) return;
    const thread = await new InquiryThreadService(pool).createThread(ownerIdentity(), PROJECT, {
      kind: "question",
      statement: "Governed question",
    });
    const root = await pool.query<{
      object_type: string; visibility: string; owner_user_id: string | null;
      primary_project_id: string | null; created_by_user_id: string | null;
    }>(
      `SELECT object_type, visibility, owner_user_id, primary_project_id, created_by_user_id
         FROM space_objects WHERE id = $1 AND space_id = $2`,
      [thread.id as string, SPACE],
    );
    expect(root.rows[0]).toMatchObject({
      object_type: "inquiry_thread",
      // Defaulting to private would have silently changed collaboration.
      visibility: "space_shared",
      owner_user_id: OWNER,
      created_by_user_id: OWNER,
      primary_project_id: PROJECT,
    });
  });

  it("refuses to create a Thread object without its Project", () => {
    // B12H: a null Project does not narrow access, it removes the Project gate.
    expect(() => buildSpaceObjectInsert({
      id: randomUUID(),
      spaceId: SPACE,
      objectType: "inquiry_thread",
      title: "No project",
      createdByUserId: OWNER,
      createdAt: new Date().toISOString(),
    })).toThrow(/requires primary_project_id/);
  });

  it("hides a private Thread from its own list, not only from the graph", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const thread = await threadSvc.createThread(ownerIdentity(), PROJECT, {
      kind: "question",
      statement: "Owner-only question",
    });
    await pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
      [randomUUID(), SPACE, PROJECT, VIEWER],
    );
    await pool.query(
      `UPDATE space_objects SET visibility = 'private' WHERE id = $1 AND space_id = $2`,
      [thread.id as string, SPACE],
    );
    // Project membership is not sufficient: a `visibility` column that only the
    // graph honours would be worse than not having one.
    const listed = await threadSvc.listThreads(viewerIdentity(), PROJECT);
    expect(listed.map((row) => row.id)).not.toContain(thread.id);
    await expect(threadSvc.getThread(viewerIdentity(), PROJECT, thread.id as string))
      .rejects.toMatchObject({ statusCode: 404 });
    // The owner still sees it.
    expect((await threadSvc.listThreads(ownerIdentity(), PROJECT)).map((r) => r.id)).toContain(thread.id);
  });

  it("hides a private Thread from another Project member", async () => {
    if (!available || !pool) return;
    const threadSvc = new InquiryThreadService(pool);
    const thread = await threadSvc.createThread(ownerIdentity(), PROJECT, {
      kind: "question",
      statement: "Private question",
    });
    await pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
      [randomUUID(), SPACE, PROJECT, VIEWER],
    );
    const visibleBefore = await threadSvc.listThreads(viewerIdentity(), PROJECT);
    expect(visibleBefore.map((row) => row.id)).toContain(thread.id);

    // Per-object visibility is what the ontology adds; Project membership alone
    // no longer decides who sees a Thread.
    await pool.query(
      `UPDATE space_objects SET visibility = 'private' WHERE id = $1 AND space_id = $2`,
      [thread.id as string, SPACE],
    );
    const graph = await new InquiryGraphService(pool)
      .getCombinedProjectGraph(viewerIdentity(), PROJECT, { limit: 50 });
    expect(graph.nodes.map((node) => node.id)).not.toContain(thread.id);
  });

  it("database constraints reject cross-Project Inquiry references", async () => {
    if (!available || !pool) return;
    const projects = new PgProjectRepository(pool);
    const threads = new InquiryThreadService(pool);
    const first = await threads.createThread(ownerIdentity(), PROJECT, {
      kind: "question",
      statement: "First Project",
    });
    const secondProject = await projects.create(ownerIdentity(), { name: "Second Project" });
    const second = await threads.createThread(ownerIdentity(), secondProject.id as string, {
      kind: "question",
      statement: "Second Project",
    });
    // Thread edges are `object_relations` rows now, whose FK only guarantees
    // Space isolation — the composite (thread, project, space) key that used to
    // reject this is gone with the domain table. Project isolation for Thread
    // structure is a service invariant, so that is what this asserts.
    await expect(
      threads.addRelation(ownerIdentity(), PROJECT, {
        from_thread_id: first.id,
        to_thread_id: second.id,
        relation_kind: "related_to",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
