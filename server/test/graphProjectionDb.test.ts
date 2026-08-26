import { randomUUID } from "node:crypto";
import * as protocol from "@agent-space/protocol";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import * as poolModule from "../src/db/pool.js";
import { loadConfig } from "../src/config.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { graphModule } from "../src/modules/graph/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { GraphProjectionBuilder } from "../src/modules/graph/projectionBuilder.js";
import { GraphProjectionRepository } from "../src/modules/graph/projectionRepository.js";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common.js";


const db = useTestDatabase(import.meta.filename);

// Files share a worker: an identity or invoker left in a module-level
// seam would leak into whichever file runs next.
afterAll(() => {
  __setAuthIdentityForTests(null);
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["graph_view_states", "object_relations", "knowledge_items", "notes", "sources", "claims", "space_objects", "users", "spaces"],
    { cascade: true },
  );
});

describe("GraphProjectionBuilder real-DB projections", () => {
  it("builds a capped global projection without leaking private objects or hidden-edge endpoints", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const ids = await seedGraphFixture();
    const projection = await builder().build(ids.identity, {
      mode: "global",
      limit: 4,
      includeClusters: true,
    });

    expect(projection.view).toMatchObject({
      mode: "global",
      totalNodeCount: 3,
      truncated: true,
    });
    expect(projection.nodes.map((node) => node.id)).not.toContain(ids.hidden);
    expect(projection.edges.some((edge) => edge.source === ids.hidden || edge.target === ids.hidden)).toBe(false);
    expect(projection.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "cluster:knowledge_item",
      "cluster:note",
    ]));
    expect(projection.edges.map((edge) => edge.kind)).toContain("cluster_contains");
  });

  it("applies global node and edge allowlists to object and structural edges", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const ids = await seedGraphFixture();
    const projection = await builder().build(ids.identity, {
      mode: "global",
      limit: 10,
      includeClusters: true,
      nodeKinds: ["knowledge_item"],
      edgeKinds: ["references"],
    });

    expect(projection.nodes.every((node) => node.kind === "cluster" || node.kind === "knowledge_item")).toBe(true);
    expect(projection.nodes.map((node) => node.id)).not.toContain("cluster:note");
    expect(projection.edges.every((edge) => edge.kind === "references")).toBe(true);
  });

  it("keeps global projections within the requested node cap", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const ids = await seedGraphFixture();
    const projection = await builder().build(ids.identity, {
      mode: "global",
      limit: 1,
      includeClusters: true,
    });

    expect(projection.nodes.length).toBeLessThanOrEqual(1);
    expect(projection.view.truncated).toBe(true);
  });

  it("uses a recursive local projection with depth caps and visibility trimming", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const ids = await seedGraphFixture();

    const depthOne = await builder().build(ids.identity, {
      mode: "local",
      rootId: ids.alpha,
      depth: 1,
      limit: 10,
      includeClusters: false,
    });
    expect(depthOne.nodes.map((node) => node.id).sort()).toEqual([ids.alpha, ids.beta].sort());
    expect(depthOne.nodes.map((node) => node.id)).not.toContain(ids.hidden);

    const depthTwo = await builder().build(ids.identity, {
      mode: "local",
      rootId: ids.alpha,
      depth: 2,
      limit: 10,
      includeClusters: false,
    });
    expect(depthTwo.nodes.map((node) => node.id).sort()).toEqual([ids.alpha, ids.beta, ids.gamma].sort());
    expect(depthTwo.edges.map((edge) => edge.id).sort()).toEqual([ids.alphaBetaRelation, ids.betaGammaRelation].sort());
  });

  it("returns search matches plus a one-hop visible neighborhood", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const ids = await seedGraphFixture();
    const projection = await builder().build(ids.identity, {
      mode: "search",
      q: "Beta",
      limit: 10,
      includeClusters: false,
    });

    expect(projection.view.mode).toBe("search");
    expect(projection.nodes.map((node) => node.id).sort()).toEqual([ids.alpha, ids.beta, ids.gamma].sort());
    expect(projection.nodes.find((node) => node.id === ids.beta)?.metadata).toMatchObject({ forceLabel: true });
    expect(projection.nodes.map((node) => node.id)).not.toContain(ids.hidden);
  });

  it("caps raw object edges by descending weight before recency", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const identity = await seedIdentity();
    const root = await seedSpaceObject(identity, {
      objectType: "knowledge_item",
      title: "Root",
      status: "active",
    });
    const low = await seedSpaceObject(identity, {
      objectType: "note",
      title: "Low confidence",
      status: "active",
    });
    const high = await seedSpaceObject(identity, {
      objectType: "note",
      title: "High confidence",
      status: "active",
    });
    const mid = await seedSpaceObject(identity, {
      objectType: "note",
      title: "Middle confidence",
      status: "active",
    });
    const lowEdge = await seedRelation(identity, root, low, "related_to", {
      confidence: 0.1,
      updatedAt: "2026-07-04T12:03:00.000Z",
    });
    const highEdge = await seedRelation(identity, root, high, "related_to", {
      confidence: 0.9,
      updatedAt: "2026-07-04T12:01:00.000Z",
    });
    const midEdge = await seedRelation(identity, root, mid, "related_to", {
      confidence: 0.5,
      updatedAt: "2026-07-04T12:02:00.000Z",
    });

    const rows = await new GraphProjectionRepository(db.pool).listEdgesForNodeIds(
      identity,
      [root, low, high, mid],
      { limit: 2 },
    );

    expect(rows.map((row) => row.id)).toEqual([highEdge, midEdge]);
    expect(rows.map((row) => row.id)).not.toContain(lowEdge);
  });

  it("applies node kind filters before local traversal and search matching", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const ids = await seedGraphFixture();

    const local = await builder().build(ids.identity, {
      mode: "local",
      rootId: ids.alpha,
      depth: 2,
      limit: 10,
      includeClusters: false,
      nodeKinds: ["knowledge_item"],
    });
    expect(local.nodes.map((node) => node.id)).toEqual([ids.alpha]);
    expect(local.edges).toEqual([]);

    const search = await builder().build(ids.identity, {
      mode: "search",
      q: "Beta",
      limit: 10,
      includeClusters: false,
      nodeKinds: ["knowledge_item"],
    });
    expect(search.nodes).toEqual([]);
    expect(search.edges).toEqual([]);
  });

  it("expands cluster roots by graph cluster id", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const ids = await seedGraphFixture();
    const projection = await builder().build(ids.identity, {
      mode: "cluster",
      rootId: "cluster:note",
      limit: 10,
      includeClusters: false,
    });

    expect(projection.view).toMatchObject({
      mode: "cluster",
      rootId: "cluster:note",
      totalNodeCount: 2,
      truncated: false,
    });
    expect(projection.nodes.map((node) => node.id).sort()).toEqual([ids.beta, ids.gamma].sort());
  });

  it("expands cluster roots by visible object id", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const ids = await seedGraphFixture();
    const projection = await builder().build(ids.identity, {
      mode: "cluster",
      rootId: ids.beta,
      limit: 10,
      includeClusters: false,
    });

    expect(projection.view.rootId).toBe(ids.beta);
    expect(projection.nodes.map((node) => node.id).sort()).toEqual([ids.beta, ids.gamma].sort());
  });

  it("treats invisible or missing local roots as not found", async (ctx) => {
    if (!db.available || !db.pool) return ctx.skip();
    const ids = await seedGraphFixture();

    await expect(builder().build(ids.identity, {
      mode: "local",
      rootId: ids.hidden,
      depth: 1,
      limit: 10,
      includeClusters: false,
    })).rejects.toThrow("Graph root not found");
  });
});

