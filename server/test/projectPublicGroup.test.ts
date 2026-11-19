import { randomUUID } from "node:crypto";
import { PROJECT_SUMMARY_DRAFT_SCHEMAS } from "@rainver/protocol";
import type { FastifyInstance } from "fastify";
import { seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests, __setAuthRepositoryForTests, type AuthRepository } from "../src/modules/auth/identity.js";
import { projectsModule } from "../src/modules/projects/index.js";
import { ProjectPublicSummaryGenerator } from "../src/modules/projects/publicSummaryGenerator.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { projectRetrievalRegistry } from "../src/modules/projects/retrievalAdapter.js";
import { EMBED_DIMENSIONS } from "../src/modules/retrieval/embedding/config.js";
import { type RetrievalEmbedder, RetrievalEmbeddingBackfillService } from "../src/modules/retrieval/embedding/service.js";
import { normalizeAlias } from "../src/modules/retrieval/normalize.js";
import { type QueryEmbedder } from "../src/modules/retrieval/types.js";
import { RetrievalSearchService } from "../src/modules/retrieval/searchService.js";
import type { QueryResult, Queryable, SpaceUserIdentity } from "../src/modules/routeUtils/common.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { jobsModule } from "../src/modules/jobs/index.js";
import { systemActionsModule } from "../src/modules/systemActions/index.js";
import { JobHandlerRegistry } from "../src/modules/jobs/handlerRegistry.js";
import { PROJECT_SUMMARY_BRIEF_JOB, registerProjectSummaryBriefJob } from "../src/modules/projects/summaryBriefOperation.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

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
      ["retrieval_edges", "retrieval_chunks", "retrieval_aliases", "retrieval_objects", "project_public_summary_publications", "project_public_summaries", "project_members", "projects", "space_memberships", "users", "spaces"],
      { cascade: true },
    );
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_at, updated_at)
       VALUES ($1, 'Team', 'household', now(), now())`,
      [SPACE],
    );
    for (const id of [OWNER, WRITER, VIEWER, READER]) {
      await db.pool.query(
        `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
         VALUES ($1, 'U', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
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
    await seedMainlineRoomsForAllProjects(db.pool);
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
    it("stages member drafts, gates publish and revoke to the owner, and rejects viewers", async () => {
      if (!db.available) return;

      // A project member (writer) can only stage a draft. Topics dedupe
      // case-insensitively and a source ref keeps only its identifying fields.
      const draft = await repo().upsertPublicSummary(
        { spaceId: SPACE, userId: WRITER },
        PROJECT,
        {
          summary_text: "Redacted high-level brief for cross-project idea discovery.",
          topics: ["Cross Project Discovery", "cross project discovery", "Project ACL"],
          highlights: ["No project memory content is indexed here."],
          source_refs: [{ source_type: "project", source_id: PROJECT, label: "Public project brief", content: "must not be persisted" }],
        },
      );
      expect(draft).toMatchObject({
        project_id: PROJECT,
        project_name: "Aster",
        topics: ["Cross Project Discovery", "Project ACL"],
        source_refs: [{ source_type: "project", source_id: PROJECT, label: "Public project brief" }],
        draft_version: 1,
        updated_by_user_id: WRITER,
      });
      expect(JSON.stringify(draft)).not.toContain("must not be persisted");
      const draftRow = (await db.pool.query(
        "SELECT topics_json, source_refs_json FROM project_public_summaries WHERE project_id = $1",
        [PROJECT],
      )).rows;
      expect(draftRow).toEqual([{
        topics_json: ["Cross Project Discovery", "Project ACL"],
        source_refs_json: [{ source_type: "project", source_id: PROJECT, label: "Public project brief" }],
      }]);
      // An unpublished draft is invisible to the public list and read, both for
      // a space reader and for the Project member who staged it.
      for (const userId of [READER, WRITER]) {
        expect(await repo().listPublicSummaries({ spaceId: SPACE, userId }, { limit: 50, offset: 0 }))
          .toMatchObject({ total: 0, items: [] });
        expect(await repo().getPublicSummary({ spaceId: SPACE, userId }, PROJECT)).toBeNull();
      }

      // The member cannot self-approve their own draft.
      await expect(repo().publishPublicSummary({ spaceId: SPACE, userId: WRITER }, PROJECT, 1))
        .rejects.toMatchObject({ statusCode: 403 });
      expect(await repo().getPublicSummary({ spaceId: SPACE, userId: READER }, PROJECT)).toBeNull();

      // The project owner reviews and publishes that version.
      const published = await repo().publishPublicSummary({ spaceId: SPACE, userId: OWNER }, PROJECT, 1);
      expect(published).toMatchObject({
        project_id: PROJECT,
        summary_text: "Redacted high-level brief for cross-project idea discovery.",
        topics: ["Cross Project Discovery", "Project ACL"],
        source_draft_version: 1,
        published_by_user_id: OWNER,
      });
      expect(JSON.stringify(
        (await db.pool.query("SELECT * FROM project_public_summary_publications WHERE project_id = $1", [PROJECT])).rows,
      )).not.toContain("must not be persisted");
      expect(await repo().getPublicSummary({ spaceId: SPACE, userId: READER }, PROJECT)).toMatchObject({
        summary_text: "Redacted high-level brief for cross-project idea discovery.",
        source_draft_version: 1,
      });

      // A writer cannot take it down either; the owner can, and the draft stays.
      await expect(repo().revokePublicSummary({ spaceId: SPACE, userId: WRITER }, PROJECT))
        .rejects.toMatchObject({ statusCode: 403 });
      await repo().revokePublicSummary({ spaceId: SPACE, userId: OWNER }, PROJECT);
      expect(await repo().getPublicSummary({ spaceId: SPACE, userId: READER }, PROJECT)).toBeNull();
      expect(await repo().getPublicSummaryEditorState({ spaceId: SPACE, userId: WRITER }, PROJECT)).toMatchObject({
        draft: { draft_version: 1 },
        published: null,
        can_publish: false,
      });
      await expect(repo().revokePublicSummary({ spaceId: SPACE, userId: OWNER }, PROJECT))
        .rejects.toMatchObject({ statusCode: 404 });

      // A viewer can never touch any of it.
      await expect(
        repo().upsertPublicSummary(
          { spaceId: SPACE, userId: VIEWER },
          PROJECT,
          { summary_text: "Viewer should not update this." },
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      // The refused viewer write left the staged draft untouched.
      expect(await repo().getPublicSummaryEditorState({ spaceId: SPACE, userId: WRITER }, PROJECT)).toMatchObject({
        draft: { draft_version: 1, summary_text: "Redacted high-level brief for cross-project idea discovery." },
      });
      await expect(repo().getPublicSummaryEditorState({ spaceId: SPACE, userId: VIEWER }, PROJECT))
        .rejects.toMatchObject({ statusCode: 403 });
    });

    it("keeps the published snapshot while the draft moves on, and publishes only a reviewed version", async () => {
      if (!db.available) return;
      await repo().upsertPublicSummary({ spaceId: SPACE, userId: WRITER }, PROJECT, {
        summary_text: "Version one.",
        topics: ["One"],
      });
      await repo().publishPublicSummary({ spaceId: SPACE, userId: OWNER }, PROJECT, 1);

      // The writer keeps editing. Readers still see version one.
      const edited = await repo().upsertPublicSummary({ spaceId: SPACE, userId: WRITER }, PROJECT, {
        summary_text: "Version two, not yet reviewed.",
        topics: ["Two"],
      });
      expect(edited).toMatchObject({ draft_version: 2 });
      expect(await repo().getPublicSummary({ spaceId: SPACE, userId: READER }, PROJECT)).toMatchObject({
        summary_text: "Version one.",
        source_draft_version: 1,
      });
      const search = () => new RetrievalSearchService(db.pool, projectRetrievalRegistry).search({
        spaceId: SPACE,
        viewerUserId: READER,
        objectTypes: ["project_public_summary"],
        query: "Version",
        maxResults: 5,
      });
      expect((await search()).items[0]).toMatchObject({ object_id: PROJECT, snippet: expect.stringContaining("Version one.") });
      expect(JSON.stringify(await search())).not.toContain("not yet reviewed");

      // The owner reviewed version 1; by the time they approve, the draft is
      // version 2. Approving a version nobody reviewed is refused.
      await expect(repo().publishPublicSummary({ spaceId: SPACE, userId: OWNER }, PROJECT, 1))
        .rejects.toMatchObject({ statusCode: 409, responseBody: { code: "project_public_summary_draft_changed", current_draft_version: 2 } });
      expect(await repo().getPublicSummary({ spaceId: SPACE, userId: READER }, PROJECT)).toMatchObject({ source_draft_version: 1 });

      // Reviewing the current version and approving it replaces the snapshot,
      // and the index follows the snapshot, never the draft.
      await repo().publishPublicSummary({ spaceId: SPACE, userId: OWNER }, PROJECT, 2);
      expect(await repo().getPublicSummary({ spaceId: SPACE, userId: READER }, PROJECT)).toMatchObject({
        summary_text: "Version two, not yet reviewed.",
        source_draft_version: 2,
      });
      expect((await search()).items[0]).toMatchObject({ object_id: PROJECT, snippet: expect.stringContaining("Version two") });

      // Revoking clears the public projection with the snapshot.
      await repo().revokePublicSummary({ spaceId: SPACE, userId: OWNER }, PROJECT);
      expect((await search()).items).toEqual([]);
      expect(await repo().listPublicSummaries({ spaceId: SPACE, userId: READER }, { limit: 10, offset: 0 }))
        .toMatchObject({ total: 0, items: [] });
    });

    it("keeps approved summaries space-public and searchable through project retrieval", async () => {
      if (!db.available) return;

      await repo().upsertPublicSummary(
        { spaceId: SPACE, userId: OWNER },
        PROJECT,
        {
          summary_text: "Redacted high-level brief for cross-project idea discovery.",
          topics: ["Cross Project Discovery"],
        },
      );
      await repo().publishPublicSummary({ spaceId: SPACE, userId: OWNER }, PROJECT, 1);

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
        },
      );
      await repo().publishPublicSummary({ spaceId: SPACE, userId: OWNER }, PROJECT, 1);
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
      if (norm.includes("FROM project_public_summary_publications pub")) {
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
      SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
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
    } as unknown as AuthRepository;
  }

  describe("Project public summary routes", () => {
    it("accepts only the strict draft admission contract", () => {
      const schema = PROJECT_SUMMARY_DRAFT_SCHEMAS["project.public_summary.draft.generate"].input;
      expect(schema.safeParse({ project_id: "project-1", max_tokens: "lots" }).success).toBe(false);
      expect(schema.safeParse({ project_id: "project-1", generated_by_run_id: "run-1" }).success).toBe(false);
      expect(schema.safeParse({ project_id: "project-1", model_provider_id: "provider-1" }).success).toBe(true);
    });

    it("accepts only public-summary briefs in the strict brief admission contract", () => {
      const schema = PROJECT_SUMMARY_DRAFT_SCHEMAS["project.summary.brief.request"].input;
      expect(schema.safeParse({ query: "alpha", object_types: ["memory_entry"] }).success).toBe(false);
      expect(schema.safeParse({ query: "alpha", object_types: ["project_public_summary"], persist_artifact: true }).success).toBe(true);
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

describe("projectReadersRoute", () => {
  // Real Postgres: the route reads the reader predicate itself, and what it
  // protects is that the answer *is* the gate — nobody outside the readers
  // learns the roster, or that there was one.
  const db = useTestDatabase(`${import.meta.filename}#projectReadersRoute`);
  const SPACE = "61111111-1111-4111-8111-111111111111";
  const OWNER = "6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const MEMBER = "6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PROJECT = "65555555-5555-4555-8555-555555555555";
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(db.pool, ["project_members", "rooms", "projects", "space_memberships", "users", "spaces"], { cascade: true });
    // A team-type Space: in a personal one every member reads every Project
    // by rule, and the gate this pins would have nothing to refuse.
    await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT, spaceType: "household" });
    await seedSpaceMember(db.pool, { space: SPACE, user: MEMBER });
    app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [projectsModule]);
  });
  afterEach(async () => {
    __setAuthIdentityForTests(null);
    await app?.close();
    app = undefined;
  });

  it("lists the owner as a reader, and a member once added", async () => {
    if (!db.available || !app) return;
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
    let response = await app.inject({ method: "GET", url: `/api/v1/projects/${PROJECT}/readers` });
    expect(response.statusCode).toBe(200);
    expect(response.json().readers.map((reader: { user_id: string }) => reader.user_id)).toEqual([OWNER]);

    await new PgProjectRepository(db.pool).addMember({ spaceId: SPACE, userId: OWNER }, PROJECT, { user_id: MEMBER, role: "member" });
    response = await app.inject({ method: "GET", url: `/api/v1/projects/${PROJECT}/readers` });
    expect(response.json().readers.map((reader: { user_id: string }) => reader.user_id).sort()).toEqual([OWNER, MEMBER].sort());
  });

  it("answers a space member who cannot read the Project exactly as it answers a Project that does not exist", async () => {
    if (!db.available || !app) return;
    __setAuthIdentityForTests({ spaceId: SPACE, userId: MEMBER });
    const notReader = await app.inject({ method: "GET", url: `/api/v1/projects/${PROJECT}/readers` });
    const missing = await app.inject({ method: "GET", url: `/api/v1/projects/${randomUUID()}/readers` });
    expect(notReader.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // No roster and no existence signal: the two bodies are identical.
    expect(notReader.json()).toEqual(missing.json());
  });
});

describe("projectSummaryBriefOperation", () => {
  // The public-summary Context Brief is admitted by the core and built by its Job,
  // so embedding/rerank/synthesis never run inside a core transaction.
  const db=useTestDatabase(`${import.meta.filename}#projectSummaryBriefOperation`,{max:6});
  let space:string,owner:string,app:ReturnType<typeof buildModuleServer>,config:ReturnType<typeof loadConfig>;
  const brief=(payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/projects/retrieval/brief',payload,headers:{'idempotency-key':key}});
  beforeEach(async()=>{
   await resetTables(db.pool,['spaces','users'],{cascade:true});
   space=randomUUID();owner=randomUUID();
   await seedSpaceOwnerProject(db.pool,{space,owner,project:randomUUID(),spaceType:'team'});
   config=loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:'/tmp/rainver-p5-tests'});
   app=buildModuleServer(config,[projectsModule,jobsModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
  });
  afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

  it('queues one requester-owned brief Job per key and refuses other object types before admission',async()=>{
   const key=randomUUID(),first=await brief({query:'project discovery',persist_artifact:true},key);
   expect(first.statusCode,first.body).toBe(202);
   const receipt=first.json().data;expect(receipt).toEqual({id:receipt.job_id,space_id:space,job_id:receipt.job_id});
   expect((await brief({query:'project discovery',persist_artifact:true},key)).json()).toEqual(first.json());
   expect((await brief({query:'other',persist_artifact:true},key)).statusCode).toBe(422);
   expect((await brief({query:'q',object_types:['memory_entry']})).statusCode).toBe(422);
   expect((await db.pool.query('SELECT job_type,user_id,payload_json FROM jobs WHERE space_id=$1',[space])).rows).toEqual([{job_type:PROJECT_SUMMARY_BRIEF_JOB,user_id:owner,payload_json:{request:{query:'project discovery',persist_artifact:true}}}]);
   // The result is the requester's alone.
   const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});__setAuthIdentityForTests({spaceId:space,userId:peer});
   expect((await app.inject({method:'GET',url:`/api/v1/jobs/${receipt.job_id}`})).statusCode).toBe(404);
   expect((await brief({query:'project discovery',persist_artifact:true},key)).json().data.job_id).not.toBe(receipt.job_id);
  });

  it('registers the worker that builds the brief outside the admitting transaction',()=>{
   const registry=new JobHandlerRegistry();registerProjectSummaryBriefJob(registry,config);
   expect(registry.get(PROJECT_SUMMARY_BRIEF_JOB)).toBeTypeOf('function');
  });
});

// Pure summary rules over a canned-row Queryable: source_ref shape and what a generated
// draft may carry. Scoped in a block so its fixtures stay apart from the real-PostgreSQL ones.
{
  const SPACE = "11111111-1111-4111-8111-111111111111";
  const PROJECT = "22222222-2222-4222-8222-222222222222";
  const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  interface SummaryFixture {
    id: string;
    space_id: string;
    project_id: string;
    project_name: string;
    summary_text: string;
    topics_json: string[];
    highlights_json: string[];
    source_refs_json: Array<Record<string, string>>;
    redaction_version: string;
  }

  interface DraftFixture extends SummaryFixture {
    draft_version: number;
    updated_by_user_id: string | null;
    generated_by_run_id: string | null;
    created_at: string;
    updated_at: string;
  }

  /**
   * SQL-shape fake for validation that fails before any write and for draft
   * generation; durable staging, sanitizing, draft read isolation, publish/revoke
   * and role gates are covered against real Postgres in `projectPublicGroup.test.ts`.
   */
  class ProjectSummaryFakeDb implements Queryable {
    readonly writes: string[] = [];
    private draft: DraftFixture | null = null;

    async query<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> {
      const norm = sql.replace(/\s+/g, " ").trim();
      if (norm.startsWith("SELECT id, name, description, current_focus FROM projects")) {
        return result([{
          id: PROJECT,
          name: "Aster",
          description: "Builds project-level public discovery.",
          current_focus: "Cross-project high-level summaries",
        }] as Row[]);
      }
      if (norm.startsWith("SELECT id FROM projects") || norm.startsWith("SELECT id, status FROM projects")) {
        return result([{ id: PROJECT, status: "active" }] as Row[]);
      }
      if (norm.startsWith("SELECT id, space_id, owner_user_id, name, description, status, current_focus")) {
        return result([{ id: PROJECT, space_id: SPACE, owner_user_id: OWNER, name: "Aster", status: "active" }] as Row[]);
      }
      if (norm.startsWith("SELECT owner_user_id FROM projects")) {
        return result([{ owner_user_id: OWNER }] as Row[]);
      }
      if (norm.startsWith("SELECT role FROM space_memberships")) {
        return result([{ role: "member" }] as Row[]);
      }
      if (norm.startsWith("SELECT role FROM project_members")) {
        const [, , userId] = params as [string, string, string];
        const role = userId === MEMBER ? "member" : userId === VIEWER ? "viewer" : null;
        return result((role ? [{ role }] : []) as Row[]);
      }
      if (norm.startsWith("SELECT ps.id, ps.space_id")) {
        return result((this.draft ? [this.draft] : []) as Row[]);
      }
      if (norm.startsWith("WITH upserted AS")) {
        this.writes.push("upsert");
        const [
          id,
          spaceId,
          projectId,
          summaryText,
          topicsJson,
          highlightsJson,
          sourceRefsJson,
          redactionVersion,
          updatedByUserId,
          generatedByRunId,
          now,
        ] = params as [string, string, string, string, string, string, string, string, string, string | null, string];
        this.draft = {
          id: this.draft?.id ?? id,
          space_id: spaceId,
          project_id: projectId,
          project_name: "Aster",
          summary_text: summaryText,
          topics_json: JSON.parse(topicsJson) as string[],
          highlights_json: JSON.parse(highlightsJson) as string[],
          source_refs_json: JSON.parse(sourceRefsJson) as Array<Record<string, string>>,
          redaction_version: redactionVersion,
          draft_version: (this.draft?.draft_version ?? 0) + 1,
          updated_by_user_id: updatedByUserId,
          generated_by_run_id: generatedByRunId,
          created_at: this.draft?.created_at ?? now,
          updated_at: now,
        };
        return result([this.draft] as Row[]);
      }
      if (norm.startsWith("DELETE FROM retrieval_edges") || norm.startsWith("DELETE FROM retrieval_objects")) {
        return result([] as Row[]);
      }
      if (norm.startsWith("INSERT INTO retrieval_objects")) {
        return result([{ id: "retrieval-object-1" }] as Row[]);
      }
      if (norm.startsWith("INSERT INTO retrieval_aliases") || norm.startsWith("INSERT INTO retrieval_chunks")) {
        return result([] as Row[]);
      }
      if (norm.startsWith("SELECT DISTINCT object_type, object_id FROM retrieval_aliases")) {
        return result([] as Row[]);
      }
      if (norm.includes("FROM memory_entries")) {
        return result([
          {
            id: "memory-1",
            space_id: SPACE,
            subject_user_id: null,
            owner_user_id: OWNER,
            project_folder_id: null,
            scope_type: "user",
            namespace: "project",
            memory_type: "fact",
            title: "Retrieval substrate",
            content: "Builds high-level public project summaries for discovery.",
            visibility: "space_shared",
            sensitivity_level: "normal",
            access_level: "full",
            tags: ["retrieval", "summary"],
            importance: 0.9,
            updated_at: "2026-06-22T00:00:00.000Z",
            source_trust: "user_confirmed",
            project_id: PROJECT,
            deleted_at: null,
          },
          {
            id: "memory-2",
            space_id: SPACE,
            subject_user_id: null,
            owner_user_id: OWNER,
            project_folder_id: null,
            scope_type: "user",
            namespace: "project",
            memory_type: "fact",
            title: "Sensitive launch code",
            content: "SECRET_CUSTOMER_ACCOUNT",
            visibility: "space_shared",
            sensitivity_level: "sensitive",
            access_level: "full",
            tags: ["secret"],
            importance: 0.8,
            updated_at: "2026-06-22T00:00:00.000Z",
            source_trust: "user_confirmed",
            project_id: PROJECT,
            deleted_at: null,
          },
        ] as Row[]);
      }
      if (norm.startsWith("SELECT r.id FROM runs r WHERE r.id = $1")) {
        // Server-authored draft provenance: the worker's own queued Run.
        return result(params[0] === "run-1" ? [{ id: "run-1" }] : []) as QueryResult<Row>;
      }
      if (norm.includes("FROM activity_records")) {
        return result([
          {
            id: "activity-1",
            activity_type: "user_capture",
            title: "Design discussion",
            content: "Use public high-level summaries to inspire other projects.",
            visibility: "space_shared",
            owner_user_id: OWNER,
            user_id: OWNER,
            subject_user_id: null,
            occurred_at: "2026-06-22T00:00:00.000Z",
          },
        ] as Row[]);
      }
      if (norm.includes("FROM artifacts")) {
        return result([
          {
            id: "artifact-1",
            artifact_type: "summary",
            title: "Project ACL notes",
            mime_type: "text/markdown",
            visibility: "space_shared",
            owner_user_id: OWNER,
            created_at: "2026-06-22T00:00:00.000Z",
          },
        ] as Row[]);
      }
      if (norm.includes("FROM proposals p")) {
        return result([
          {
            id: "proposal-1",
            proposal_type: "memory_create",
            status: "approved",
            title: "Remember retrieval ACL decision",
            rationale: "Project summary should stay public and redacted.",
            visibility: "space_shared",
            created_by_user_id: OWNER,
            instructed_by_user_id: OWNER,
            created_at: "2026-06-22T00:00:00.000Z",
          },
        ] as Row[]);
      }
      throw new Error(`unexpected SQL: ${norm}`);
    }
  }

  const ownerIdentity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

  describe("Project public summaries", () => {
    it("requires source_refs to identify a public source, not embed source content", async () => {
      const db = new ProjectSummaryFakeDb();

      await expect(
        new PgProjectRepository(db).upsertPublicSummary(ownerIdentity, PROJECT, {
          summary_text: "Public brief.",
          source_refs: [{ source_type: "memo", excerpt: "raw content" }],
        }),
      ).rejects.toMatchObject({
        statusCode: 422,
        message: "source_refs entries require source_type and source_id",
      });
      expect(db.writes).toHaveLength(0);
    });

    it("generates a draft summary without exposing sensitive memory content or hallucinated source refs", async () => {
      const db = new ProjectSummaryFakeDb();
      const generator = new ProjectPublicSummaryGenerator(db);
      const prepared = await generator.prepareDraft(ownerIdentity, PROJECT, { providerId: "provider-1" });
      const observedPrompt = `${prepared.prompt.system}\n${prepared.prompt.user}`;
      // The worker supplies the provider text; only admission-frozen references survive.
      const out = await generator.applyDraft(ownerIdentity, PROJECT, {
        providerId: "provider-1",
        model: "test-model",
        text: JSON.stringify({
          summary_text: "Aster explores safe, high-level project discovery across project boundaries.",
          topics: ["project discovery", "public summary"],
          highlights: ["Uses a redacted summary layer instead of exposing project memory."],
          source_refs: [
            { source_type: "memory", source_id: "memory-1", label: "Retrieval substrate", trust_level: "derived", content: "must be dropped" },
            { source_type: "memory", source_id: "missing-memory", label: "Hallucinated" },
          ],
        }),
      }, prepared, "run-1");

      expect(observedPrompt).toContain("memory:memory-1");
      expect(observedPrompt).not.toContain("SECRET_CUSTOMER_ACCOUNT");
      expect(out).toMatchObject({
        project_id: PROJECT,
        draft_version: 1,
        summary_text: "Aster explores safe, high-level project discovery across project boundaries.",
        source_refs: [
          {
            source_type: "memory",
            source_id: "memory-1",
            label: "Retrieval substrate",
            trust_level: "derived",
          },
        ],
        generated_by_run_id: "run-1",
      });
      expect(JSON.stringify(out)).not.toContain("must be dropped");
      expect(JSON.stringify(out)).not.toContain("missing-memory");
    });
  });

  function result<Row>(rows: Row[]): QueryResult<Row> {
    return { rows, rowCount: rows.length };
  }
}
