import { beforeEach, describe, expect, it } from "vitest";
import { CaptureFilingService } from "../src/modules/captureFiling/service";
import { ContentAccessAuditService } from "../src/modules/contentAccess/audit";
import { PgActivityRepository } from "../src/modules/activity/repository";
import { PgAnnotationRepository } from "../src/modules/reader/repository";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STRANGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const CAPTURE = "44444444-4444-4444-8444-444444444444";


const db = useTestDatabase(__filename, { max: 4 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["content_access_logs", "activity_records", "notes", "space_objects", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Owner', 'active', now(), now()),
            ($2, 'Stranger', 'active', now(), now())`,
    [OWNER, STRANGER],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Personal', 'personal', $3, now(), now()),
            ($2, 'Team', 'team', $3, now(), now())`,
    [PERSONAL, TEAM, OWNER],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ('m-personal', $1, $3, 'owner', 'active', now(), now()),
            ('m-team-owner', $2, $3, 'member', 'active', now(), now()),
            ('m-team-stranger', $2, $4, 'member', 'active', now(), now())`,
    [PERSONAL, TEAM, OWNER, STRANGER],
  );
  await db.pool.query(
    `INSERT INTO projects (id, space_id, name, status, owner_user_id, created_at, updated_at)
     VALUES ($1, $2, 'Team Project', 'active', $3, now(), now())`,
    [PROJECT, TEAM, OWNER],
  );
  await db.pool.query(
    `INSERT INTO activity_records
       (id, space_id, user_id, owner_user_id, activity_type, title, content,
        payload_json, status, visibility, occurred_at, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'note', 'Captured thought', 'The body of the thought.',
             '{}'::jsonb, 'raw', 'private', now(), now(), now())`,
    [CAPTURE, PERSONAL, OWNER],
  );
});

function filing(): CaptureFilingService {
  return new CaptureFilingService(db.pool);
}

describe("filing a personal capture into a Project (real Postgres)", () => {
  it("creates a new object in the target Space and leaves the capture as provenance", async () => {
    if (!db.available) return;
    const result = await filing().file({
      userId: OWNER,
      activityId: CAPTURE,
      targetProjectId: PROJECT,
    });

    expect(result.target_space_id).toBe(TEAM);
    expect(result.visibility).toBe("space_shared");

    const object = await db.pool.query(
      `SELECT space_id, primary_project_id, visibility FROM space_objects WHERE id = $1`,
      [result.object_id],
    );
    expect(object.rows[0]).toMatchObject({
      space_id: TEAM,
      primary_project_id: PROJECT,
      visibility: "space_shared",
    });

    // The capture is not copied or moved: it stays in the personal Space and
    // records where it went.
    const capture = await db.pool.query(
      `SELECT space_id, status, payload_json FROM activity_records WHERE id = $1`,
      [CAPTURE],
    );
    expect(capture.rows[0].space_id).toBe(PERSONAL);
    expect(capture.rows[0].status).toBe("processed");
    expect(capture.rows[0].payload_json.filed_into).toMatchObject({
      space_id: TEAM,
      project_id: PROJECT,
      object_id: result.object_id,
    });
  });

  it("refuses to file someone else's capture", async () => {
    if (!db.available) return;
    await expect(filing().file({
      userId: STRANGER,
      activityId: CAPTURE,
      targetProjectId: PROJECT,
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses a target Project the caller cannot write", async () => {
    if (!db.available) return;
    await db.pool.query(`DELETE FROM space_memberships WHERE space_id = $1 AND user_id = $2`, [TEAM, OWNER]);
    await expect(filing().file({
      userId: OWNER,
      activityId: CAPTURE,
      targetProjectId: PROJECT,
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses to file the same capture twice", async () => {
    if (!db.available) return;
    await filing().file({ userId: OWNER, activityId: CAPTURE, targetProjectId: PROJECT });
    await expect(filing().file({
      userId: OWNER,
      activityId: CAPTURE,
      targetProjectId: PROJECT,
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("cross-person detail reads are audited (real Postgres)", () => {
  it("records a stranger's activity read but not the owner's own", async () => {
    if (!db.available) return;
    await db.pool.query(
      `UPDATE activity_records SET visibility = 'space_shared', space_id = $2 WHERE id = $1`,
      [CAPTURE, TEAM],
    );
    const repository = new PgActivityRepository(db.pool);

    await repository.get({ spaceId: TEAM, userId: OWNER }, CAPTURE);
    const own = await db.pool.query(`SELECT count(*)::int AS n FROM content_access_logs`);
    expect(own.rows[0].n).toBe(0);

    await repository.get({ spaceId: TEAM, userId: STRANGER }, CAPTURE);
    const logs = await new ContentAccessAuditService(db.pool).listForOwner({
      spaceId: TEAM,
      resourceType: "activity",
      resourceId: CAPTURE,
      ownerUserId: OWNER,
      limit: 10,
      offset: 0,
    });
    expect(logs.items).toHaveLength(1);
    expect(logs.items[0]).toMatchObject({ viewer_user_id: STRANGER, access_type: "detail_read" });
  });
});

describe("annotations on a shared document stay personal (real Postgres)", () => {
  async function sharedNotebookId(): Promise<string> {
    const filed = await filing().file({
      userId: OWNER,
      activityId: CAPTURE,
      targetProjectId: PROJECT,
    });
    return filed.object_id;
  }

  function annotate(body: Record<string, unknown>) {
    return new PgAnnotationRepository(db.pool).createAnnotation(
      { spaceId: TEAM, userId: OWNER },
      {
        annotation_type: "comment",
        document_type: "research_notebook",
        quote_text: "the thought",
        anchor_json: {
          schema_version: 1,
          quote_text: "the thought",
          text_range: { start: 0, end: 11, unit: "utf16" },
          before_context: "",
          after_context: "",
        },
        ...body,
      },
    );
  }

  it("defaults a margin note to private even though the document is space_shared", async () => {
    if (!db.available) return;
    const documentId = await sharedNotebookId();

    const annotation = await annotate({ document_id: documentId, label: "I do not buy this" });

    expect(annotation.visibility).toBe("private");
    const stranger = await db.pool.query(
      `SELECT id FROM reader_annotations WHERE id = $1 AND ${"owner_user_id = $2"}`,
      [annotation.id, STRANGER],
    );
    expect(stranger.rows).toHaveLength(0);
  });

  it("lets the author opt in to sharing it", async () => {
    if (!db.available) return;
    const documentId = await sharedNotebookId();

    const annotation = await annotate({ document_id: documentId, visibility: "space_shared" });

    expect(annotation.visibility).toBe("space_shared");
  });

  it("refuses to make an annotation wider than the document it sits on", async () => {
    if (!db.available) return;
    const documentId = await sharedNotebookId();
    await db.pool.query(`UPDATE space_objects SET visibility = 'private' WHERE id = $1`, [documentId]);

    await expect(annotate({ document_id: documentId, visibility: "space_shared" }))
      .rejects.toMatchObject({ statusCode: 422 });
  });
});
