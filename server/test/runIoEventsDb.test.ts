import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runsModule } from "../src/modules/runs/index.js";
import { __setRunsIdentityForTests } from "../src/modules/runs/routes.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { seedRun, seedSpaceMember } from "./support/domainSeeds.js";
import { useTestDatabase } from "./support/testDatabase.js";

const SPACE = "11111111-1111-4111-8111-1111111111a1";
const OTHER_SPACE = "11111111-1111-4111-8111-1111111111a2";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const OUTSIDER = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const AGENT = "33333333-3333-4333-8333-3333333333a1";
const VERSION = "44444444-4444-4444-8444-4444444444a1";
const RUN = "55555555-5555-4555-8555-5555555555a1";
const SHARED_ARTIFACT = "run-io-shared-artifact";
const PRIVATE_ARTIFACT = "run-io-private-artifact";

// The semantic runtime vocabulary `/io` shows, and the operational events a
// long Run writes around it that only `/trace` returns.
const LOGICAL = ["assistant_message_completed", "tool_call_started", "tool_call_completed", "tool_call_failed", "approval_requested",
  "approval_resolved", "artifact_produced", "output_validation_completed", "warning", "error", "state_transition"];
const OPERATIONAL = ["context_compiled", "runtime_selected", "policy_checked", "adapter_invoked", "adapter_completed", "action_invoked",
  "action_completed", "validation_started", "provider_compacted"];
const EVENTS = 600;

const db = useTestDatabase(import.meta.filename, { max: 4 });
let app: FastifyInstance;

beforeAll(async () => {
  if (!db.available) return;
  const now = new Date().toISOString();
  for (const space of [SPACE, OTHER_SPACE]) {
    await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Team','household',$2,$2)`, [space, now]);
  }
  await seedSpaceMember(db.pool, { space: SPACE, user: OWNER, role: "owner", now });
  await seedSpaceMember(db.pool, { space: SPACE, user: MEMBER, role: "member", now });
  await seedSpaceMember(db.pool, { space: OTHER_SPACE, user: OUTSIDER, role: "owner", now });
  await seedRun(db.pool, { id: RUN, space: SPACE, owner: OWNER, agent: AGENT, version: VERSION, now });
  // Shared at summary level: the owner reads the body, another member only its metadata.
  await db.pool.query(`UPDATE runs SET access_level = 'summary', output_json = $2::jsonb WHERE id = $1`,
    [RUN, JSON.stringify({ schema_version: "run_output.v1", status: "succeeded", summary: "SECRET OUTPUT" })]);
  const types = [...LOGICAL, ...OPERATIONAL];
  await db.pool.query(
    `INSERT INTO run_events (id, space_id, run_id, event_index, event_type, status, summary, metadata_json, created_at)
     SELECT gen_random_uuid()::text, $1, $2, g, ($3::text[])[1 + (g * 7) % cardinality($3::text[])], 'succeeded',
            'SECRET SUMMARY ' || g, jsonb_build_object('index', g, 'detail', 'SECRET METADATA ' || g), $4::timestamptz + make_interval(secs => g)
       FROM generate_series(0, $5 - 1) AS g`,
    [SPACE, RUN, types, now, EVENTS],
  );
  await db.pool.query(
    `INSERT INTO artifacts (id, space_id, run_id, owner_user_id, artifact_type, title, content, export_formats_json, visibility, created_at, updated_at)
     VALUES ($1, $3, $4, $5, 'markdown', 'Shared artifact', 'Fixture body', '[]'::jsonb, 'space_shared', $6, $6),
            ($2, $3, $4, $5, 'markdown', 'Private artifact', 'Fixture body', '[]'::jsonb, 'private', $6, $6)`,
    [SHARED_ARTIFACT, PRIVATE_ARTIFACT, SPACE, RUN, OWNER, now],
  );
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [runsModule]);
});

afterEach(() => __setRunsIdentityForTests(null));
afterAll(async () => { await app?.close(); });

async function read(path: string, spaceId: string, userId: string) {
  __setRunsIdentityForTests({ spaceId, userId });
  return app.inject({ method: "GET", url: path });
}