describe("Graph routes", () => {
  it("uses the standard internal error envelope for graph 5xx responses", async () => {
    __setAuthIdentityForTests({
      spaceId: "11111111-1111-4111-8111-111111111111",
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const app = buildModuleServer(loadConfig({}), [graphModule]);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/graph/view-state?scope_key=core:graph",
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        error: "internal_error",
        message: "Internal server error",
      });
      expect(JSON.stringify(response.json())).not.toContain("SERVER_DATABASE_URL");
    } finally {
      await app.close();
      __setAuthIdentityForTests(null);
    }
  });

  it("serves projection and upserts per-user view state through HTTP", async (ctx) => {
    if (!db.available) return ctx.skip();
    const ids = await seedGraphFixture();
    __setAuthIdentityForTests({ spaceId: ids.identity.spaceId, userId: ids.identity.userId });
    const poolSpy = vi.spyOn(poolModule, "getDbPool").mockReturnValue(db.pool);
    let app: FastifyInstance | undefined;
    try {
      app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [graphModule]);
      const projectionResponse = await app.inject({
        method: "GET",
        url: `/api/v1/graph/projection?mode=local&root_id=${ids.alpha}&depth=1&limit=10`,
      });
      expect(projectionResponse.statusCode).toBe(200);
      const parsedProjection = protocol.GraphProjectionSchema.parse(projectionResponse.json());
      expect(parsedProjection.nodes).toHaveLength(2);

      const saveResponse = await app.inject({
        method: "PUT",
        url: "/api/v1/graph/view-state",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          scope_key: "core:graph",
          state_json: { currentLayout: "force", pinnedNodes: { [ids.alpha]: { x: 10, y: 20 } } },
        }),
      });
      expect(saveResponse.statusCode).toBe(200);
      expect(saveResponse.json()).toMatchObject({
        scope_key: "core:graph",
        state_json: { currentLayout: "force" },
      });

      const loadResponse = await app.inject({
        method: "GET",
        url: "/api/v1/graph/view-state?scope_key=core:graph",
      });
      expect(loadResponse.statusCode).toBe(200);
      expect(loadResponse.json()).toMatchObject({
        scope_key: "core:graph",
        state_json: { pinnedNodes: { [ids.alpha]: { x: 10, y: 20 } } },
      });

      __setAuthIdentityForTests({ spaceId: ids.identity.spaceId, userId: ids.otherUserId });
      const isolatedLoadResponse = await app.inject({
        method: "GET",
        url: "/api/v1/graph/view-state?scope_key=core:graph",
      });
      expect(isolatedLoadResponse.statusCode).toBe(200);
      expect(isolatedLoadResponse.json()).toMatchObject({
        scope_key: "core:graph",
        state_json: {},
      });

      __setAuthIdentityForTests({ spaceId: ids.identity.spaceId, userId: ids.identity.userId });
      const invalidModeResponse = await app.inject({
        method: "GET",
        url: "/api/v1/graph/projection?mode=debug",
      });
      expect(invalidModeResponse.statusCode).toBe(422);
      expect(invalidModeResponse.json()).toMatchObject({
        error: "request_error",
        message: "debug graph mode is frontend-only",
      });
      expect(invalidModeResponse.json()).toHaveProperty("request_id");
    } finally {
      await app?.close();
      poolSpy.mockRestore();
      __setAuthIdentityForTests(null);
    }
  });
});

