import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests, __setAuthRepositoryForTests, type AuthRepository } from "../src/modules/auth/identity.js";
import { projectsModule } from "../src/modules/projects/index.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { projectRetrievalRegistry } from "../src/modules/projects/retrievalAdapter.js";
import { EMBED_DIMENSIONS } from "../src/modules/retrieval/embedding/config.js";
import { type RetrievalEmbedder, RetrievalEmbeddingBackfillService } from "../src/modules/retrieval/embedding/service.js";
import { normalizeAlias } from "../src/modules/retrieval/normalize.js";
import { type QueryEmbedder } from "../src/modules/retrieval/types.js";
import { RetrievalSearchService } from "../src/modules/retrieval/searchService.js";
import type { Queryable } from "../src/modules/routeUtils/common.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("projectPublicSummariesDb", () => {
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


  const db = useTestDatabase(`${import.meta.filename}#projectPublicSummariesDb`);

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
});

describe("projectPublicSummaryRelational", () => {
  const SPACE = "11111111-1111-4111-8111-111111111111";
  const VIEWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROJECT = "22222222-2222-4222-8222-222222222222";

  class ProjectRelationalFakeDb implements Queryable {
    async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      const norm = sql.replace(/\s+/g, " ").trim();
      if (norm.includes("FROM retrieval_aliases ra")) {
        const [spaceId, objectTypes, aliases] = params as [string, string[], string[]];
        const matches = spaceId === SPACE &&
          objectTypes.includes("project_public_summary") &&
          aliases.includes(normalizeAlias("Cross Project Discovery"));
        return result((matches ? [{
          object_type: "project_public_summary",
          object_id: PROJECT,
          title: "Aster",
          snippet: "Redacted project summary for cross-project discovery.",
          matched_text: "Cross Project Discovery",
          matched_field: "alias",
          updated_at: "2026-06-22T00:00:00.000Z",
          rank: 1,
        }] : []) as Row[]);
      }
      if (norm.includes("FROM retrieval_chunks rc")) {
        const [spaceId, objectTypes, like] = params as [string, string[], string];
        const needle = like.replace(/%/g, "").toLowerCase();
        const text = "Redacted project summary for cross-project discovery.";
        const matches = spaceId === SPACE &&
          objectTypes.includes("project_public_summary") &&
          text.toLowerCase().includes(needle);
        return result((matches ? [{
          object_type: "project_public_summary",
          object_id: PROJECT,
          title: "Aster",
          snippet: text,
          matched_text: text,
          matched_field: "plain_text",
          updated_at: "2026-06-22T00:00:00.000Z",
          rank: 1,
        }] : []) as Row[]);
      }
      if (norm.includes("FROM retrieval_edges e")) {
        return result([] as Row[]);
      }
      if (norm.includes("FROM project_public_summaries ps")) {
        return result([{
          project_id: PROJECT,
          name: "Aster",
          description: "Public project description",
          current_focus: "Cross-project discovery",
          owner_user_id: VIEWER,
          status: "active",
          summary_text: "Redacted project summary for cross-project discovery.",
          topics_json: ["Cross Project Discovery"],
          highlights_json: ["Approved public summary only."],
          review_status: "approved",
        }] as Row[]);
      }
      throw new Error(`unexpected SQL: ${norm}`);
    }
  }

  describe("Project public-summary relational retrieval", () => {
    it("uses projects-related intent as a direct target arm when the registry has no non-project seed type", async () => {
      const out = await new RetrievalSearchService(new ProjectRelationalFakeDb(), projectRetrievalRegistry).search({
        spaceId: SPACE,
        viewerUserId: VIEWER,
        objectTypes: ["project_public_summary"],
        query: "projects related to Cross Project Discovery",
        maxResults: 5,
        includeTrace: true,
      });

      expect(out.items.map((item) => item.object_id)).toContain(PROJECT);
      expect(out.items[0]?.matched_fields).toContain("relational:projects_related");
      expect(out.items[0]?.matched_fields).toContain("relational_direct_target");
      expect(out.trace).toMatchObject({
        arms: { relational: 1 },
        relational: { intent: "projects_related", results: 1, hops: 0 },
      });
    });
  });

  function result<Row>(rows: Row[]) {
    return { rows, rowCount: rows.length };
  }
});

describe("projectPublicSummaryRoutes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    __setAuthIdentityForTests(null);
    __setAuthRepositoryForTests(null);
    await app?.close();
    app = undefined;
  });

  function config() {
    return loadConfig({
      SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
    });
  }

  /** Auth repository that always denies, so routes return 401 before any DB work. */
  function denyingAuth(): AuthRepository {
    return {
      async resolveIdentity() {
        return { ok: false, reason: "denied", statusCode: 401, body: { detail: "Unauthorized" } };
      },
      async getSpaceForUser() {
        throw new Error("not used");
      },
      async getCurrentUser() {
        throw new Error("not used");
      },
      async getUserSpaces() {
        throw new Error("not used");
      },
      async logout() {
        throw new Error("not used");
      },
      async findOrCreateFromGoogle() {
        throw new Error("not used");
      },
      async createSession() {
        throw new Error("not used");
      },
    } as unknown as AuthRepository;
  }

  describe("Project public summary routes", () => {
    it("rejects an upsert body missing summary_text", async () => {
      __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
      app = buildModuleServer(config(), [projectsModule]);

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/projects/project-1/public-summary",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ topics: ["discovery"] }),
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain("summary_text");
    });

    it("rejects a draft request with a non-numeric max_tokens", async () => {
      __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
      app = buildModuleServer(config(), [projectsModule]);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/projects/project-1/public-summary/draft",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ max_tokens: "lots" }),
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain("max_tokens");
    });

    it("rejects a public-summary search for any other object type", async () => {
      __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
      app = buildModuleServer(config(), [projectsModule]);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/projects/public-summaries/search",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ query: "alpha", object_types: ["memory_entry"] }),
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain("project_public_summary");
    });

    it("rejects a project retrieval brief for any other object type", async () => {
      __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
      app = buildModuleServer(config(), [projectsModule]);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/projects/retrieval/brief",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ query: "alpha", object_types: ["memory_entry"] }),
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain("project_public_summary");
    });

    it("requires authentication for the draft route", async () => {
      __setAuthRepositoryForTests(denyingAuth());
      app = buildModuleServer(config(), [projectsModule]);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/projects/project-1/public-summary/draft",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({}),
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
