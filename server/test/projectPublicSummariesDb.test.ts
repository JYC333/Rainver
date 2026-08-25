import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import { PgProjectRepository } from "../src/modules/projects/repository";
import { RetrievalSearchService, type QueryEmbedder } from "../src/modules/retrieval";
import { projectRetrievalRegistry } from "../src/modules/projects/retrievalAdapter";
import {
  RetrievalEmbeddingBackfillService,
  type RetrievalEmbedder,
} from "../src/modules/retrieval/embedding/service";
import { EMBED_DIMENSIONS } from "../src/modules/retrieval/embedding/config";

function oneHot(slot: number): number[] {
  const v = new Array<number>(EMBED_DIMENSIONS).fill(0);
  v[slot] = 1;
  return v;
}
const slotEmbedder: RetrievalEmbedder = {
  async embed(_spaceId, texts) {
    return { model: "marker", vectors: texts.map(() => oneHot(0)) };
  },
};
const slotQueryEmbedder: QueryEmbedder = { async embedQuery() { return oneHot(0); } };

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WRITER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const READER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PROJECT = "55555555-5555-4555-8555-555555555555";


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["retrieval_edges", "retrieval_chunks", "retrieval_aliases", "retrieval_objects", "project_public_summaries", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Team', 'household', now(), now())`,
    [SPACE],
  );
  for (const id of [OWNER, WRITER, VIEWER, READER]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'U', 'active', now(), now())`,
      [id],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
      [`sm-${id}`.slice(0, 36), SPACE, id],
    );
  }
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, description, status, current_focus, created_at, updated_at)
     VALUES ($1, $2, $3, 'Aster', 'Public description only', 'active', 'Cross-project discovery', now(), now())`,
    [PROJECT, SPACE, OWNER],
  );
  for (const [userId, role] of [[WRITER, "member"], [VIEWER, "viewer"]] as const) {
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', now(), now())`,
      [`pm-${userId}`.slice(0, 36), SPACE, PROJECT, userId, role],
    );
  }
});

function repo(): PgProjectRepository {
  return new PgProjectRepository(db.pool);
}

describe("Project public summaries (real Postgres)", () => {
  it("stages member drafts, gates publish to the owner, and rejects viewers", async () => {
    if (!db.available) return;

    // A project member (writer) can only stage a draft.
    const draft = await repo().upsertPublicSummary(
      { spaceId: SPACE, userId: WRITER },
      PROJECT,
      {
        summary_text: "Redacted high-level brief for cross-project idea discovery.",
        topics: ["Cross Project Discovery", "Project ACL"],
        highlights: ["No project memory content is indexed here."],
        source_refs: [{ source_type: "project", source_id: PROJECT, label: "Public project brief" }],
      },
    );
    expect(draft).toMatchObject({
      project_id: PROJECT,
      project_name: "Aster",
      topics: ["Cross Project Discovery", "Project ACL"],
      review_status: "draft",
    });

    // The member cannot self-approve their own summary.
    await expect(
      repo().upsertPublicSummary(
        { spaceId: SPACE, userId: WRITER },
        PROJECT,
        { summary_text: "Member tries to publish.", review_status: "approved" },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    // The project owner reviews and publishes.
    const published = await repo().upsertPublicSummary(
      { spaceId: SPACE, userId: OWNER },
      PROJECT,
      {
        summary_text: "Redacted high-level brief for cross-project idea discovery.",
        topics: ["Cross Project Discovery", "Project ACL"],
        review_status: "approved",
      },
    );
    expect(published).toMatchObject({ review_status: "approved" });

    // A viewer can never mutate the summary.
    await expect(
      repo().upsertPublicSummary(
        { spaceId: SPACE, userId: VIEWER },
        PROJECT,
        { summary_text: "Viewer should not update this." },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("keeps approved summaries space-public and searchable through project retrieval", async () => {
    if (!db.available) return;

    await repo().upsertPublicSummary(
      { spaceId: SPACE, userId: OWNER },
      PROJECT,
      {
        summary_text: "Redacted high-level brief for cross-project idea discovery.",
        topics: ["Cross Project Discovery"],
        review_status: "approved",
      },
    );

    const list = await repo().listPublicSummaries(
      { spaceId: SPACE, userId: READER },
      { limit: 10, offset: 0 },
    );
    expect(list).toMatchObject({
      total: 1,
      items: [{ project_id: PROJECT, summary_text: "Redacted high-level brief for cross-project idea discovery." }],
    });

    const search = await new RetrievalSearchService(db.pool, projectRetrievalRegistry).search({
      spaceId: SPACE,
      viewerUserId: READER,
      objectTypes: ["project_public_summary"],
      query: "Cross Project Discovery",
      maxResults: 5,
    });

    expect(search.items[0]).toMatchObject({
      object_type: "project_public_summary",
      object_id: PROJECT,
      title: "Aster",
    });
  });

  it("recalls an approved summary through the vector arm in hybrid mode", async () => {
    if (!db.available) return;

    await repo().upsertPublicSummary(
      { spaceId: SPACE, userId: OWNER },
      PROJECT,
      {
        summary_text: "Redacted high-level brief for cross-project idea discovery.",
        topics: ["Cross Project Discovery"],
        review_status: "approved",
      },
    );
    // The upsert recreates the chunk with embedding=NULL; embed it for the vector arm.
    await new RetrievalEmbeddingBackfillService(db.pool, slotEmbedder).backfillSpace(SPACE);

    // A query with no lexical/topic overlap — only the vector arm can recall it.
    const search = await new RetrievalSearchService(db.pool, projectRetrievalRegistry, {
      queryEmbedder: slotQueryEmbedder,
    }).search({
      spaceId: SPACE,
      viewerUserId: READER,
      objectTypes: ["project_public_summary"],
      query: "zzz qqq no lexical overlap",
      maxResults: 5,
      mode: "hybrid",
      includeTrace: true,
    });

    const trace = search.trace as unknown as { arms: Record<string, number> };
    expect(trace.arms.vector).toBeGreaterThan(0);
    expect(search.items.map((i) => i.object_id)).toContain(PROJECT);
  });
});