describe("Run I/O events (real Postgres)", () => {
  it("returns the full viewer every logical event in order, with bodies, and nothing operational", async () => {
    if (!db.available) return;
    const response = await read(`/api/v1/runs/${RUN}/io`, SPACE, OWNER);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { events: Array<Record<string, unknown>>; output: unknown };
    const expected = (await db.pool.query<{ id: string; event_index: number; event_type: string }>(
      `SELECT id, event_index, event_type FROM run_events WHERE run_id = $1 ORDER BY event_index, id`, [RUN],
    )).rows.filter((row) => LOGICAL.includes(row.event_type));
    expect(expected.length).toBeGreaterThan(EVENTS / 3);
    expect(body.events.map((event) => [event.id, event.event_index, event.event_type])).toEqual(expected.map((row) => [row.id, row.event_index, row.event_type]));
    expect(body.events[0]).toMatchObject({ summary: expect.stringContaining("SECRET SUMMARY"), metadata_json: { detail: expect.stringContaining("SECRET METADATA") } });
    expect(body.output).toMatchObject({ summary: "SECRET OUTPUT" });
  });

  it("gives a summary viewer the Run's I/O shape without input, output or events", async () => {
    if (!db.available) return;
    const response = await read(`/api/v1/runs/${RUN}/io`, SPACE, MEMBER);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ schema_version: "run_io.v1", run_id: RUN, input: null, output: null, events: [] });
    expect(response.body).not.toContain("SECRET");
  });

  it("returns 404 for a Run in another space", async () => {
    if (!db.available) return;
    for (const path of ["io", "trace"]) {
      const response = await read(`/api/v1/runs/${RUN}/${path}`, OTHER_SPACE, OUTSIDER);
      expect(response.statusCode, path).toBe(404);
      expect(response.body).not.toContain("SECRET");
    }
  });

  it("applies the same Run visibility to detail, list and derived collection routes after sharing ends", async () => {
    if (!db.available) return;
    const collection = "/api/v1/runs";
    const detail = `${collection}/${RUN}`;
    const derived = ["trace", "io", "activities", "artifacts", "proposals"];

    const owner = await read(detail, SPACE, OWNER);
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain("SECRET OUTPUT");
    const summaryList = await read(collection, SPACE, MEMBER);
    expect(summaryList.statusCode).toBe(200);
    expect(summaryList.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: RUN })]));
    expect(summaryList.body).not.toContain("SECRET OUTPUT");
    const summaryDetail = await read(detail, SPACE, MEMBER);
    expect(summaryDetail.statusCode).toBe(200);
    expect(summaryDetail.body).not.toContain("SECRET OUTPUT");
    for (const suffix of derived) {
      const response = await read(`${detail}/${suffix}`, SPACE, MEMBER);
      expect(response.statusCode, suffix).toBe(200);
      expect(response.body, suffix).not.toContain("SECRET");
      if (suffix === "artifacts") {
        expect(response.json()).toMatchObject({ total: 1, items: [{ id: SHARED_ARTIFACT }] });
      }
    }
    const ownerArtifacts = await read(`${detail}/artifacts`, SPACE, OWNER);
    expect(ownerArtifacts.statusCode).toBe(200);
    expect(ownerArtifacts.json()).toMatchObject({
      total: 2,
      items: expect.arrayContaining([expect.objectContaining({ id: PRIVATE_ARTIFACT })]),
    });

    await db.pool.query("UPDATE runs SET visibility = 'private' WHERE id = $1", [RUN]);
    try {
      const privateList = await read(collection, SPACE, MEMBER);
      expect(privateList.statusCode).toBe(200);
      expect(privateList.json().map((run: { id: string }) => run.id)).not.toContain(RUN);
      for (const path of [detail, ...derived.map(suffix => `${detail}/${suffix}`)]) {
        expect((await read(path, SPACE, MEMBER)).statusCode, path).toBe(404);
      }
      expect((await read(detail, SPACE, OWNER)).statusCode).toBe(200);
    } finally {
      await db.pool.query("UPDATE runs SET visibility = 'space_shared' WHERE id = $1", [RUN]);
    }
  });

  it("keeps every event, operational ones included, on the trace", async () => {
    if (!db.available) return;
    const owner = await read(`/api/v1/runs/${RUN}/trace`, SPACE, OWNER);
    expect(owner.statusCode).toBe(200);
    const events = (owner.json() as { events: Array<{ event_index: number; event_type: string; summary: string | null }> }).events;
    expect(events.map((event) => event.event_index)).toEqual(Array.from({ length: EVENTS }, (_, index) => index));
    expect(new Set(events.map((event) => event.event_type))).toEqual(new Set([...LOGICAL, ...OPERATIONAL]));
    const member = await read(`/api/v1/runs/${RUN}/trace`, SPACE, MEMBER);
    expect(member.statusCode).toBe(200);
    expect(member.body).not.toContain("SECRET");
    expect((member.json() as { events: unknown[] }).events).toHaveLength(EVENTS);
  });
});