function builder(): GraphProjectionBuilder {
  return new GraphProjectionBuilder(new GraphProjectionRepository(db.pool));
}

interface SeededGraph {
  identity: SpaceUserIdentity;
  otherUserId: string;
  alpha: string;
  beta: string;
  gamma: string;
  hidden: string;
  alphaBetaRelation: string;
  betaGammaRelation: string;
}

async function seedGraphFixture(): Promise<SeededGraph> {
  const identity = await seedIdentity();
  const otherUserId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Other', 'active', $2, $2)`,
    [otherUserId, now],
  );
  const alpha = await seedSpaceObject(identity, {
    objectType: "knowledge_item",
    title: "Alpha wiki item",
    status: "active",
  });
  const beta = await seedSpaceObject(identity, {
    objectType: "note",
    title: "Beta note",
    status: "active",
  });
  const gamma = await seedSpaceObject(identity, {
    objectType: "note",
    title: "Gamma note",
    status: "active",
  });
  const hidden = await seedSpaceObject(identity, {
    objectType: "knowledge_item",
    title: "Hidden item",
    status: "active",
    visibility: "private",
    ownerUserId: otherUserId,
    createdByUserId: otherUserId,
  });
  const alphaBetaRelation = await seedRelation(identity, alpha, beta, "references");
  const betaGammaRelation = await seedRelation(identity, beta, gamma, "related_to");
  await seedRelation(identity, alpha, hidden, "depends_on");
  await seedRelation(identity, hidden, gamma, "supports");
  return {
    identity,
    otherUserId,
    alpha,
    beta,
    gamma,
    hidden,
    alphaBetaRelation,
    betaGammaRelation,
  };
}

async function seedIdentity(): Promise<SpaceUserIdentity> {
  const userId = randomUUID();
  const spaceId = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Viewer', 'active', $2, $2)`,
    [userId, now],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Graph Space', 'team', $2, $3, $3)`,
    [spaceId, userId, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, 'owner', 'active', $3, $3)`,
    [spaceId, userId, now],
  );
  return { spaceId, userId };
}

async function seedSpaceObject(
  identity: SpaceUserIdentity,
  input: {
    objectType: string;
    title: string;
    status: string;
    visibility?: string;
    ownerUserId?: string | null;
    createdByUserId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, summary, visibility, owner_user_id, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [
      id,
      identity.spaceId,
      input.objectType,
      input.title,
      `${input.title} summary`,
      input.visibility ?? "space_shared",
      input.ownerUserId ?? identity.userId,
      input.createdByUserId ?? identity.userId,
      now,
    ],
  );
  // Domain status lives on the extension table (B12D), and a real object
  // always has one — seeding a root row alone would not be a shape the
  // application can produce.
  if (input.objectType === "knowledge_item") {
    await db.pool.query(
      `INSERT INTO knowledge_items (object_id, space_id, status, knowledge_kind, content, content_format, content_schema_version, verification_status, reflection_status, tags_json, version)
       VALUES ($1, $2, $3, 'concept', $4, 'markdown', 1, 'unverified', 'unreviewed', '[]'::jsonb, 1)`,
      [id, identity.spaceId, input.status, `${input.title} body`],
    );
  } else if (input.objectType === "note") {
    await db.pool.query(
      `INSERT INTO notes (object_id, space_id, status, content_format, content_schema_version, plain_text, version)
       VALUES ($1, $2, $3, 'markdown', 1, $4, 1)`,
      [id, identity.spaceId, input.status, `${input.title} body`],
    );
  } else {
    throw new Error(`seedSpaceObject: add an extension insert for ${input.objectType}`);
  }
  return id;
}

async function seedRelation(
  identity: SpaceUserIdentity,
  fromObjectId: string,
  toObjectId: string,
  linkType: string,
  options: { confidence?: number | null; updatedAt?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const now = options.updatedAt ?? new Date().toISOString();
  const confidence = options.confidence === undefined ? 0.8 : options.confidence;
  await db.pool.query(
    `INSERT INTO object_relations (
       id, space_id, from_object_id, to_object_id, link_type,
       status, confidence, evidence_summary, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'active', $6, 'seeded relation', $7, $7)`,
    [id, identity.spaceId, fromObjectId, toObjectId, linkType, confidence, now],
  );
  return id;
}
