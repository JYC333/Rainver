import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { artifactsModule } from "../src/modules/artifacts/index.js";
import { __setArtifactIdentityForTests } from "../src/modules/artifacts/routes.js";
import { proposalsModule } from "../src/modules/proposals/index.js";
import { __setProposalIdentityForTests } from "../src/modules/proposals/routes.js";
import { runsModule } from "../src/modules/runs/index.js";
import { __setRunsIdentityForTests } from "../src/modules/runs/routes.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { seedProjectMainlineRoom, seedRun, seedSpaceMember } from "./support/domainSeeds.js";
import { useTestDatabase } from "./support/testDatabase.js";

// One Room Run, its Artifacts and its Proposals, read through every entry that
// names them: Run detail, list and derived routes, and the Artifact and
// Proposal collections' own detail and list. Each viewer must get the same
// answer from every entry, and the answer must follow Room membership,
// Project membership and the Run's Project Folder as they change.

const SPACE = "11111111-1111-4111-8111-1111111111c1";
const OTHER_SPACE = "11111111-1111-4111-8111-1111111111c2";
const PROJECT = "22222222-2222-4222-8222-2222222222c1";
const OTHER_PROJECT = "22222222-2222-4222-8222-2222222222c2";
const FOLDER = "66666666-6666-4666-8666-6666666666c1";
const OTHER_FOLDER = "66666666-6666-4666-8666-6666666666c2";
const ROOM = "77777777-7777-4777-8777-7777777777c1";
const SESSION = "88888888-8888-4888-8888-8888888888c1";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac1";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbc1";
const ADMIN = "dddddddd-dddd-4ddd-8ddd-ddddddddddc1";
const PEER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeec1";
const OUTSIDER = "cccccccc-cccc-4ccc-8ccc-ccccccccccc9";
const AGENT = "33333333-3333-4333-8333-3333333333c1";
const VERSION = "44444444-4444-4444-8444-4444444444c1";
const RUN = "55555555-5555-4555-8555-5555555555c1";
const ARTIFACT = "run-matrix-artifact";
const DEEP_READ_ARTIFACT = "run-matrix-deep-read-artifact";
const PROPOSAL = "run-matrix-proposal";
const REPORT_PROPOSAL = "run-matrix-report-proposal";

const db = useTestDatabase(import.meta.filename, { max: 4 });
let app: FastifyInstance;

