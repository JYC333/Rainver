import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { GraphProjectionRepository } from "../src/modules/graph/projectionRepository.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { ProjectResearchRepository } from "../src/modules/projectResearch/repository.js";
import {
  createResearchWorkflow,
  setResearchWorkflowThread,
} from "../src/modules/projectResearch/workflowOntology.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { withQueryableTransaction } from "../src/modules/routeUtils/common.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SPACE_ONLY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let projectId = "";
let workflowId = "";
let threadId = "";

const db = useTestDatabase(import.meta.filename, { max: 4 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO spaces (id,name,type,created_at,updated_at)
     VALUES ($1,'Workflow ontology','household',$2,$2)`,
    [SPACE, now],
  );
  await db.pool.query(
    `INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES
       ($1,'Owner','active',$4,$4),
       ($2,'Project member','active',$4,$4),
       ($3,'Space only','active',$4,$4)`,
    [OWNER, PROJECT_MEMBER, SPACE_ONLY, now],
  );
  for (const [userId, role] of [[OWNER, "owner"], [PROJECT_MEMBER, "member"], [SPACE_ONLY, "member"]]) {
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5)`,
      [randomUUID(), SPACE, userId, role, now],
    );
  }
  const project = await new PgProjectRepository(db.pool).create(
    { spaceId: SPACE, userId: OWNER },
    { name: "Research Project" },
  );
  projectId = String(project.id);
  await db.pool.query(
    `INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'member','active',$5,$5)`,
    [randomUUID(), SPACE, projectId, PROJECT_MEMBER, now],
  );
  const thread = await new InquiryThreadService(db.pool).createThread(
    { spaceId: SPACE, userId: OWNER },
    projectId,
    { kind: "question", statement: "Which approach has the strongest evidence?" },
  );
  threadId = String(thread.id);
  workflowId = randomUUID();
  await withQueryableTransaction(db.pool, (db) => createResearchWorkflow(db, {
    id: workflowId,
    spaceId: SPACE,
    projectId,
    title: "Compare the evidence",
    status: "active",
    state: { research_question: "Which approach has the strongest evidence?" },
    startedByUserId: OWNER,
    primaryThreadId: threadId,
    now,
  }));
});

describe("Research Workflow ontology boundary (real Postgres)", () => {
  it("stores identity and scope on a space-object root and derives the pinned Thread from about", async () => {
    if (!db.available) return;
    const stored = await db.pool.query<{
      object_id: string;
      object_type: string;
      title: string;
      primary_project_id: string;
      relation_role: string;
    }>(
      `SELECT workflow.object_id, object.object_type, object.title, object.primary_project_id,
              relation.metadata_json->>'relation_role' AS relation_role
         FROM project_research_workflows workflow
         JOIN space_objects object ON object.id=workflow.object_id AND object.space_id=workflow.space_id
         JOIN object_relations relation ON relation.from_object_id=workflow.object_id
           AND relation.space_id=workflow.space_id AND relation.link_type='about' AND relation.status='active'
        WHERE workflow.object_id=$1`,
      [workflowId],
    );
    expect(stored.rows[0]).toMatchObject({
      object_id: workflowId,
      object_type: "research_workflow",
      title: "Compare the evidence",
      primary_project_id: projectId,
      relation_role: "primary_inquiry_thread",
    });

    const rows = await new ProjectResearchRepository(db.pool).listWorkflows(
      { spaceId: SPACE, userId: OWNER },
      projectId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: workflowId, primary_thread_id: threadId });
  });

  it("does not expose a Project Workflow to a Space member outside the Project", async () => {
    if (!db.available) return;
    await expect(new ProjectResearchRepository(db.pool).listWorkflows(
      { spaceId: SPACE, userId: SPACE_ONLY },
      projectId,
    )).rejects.toMatchObject({ statusCode: 404 });

    const visible = await new GraphProjectionRepository(db.pool).getVisibleObject(
      { spaceId: SPACE, userId: SPACE_ONLY },
      workflowId,
    );
    expect(visible).toBeNull();
  });

  it("filters the derived pin and graph edge when the viewer cannot read the Thread endpoint", async () => {
    if (!db.available) return;
    await db.pool.query(
      `UPDATE space_objects SET visibility='private',owner_user_id=$2 WHERE space_id=$1 AND id=$3`,
      [SPACE, OWNER, threadId],
    );

    const rows = await new ProjectResearchRepository(db.pool).listWorkflows(
      { spaceId: SPACE, userId: PROJECT_MEMBER },
      projectId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: workflowId, primary_thread_id: null });

    const edges = await new GraphProjectionRepository(db.pool).listEdgesForNodeIds(
      { spaceId: SPACE, userId: PROJECT_MEMBER },
      [workflowId, threadId],
      { edgeKinds: ["about"], limit: 10 },
    );
    expect(edges).toEqual([]);
  });

  it("enforces one non-archived Workflow pin per Thread", async () => {
    if (!db.available) return;
    const secondWorkflowId = randomUUID();
    const now = new Date().toISOString();
    await withQueryableTransaction(db.pool, (db) => createResearchWorkflow(db, {
      id: secondWorkflowId,
      spaceId: SPACE,
      projectId,
      title: "Second workflow",
      status: "active",
      state: {},
      startedByUserId: OWNER,
      now,
    }));
    await expect(withQueryableTransaction(db.pool, (db) => setResearchWorkflowThread(db, {
      spaceId: SPACE,
      projectId,
      workflowId: secondWorkflowId,
      threadId,
      userId: OWNER,
      now,
    }))).rejects.toMatchObject({ statusCode: 409 });
  });
});
