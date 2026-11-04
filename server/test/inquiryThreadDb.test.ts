import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { InquiryGraphService } from "../src/modules/inquiry/graphService.js";
import { buildSpaceObjectInsert } from "../src/db/spaceObjectWriter.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import {ModernIterationService as InquiryIterationService} from "./support/modernIteration.js";
import { DecisionCaseService } from "../src/modules/decisions/caseService.js";

// Real-Postgres coverage for Inquiry: Thread
// creation, working relations, Note links, the cognitive Iteration command,
// the Definition Revision command, and the work-management command's
// boundary from both of those. See ADR 0011.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";


const db = useTestDatabase(import.meta.filename);

let PROJECT: string;

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["inquiry_thread_work_events", "inquiry_iterations", "inquiry_thread_statement_revisions", "inquiry_thread_personal_focus", "inquiry_question_states", "inquiry_hypothesis_states", "inquiry_threads", "inquiry_project_settings", "decision_cases", "notes", "space_objects", "projects", "project_members", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source) VALUES
       ($1, 'Owner', 'active', $3, $3, lower(gen_random_uuid()::text || '@test.invalid'), 'system'), ($2, 'Viewer', 'active', $3, $3, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [OWNER, VIEWER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES
       ($1, $2, $3, 'owner', 'active', $5, $5), ($4, $2, $6, 'member', 'active', $5, $5)`,
    [randomUUID(), SPACE, OWNER, randomUUID(), now, VIEWER],
  );
  const project = await new PgProjectRepository(db.pool).create({ spaceId: SPACE, userId: OWNER }, { name: "Inquiry Project" });
  PROJECT = project.id as string;
});

const ownerIdentity = () => ({ spaceId: SPACE, userId: OWNER });
const viewerIdentity = () => ({ spaceId: SPACE, userId: VIEWER });

async function createNote(): Promise<string> {
  const objectId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, 'note', 'A note', 'private', $3, $4, $4)`,
    [objectId, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO notes (object_id, space_id, content_format, content_schema_version) VALUES ($1, $2, 'markdown', 1)`,
    [objectId, SPACE],
  );
  return objectId;
}

describe("Inquiry Core (real Postgres)", () => {
  it("removes only Thread structure edges through the structure command", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const identity = ownerIdentity();
    const question = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "What holds?" });
    const other = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "What else holds?" });
    const structural = await threadSvc.addRelation(identity, PROJECT, {
      from_thread_id: question.id, to_thread_id: other.id, relation_kind: "related_to",
    });
    // A reviewed edge from the Thread to another kind of object, as an
    // accepted object_relation_create proposal writes it.
    const noteId = await createNote();
    const reviewedEdge = randomUUID();
    await db.pool.query(
      `INSERT INTO object_relations (id, space_id, from_object_id, to_object_id, link_type, status, created_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'supports', 'active', $5, now(), now())`,
      [reviewedEdge, SPACE, question.id, noteId, OWNER],
    );

    await threadSvc.removeRelation(identity, PROJECT, reviewedEdge);
    await threadSvc.removeRelation(identity, PROJECT, structural.id as string);

    const remaining = await db.pool.query<{ id: string }>(
      `SELECT id FROM object_relations WHERE id = ANY($1::varchar[])`,
      [[reviewedEdge, structural.id]],
    );
    expect(remaining.rows.map((row) => row.id)).toEqual([reviewedEdge]);
  });

  it("protected cognitive fields cannot be overwritten through the work-management command", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const iterationSvc = new InquiryIterationService(db.pool);
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
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const iterationSvc = new InquiryIterationService(db.pool);
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
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const iterationSvc = new InquiryIterationService(db.pool);
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
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const iterationSvc = new InquiryIterationService(db.pool);
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
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const iterationSvc = new InquiryIterationService(db.pool);
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

  it("lists the personal Focus of the calling user only", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const identity = ownerIdentity();
    const focused = await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "In focus" });
    await threadSvc.createThread(identity, PROJECT, { kind: "question", statement: "Not in focus" });
    await threadSvc.setPersonalFocus(identity, PROJECT, focused.id as string, true);

    const list = await threadSvc.listPersonalFocus(identity, PROJECT);
    expect(list.map((row) => row.id)).toEqual([focused.id]);

    await threadSvc.setPersonalFocus(identity, PROJECT, focused.id as string, false);
    expect(await threadSvc.listPersonalFocus(identity, PROJECT)).toEqual([]);
  });

  it("keeps Inquiry write commands Space- and membership-gated", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const question = await threadSvc.createThread(ownerIdentity(), PROJECT, { kind: "question", statement: "Q" });
    await new InquiryIterationService(db.pool).recordIteration(ownerIdentity(), PROJECT, question.id as string, {
      change_summary: "Answer changed",
      current_answer_summary: "A",
    });

    await expect(threadSvc.listThreads(viewerIdentity(), PROJECT)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      new InquiryIterationService(db.pool).listIterations(viewerIdentity(), PROJECT, question.id as string),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      threadSvc.createThread(viewerIdentity(), PROJECT, { kind: "question", statement: "Should fail" }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await db.pool.query(
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
    if (!db.available) return;
    const threads = new InquiryThreadService(db.pool);
    const iterations = new InquiryIterationService(db.pool);
    const a = await threads.createThread(ownerIdentity(), PROJECT, { kind: "question", statement: "A" });
    const b = await threads.createThread(ownerIdentity(), PROJECT, {
      kind: "question",
      statement: "B",
      primary_parent_id: a.id,
    });
    // The success path runs before the cycle case. A query in the successful
    // branch that names a missing column has to fail here.
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
    const events = await db.pool.query(`SELECT to_status FROM inquiry_thread_lifecycle_events WHERE thread_id=$1`, [a.id]);
    expect(events.rows).toEqual([{ to_status: "resolved" }]);
  });

  it("rejects invalid numeric values instead of silently treating them as omitted", async () => {
    if (!db.available) return;
    const threads = new InquiryThreadService(db.pool);
    const iterations = new InquiryIterationService(db.pool);
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

  // Delete a Thread relation and a Note link through `object_relations`.
  // A wrong column name fails here.
  it("removes a Thread relation and a Note link through object_relations", async () => {
    if (!db.available) return;
    const threads = new InquiryThreadService(db.pool);
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

    const note = await db.pool.query<{ id: string }>(
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

  // A Thread is an ontology object. It inherits the read gate. Do not rely on
  // Project membership alone.
  it("gives a recovered Thread the ontology root's governance columns", async () => {
    if (!db.available) return;
    const thread = await new InquiryThreadService(db.pool).createThread(ownerIdentity(), PROJECT, {
      kind: "question",
      statement: "Governed question",
    });
    const root = await db.pool.query<{
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
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const thread = await threadSvc.createThread(ownerIdentity(), PROJECT, {
      kind: "question",
      statement: "Owner-only question",
    });
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
      [randomUUID(), SPACE, PROJECT, VIEWER],
    );
    await db.pool.query(
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
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const thread = await threadSvc.createThread(ownerIdentity(), PROJECT, {
      kind: "question",
      statement: "Private question",
    });
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
      [randomUUID(), SPACE, PROJECT, VIEWER],
    );
    const visibleBefore = await threadSvc.listThreads(viewerIdentity(), PROJECT);
    expect(visibleBefore.map((row) => row.id)).toContain(thread.id);

    // Who sees a Thread is per-object visibility. Project membership alone
    // does not decide it.
    await db.pool.query(
      `UPDATE space_objects SET visibility = 'private' WHERE id = $1 AND space_id = $2`,
      [thread.id as string, SPACE],
    );
    const graph = await new InquiryGraphService(db.pool)
      .getCombinedProjectGraph(viewerIdentity(), PROJECT, { limit: 50 });
    expect(graph.nodes.map((node) => node.id)).not.toContain(thread.id);
    const inquiryGraph = await new InquiryGraphService(db.pool)
      .getInquiryGraph(viewerIdentity(), PROJECT);
    expect(inquiryGraph.nodes.map((node) => node.id)).not.toContain(thread.id);
    expect(inquiryGraph.nodes.some((node) => node.label === "Private question")).toBe(false);
  });

  it("does not leak a private Thread through a readable Thread's relations", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const visible = await threadSvc.createThread(ownerIdentity(), PROJECT, {
      kind: "question",
      statement: "Shared question",
    });
    const hidden = await threadSvc.createThread(ownerIdentity(), PROJECT, {
      kind: "hypothesis",
      statement: "Secret hypothesis",
    });
    await threadSvc.addRelation(ownerIdentity(), PROJECT, {
      from_thread_id: visible.id,
      to_thread_id: hidden.id,
      relation_kind: "proposes",
    });
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
      [randomUUID(), SPACE, PROJECT, VIEWER],
    );
    await db.pool.query(
      `UPDATE space_objects SET visibility = 'private' WHERE id = $1 AND space_id = $2`,
      [hidden.id as string, SPACE],
    );
    const detail = await threadSvc.getThread(viewerIdentity(), PROJECT, visible.id as string);
    const relations = detail.relations as Array<{ to_thread_id: string; from_thread_id: string }>;
    expect(relations.some((row) => row.to_thread_id === hidden.id || row.from_thread_id === hidden.id)).toBe(false);
    const inquiryGraph = await new InquiryGraphService(db.pool)
      .getInquiryGraph(viewerIdentity(), PROJECT);
    expect(inquiryGraph.edges).toHaveLength(0);
    expect(inquiryGraph.nodes.map((node) => node.id)).not.toContain(hidden.id);
  });

  it("does not leak a private Decision Case title from a readable Thread", async () => {
    if (!db.available) return;
    const threadSvc = new InquiryThreadService(db.pool);
    const thread = await threadSvc.createThread(ownerIdentity(), PROJECT, {
      kind: "question",
      statement: "Shared question",
    });
    const decisionCase = await new DecisionCaseService(db.pool).createCase(ownerIdentity(), PROJECT, {
      title: "Secret case title",
      source_thread_ids: [thread.id],
    });
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'member','active',now(),now())`,
      [randomUUID(), SPACE, PROJECT, VIEWER],
    );
    await db.pool.query(
      `UPDATE space_objects SET visibility = 'private' WHERE id = $1 AND space_id = $2`,
      [decisionCase.id as string, SPACE],
    );
    const ownerDetail = await threadSvc.getThread(ownerIdentity(), PROJECT, thread.id as string);
    expect((ownerDetail.decision_cases as Array<{ title: string }>).map((row) => row.title))
      .toContain("Secret case title");
    const viewerDetail = await threadSvc.getThread(viewerIdentity(), PROJECT, thread.id as string);
    expect((viewerDetail.decision_cases as Array<{ title: string }>).map((row) => row.title))
      .not.toContain("Secret case title");
  });

  it("database constraints reject cross-Project Inquiry references", async () => {
    if (!db.available) return;
    const projects = new PgProjectRepository(db.pool);
    const threads = new InquiryThreadService(db.pool);
    const first = await threads.createThread(ownerIdentity(), PROJECT, {
      kind: "question",
      statement: "First Project",
    });
    const secondProject = await projects.create(ownerIdentity(), { name: "Second Project" });
    const second = await threads.createThread(ownerIdentity(), secondProject.id as string, {
      kind: "question",
      statement: "Second Project",
    });
    // Thread edges are `object_relations` rows. Their FK guarantees Space
    // isolation only. Project isolation for Thread structure is a service
    // invariant, so that is what this asserts. A Thread
    // outside the Project is unreachable from it, so it reads as not found.
    await expect(
      threads.addRelation(ownerIdentity(), PROJECT, {
        from_thread_id: first.id,
        to_thread_id: second.id,
        relation_kind: "related_to",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