beforeAll(async () => {
  if (!db.available) return;
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, oversight_mode, created_at, updated_at) VALUES ($1,'Team','team','full',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Other','team',$2,$2)`, [OTHER_SPACE, now]);
  await seedSpaceMember(db.pool, { space: SPACE, user: OWNER, role: "owner", now });
  await seedSpaceMember(db.pool, { space: SPACE, user: MEMBER, role: "member", now });
  await seedSpaceMember(db.pool, { space: SPACE, user: ADMIN, role: "admin", now });
  await seedSpaceMember(db.pool, { space: SPACE, user: PEER, role: "member", now });
  await seedSpaceMember(db.pool, { space: OTHER_SPACE, user: OUTSIDER, role: "owner", now });
  for (const [project, name] of [[PROJECT, "Research"], [OTHER_PROJECT, "Elsewhere"]] as const) {
    await db.pool.query(`INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,$4,'active',$5,$5)`,
      [project, SPACE, OWNER, name, now]);
    await seedProjectMainlineRoom(db.pool, { space: SPACE, project, owner: OWNER, title: name, now });
  }
  // MEMBER and ADMIN read the Project; only MEMBER is on the Room's roster; PEER reads neither.
  for (const user of [MEMBER, ADMIN]) {
    await db.pool.query(`INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,$4,'member','active',$5,$5)`,
      [randomUUID(), SPACE, PROJECT, user, now]);
  }
  for (const [folder, project] of [[FOLDER, PROJECT], [OTHER_FOLDER, OTHER_PROJECT]] as const) {
    await db.pool.query(`INSERT INTO project_folders (id, space_id, project_id, name, kind, status, protected, system_managed, created_at, updated_at)
      VALUES ($1,$2,$3,'repo','code','active',false,false,$4,$4)`, [folder, SPACE, project, now]);
  }
  await db.pool.query(`INSERT INTO rooms (id, space_id, project_id, created_by_user_id, title, status, created_at, updated_at, is_mainline)
    VALUES ($1,$2,$3,$4,'Limited','active',$5,$5,false)`, [ROOM, SPACE, PROJECT, OWNER, now]);
  await db.pool.query(`INSERT INTO room_user_members (id, space_id, room_id, user_id, role, status, created_at, updated_at)
    VALUES ($1,$3,$4,$5,'owner','active',$7,$7), ($2,$3,$4,$6,'member','active',$7,$7)`, [randomUUID(), randomUUID(), SPACE, ROOM, OWNER, MEMBER, now]);
  await db.pool.query(`INSERT INTO sessions (id, space_id, project_id, room_id, title, status, created_at, updated_at) VALUES ($1,$2,$3,$4,'Limited work','active',$5,$5)`,
    [SESSION, SPACE, PROJECT, ROOM, now]);
  await seedRun(db.pool, { id: RUN, space: SPACE, owner: OWNER, agent: AGENT, version: VERSION, now });
  // Shared with the whole Space by content ACL: only the Room, Project and Folder rules narrow it.
  await db.pool.query(`UPDATE runs SET session_id = $2, project_id = $3, project_folder_id = $4 WHERE id = $1`, [RUN, SESSION, PROJECT, FOLDER]);
  await db.pool.query(
    `INSERT INTO artifacts (id, space_id, run_id, owner_user_id, project_id, project_folder_id, artifact_type, title, content, metadata_json, export_formats_json, visibility, created_at, updated_at)
     VALUES ($1,$3,$4,$5,$6,$7,'markdown','Room artifact','Fixture body','{}'::jsonb,'[]'::jsonb,'space_shared',$8,$8),
            ($2,$3,$4,$5,$6,$7,'markdown','SECRET DEEP READ TITLE','Fixture body',$9::jsonb,'[]'::jsonb,'space_shared',$8,$8)`,
    [ARTIFACT, DEEP_READ_ARTIFACT, SPACE, RUN, OWNER, PROJECT, FOLDER, now, JSON.stringify({ deep_read: { project_id: PROJECT } })],
  );
  // A report packet without its report Artifact cannot be checked: its title is withheld from everyone.
  await db.pool.query(
    `INSERT INTO proposals (id, space_id, project_id, project_folder_id, proposal_type, status, risk_level, urgency, title, payload_json, visibility,
                            created_by_user_id, owner_user_id, created_by_run_id, created_at, updated_at)
     VALUES ($1,$3,$4,$5,'follow_up_task','pending','low','normal','Room proposal',$6::jsonb,'space_shared',$7,$7,$8,$9,$9),
            ($2,$3,$4,$5,'retrieval_maintenance_packet','pending','low','normal','SECRET REPORT TITLE','{}'::jsonb,'space_shared',$7,$7,$8,$9,$9)`,
    [PROPOSAL, REPORT_PROPOSAL, SPACE, PROJECT, FOLDER, JSON.stringify({ task: { title: "Follow up" } }), OWNER, RUN, now],
  );
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [runsModule, artifactsModule, proposalsModule]);
});

afterEach(() => {
  __setRunsIdentityForTests(null);
  __setArtifactIdentityForTests(null);
  __setProposalIdentityForTests(null);
});
afterAll(async () => { await app?.close(); });

async function read(path: string, spaceId: string, userId: string) {
  const identity = { spaceId, userId };
  __setRunsIdentityForTests(identity);
  __setArtifactIdentityForTests(identity);
  __setProposalIdentityForTests(identity);
  return app.inject({ method: "GET", url: path });
}

const RUN_ENTRIES = ["", "/trace", "/io", "/activities", "/artifacts", "/proposals"].map((suffix) => `/api/v1/runs/${RUN}${suffix}`);
const OBJECT_ENTRIES = [`/api/v1/artifacts/${ARTIFACT}`, `/api/v1/proposals/${PROPOSAL}`];

/** Whether every entry reads the Run and its objects, or every entry hides them. */
async function entriesFor(viewer: string, space = SPACE): Promise<"visible" | "hidden" | Record<string, number | boolean>> {
  const statuses: Record<string, number | boolean> = {};
  for (const path of [...RUN_ENTRIES, ...OBJECT_ENTRIES]) statuses[path] = (await read(path, space, viewer)).statusCode;
  const runList = await read(`/api/v1/runs?limit=200`, space, viewer);
  statuses.run_list = runList.statusCode === 200 && runList.json().some((run: { id: string }) => run.id === RUN);
  const artifacts = await read(`/api/v1/artifacts?run_id=${RUN}`, space, viewer);
  statuses.artifact_list = artifacts.statusCode === 200 && artifacts.json().items.some((item: { id: string }) => item.id === ARTIFACT);
  const proposals = await read(`/api/v1/proposals?created_by_run_id=${RUN}&status=pending`, space, viewer);
  statuses.proposal_list = proposals.statusCode === 200 && proposals.json().items.some((item: { id: string }) => item.id === PROPOSAL);
  const values = Object.values(statuses);
  if (values.every((value) => value === 200 || value === true)) return "visible";
  if (values.every((value) => value === 404 || value === false)) return "hidden";
  return statuses;
}

describe("one Room Run across every read entry (real Postgres)", () => {
  it("gives each viewer one answer on every entry before and after Room removal", async (ctx) => {
    if (!db.available) return ctx.skip();
    expect(await entriesFor(OWNER)).toBe("visible");
    expect(await entriesFor(MEMBER)).toBe("visible");
    // Oversight admits the admin to Space content; the Room roster still holds.
    expect(await entriesFor(ADMIN)).toBe("hidden");
    expect(await entriesFor(PEER)).toBe("hidden");
    expect(await entriesFor(OUTSIDER, OTHER_SPACE)).toBe("hidden");
    expect(await entriesFor(OUTSIDER, SPACE)).toBe("hidden");

    // Removal from the Room ends every entry at once; rejoining restores them.
    await db.pool.query(`UPDATE room_user_members SET status = 'removed' WHERE room_id = $1 AND user_id = $2`, [ROOM, MEMBER]);
    try {
      expect(await entriesFor(MEMBER)).toBe("hidden");
    } finally {
      await db.pool.query(`UPDATE room_user_members SET status = 'active' WHERE room_id = $1 AND user_id = $2`, [ROOM, MEMBER]);
    }
    expect(await entriesFor(MEMBER)).toBe("visible");
  });

  it("rechecks Project and Folder access on every entry", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A Room member who loses the Project loses the Room's Runs with it.
    await db.pool.query(`UPDATE project_members SET status = 'revoked' WHERE project_id = $1 AND user_id = $2`, [PROJECT, MEMBER]);
    try {
      expect(await entriesFor(MEMBER)).toBe("hidden");
    } finally {
      await db.pool.query(`UPDATE project_members SET status = 'active' WHERE project_id = $1 AND user_id = $2`, [PROJECT, MEMBER]);
    }
    expect(await entriesFor(MEMBER)).toBe("visible");

    // A Folder whose Project the member cannot read hides what is filed in it.
    for (const table of ["runs", "artifacts", "proposals"]) {
      await db.pool.query(`UPDATE ${table} SET project_folder_id = $1 WHERE space_id = $2 AND project_folder_id = $3`, [OTHER_FOLDER, SPACE, FOLDER]);
    }
    try {
      expect(await entriesFor(MEMBER)).toBe("hidden");
      expect(await entriesFor(OWNER)).toBe("visible");
    } finally {
      for (const table of ["runs", "artifacts", "proposals"]) {
        await db.pool.query(`UPDATE ${table} SET project_folder_id = $1 WHERE space_id = $2 AND project_folder_id = $3`, [FOLDER, SPACE, OTHER_FOLDER]);
      }
    }
    expect(await entriesFor(MEMBER)).toBe("visible");
  });

  it("lists on the trace exactly the Artifacts and Proposal fields their own collections release", async (ctx) => {
    if (!db.available) return ctx.skip();
    for (const viewer of [OWNER, MEMBER]) {
      const trace = await read(`/api/v1/runs/${RUN}/trace`, SPACE, viewer);
      expect(trace.statusCode, trace.body).toBe(200);
      const artifacts = (await read(`/api/v1/runs/${RUN}/artifacts`, SPACE, viewer)).json().items as Array<{ id: string; title: string }>;
      const proposals = (await read(`/api/v1/runs/${RUN}/proposals?status=all`, SPACE, viewer)).json().items as Array<{ id: string; proposed_title: string }>;
      const traced = trace.json() as { artifacts: Array<{ id: string; title: string }>; proposals: Array<{ id: string; title: string }> };
      expect(traced.artifacts.map(({ id, title }) => ({ id, title })).sort((a, b) => a.id.localeCompare(b.id)), viewer)
        .toEqual(artifacts.map(({ id, title }) => ({ id, title })).sort((a, b) => a.id.localeCompare(b.id)));
      expect(traced.proposals.map(({ id, title }) => ({ id, title })).sort((a, b) => a.id.localeCompare(b.id)), viewer)
        .toEqual(proposals.map(({ id, proposed_title }) => ({ id, title: proposed_title })).sort((a, b) => a.id.localeCompare(b.id)));
    }
    // The member does not own the deep-read Artifact, and nobody may read the unverifiable report title.
    const member = await read(`/api/v1/runs/${RUN}/trace`, SPACE, MEMBER);
    expect(member.body).not.toContain("SECRET DEEP READ TITLE");
    expect(member.body).not.toContain("SECRET REPORT TITLE");
  });
  it("returns all trace summaries in stable order across the former page boundary", async (ctx) => {
    if (!db.available) return ctx.skip();
    const suffixes = Array.from({ length: 201 }, (_, index) => String(index).padStart(3, "0"));
    const artifactIds = suffixes.map((suffix) => `${ARTIFACT}-${suffix}`);
    const proposalIds = suffixes.map((suffix) => `${PROPOSAL}-${suffix}`);
    try {
      await db.pool.query(
        `INSERT INTO artifacts (id, space_id, run_id, owner_user_id, project_id, project_folder_id,
                                artifact_type, title, export_formats_json, visibility, created_at, updated_at)
         SELECT id, $2, $3, $4, $5, $6, 'markdown', 'Trace fixture', '[]'::jsonb, 'space_shared', now(), now()
           FROM unnest($1::text[]) AS ids(id)`,
        [artifactIds, SPACE, RUN, OWNER, PROJECT, FOLDER],
      );
      await db.pool.query(
        `INSERT INTO proposals (id, space_id, project_id, project_folder_id, proposal_type, status,
                                 risk_level, urgency, title, payload_json, visibility,
                                 created_by_user_id, owner_user_id, created_by_run_id, created_at, updated_at)
         SELECT id, $2, $3, $4, 'follow_up_task', 'pending', 'low', 'normal', 'Trace fixture',
                '{}'::jsonb, 'space_shared', $5, $5, $6, now(), now()
           FROM unnest($1::text[]) AS ids(id)`,
        [proposalIds, SPACE, PROJECT, FOLDER, OWNER, RUN],
      );
      const trace = await read(`/api/v1/runs/${RUN}/trace`, SPACE, MEMBER);
      expect(trace.statusCode, trace.body).toBe(200);
      const { artifacts, proposals } = trace.json() as {
        artifacts: Array<{ id: string }>;
        proposals: Array<{ id: string }>;
      };
      expect(artifacts.map(({ id }) => id)).toEqual([ARTIFACT, ...artifactIds]);
      expect(proposals.map(({ id }) => id)).toEqual([PROPOSAL, REPORT_PROPOSAL, ...proposalIds]);
    } finally {
      await db.pool.query("DELETE FROM proposals WHERE space_id = $1 AND id = ANY($2::text[])", [SPACE, proposalIds]);
      await db.pool.query("DELETE FROM artifacts WHERE space_id = $1 AND id = ANY($2::text[])", [SPACE, artifactIds]);
    }
  });
});
