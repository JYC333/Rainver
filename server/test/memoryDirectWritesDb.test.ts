import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { PgMemoryReadRepository } from "../src/modules/memory/repository.js";
import { PgMemoryApplyRepository, type ApplyProposal } from "../src/modules/memory/memoryApplyRepository.js";
import { withQueryableTransaction } from "../src/modules/routeUtils/common.js";
import { loadConfig } from "../src/config.js";
import { getProjectUpdates } from "../src/modules/projectWork/updatesReadModel.js";
import { undoProjectUpdate } from "../src/modules/projectWork/updateUndo.js";
import { SystemActionDispatcher } from "../src/modules/systemActions/systemActionDispatcher.js";
import { ProjectAttentionService } from "../src/modules/projects/attentionService.js";
import { registerMemoryProjectIntegration } from "../src/modules/memory/projectIntegration.js";
import type { RuntimeHostExecuteRequest } from "@rainver/protocol";

// Real-Postgres coverage for the memory write an Agent makes on its own
// (ADR 0003 §2). Before this existed the Agent had no memory write at all —
// the proposal flow was the only route and nothing ever took it — so these
// cases are as much about "it writes" as about where it stops: reach stays
// with the person, and the write is visible and reversible afterwards.

const SPACE = "31111111-1111-4111-8111-111111111111";
const OWNER = "3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "3fffffff-ffff-4fff-8fff-ffffffffffff";
const AGENT_ID = "3bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_VERSION_ID = "3ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN_ID = "3ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SESSION_ID = "3eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const db = useTestDatabase(import.meta.filename);

let PROJECT: string;

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["provenance_links", "memory_relations", "memory_entries", "project_work_events", "actors", "proposals", "runs", "sessions", "agent_versions", "agents", "space_objects", "projects", "project_members", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  for (const [id, name] of [[OWNER, "Owner"], [OTHER, "Other"]] as const) {
    await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, $2, 'active', $3, $3)`, [id, name, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'active', $5, $5)`,
      [randomUUID(), SPACE, id, id === OWNER ? "owner" : "member", now],
    );
  }
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
     VALUES ($1, $2, $3, 'Room Agent', 'active', NULL, $4, $4, 'space_shared')`,
    [AGENT_ID, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions
       (id, agent_id, space_id, version_label, system_prompt, model_config_json, runtime_config_json,
        context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json, runtime_policy_json, created_at)
     VALUES ($1, $2, $3, 'v1', 'Test', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
    [AGENT_VERSION_ID, AGENT_ID, SPACE, now],
  );
  await db.pool.query("UPDATE agents SET current_version_id = $2 WHERE id = $1", [AGENT_ID, AGENT_VERSION_ID]);
  const project = await new PgProjectRepository(db.pool).create({ spaceId: SPACE, userId: OWNER }, { name: "Memory Project" });
  PROJECT = project.id as string;
  await db.pool.query(
    `INSERT INTO sessions (id, space_id, user_id, project_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'active',$5,$5)`,
    [SESSION_ID, SPACE, OWNER, PROJECT, now],
  );
  await db.pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, created_at, updated_at, owner_user_id, visibility, access_level, project_id, instructed_by_user_id, session_id)
     VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',$5,$5,$6,'private','full',$7,$6,$8)`,
    [RUN_ID, SPACE, AGENT_ID, AGENT_VERSION_ID, now, OWNER, PROJECT, SESSION_ID],
  );
  await db.pool.query(
    `UPDATE runs SET permission_snapshot_json = $2::jsonb WHERE id = $1 AND space_id = $3`,
    [RUN_ID, JSON.stringify({ tool_grants: [{ action_id: "memory.remember" }, { action_id: "memory.revise" }] }), SPACE],
  );
  registerMemoryProjectIntegration(3);
});

const ownerIdentity = () => ({ spaceId: SPACE, userId: OWNER });

/** What the person does from the Review page — `applyOnly` runs inside the accept transaction. */
async function acceptProposal(proposal: ApplyProposal) {
  return withQueryableTransaction(db.pool, (tx) => new PgMemoryApplyRepository(tx).applyOnly(proposal, OWNER));
}

async function dispatcher(overrides: Record<string, unknown> = {}) {
  const run = await new PgRunRepository(db.pool).getRun(SPACE, RUN_ID);
  if (!run) throw new Error("Test Run was not created");
  return SystemActionDispatcher.create(
    loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_MEMORY_DIRECT_WRITES_PER_SESSION: "3" }),
    { ...run, ...overrides },
    {} as RuntimeHostExecuteRequest,
  );
}

function remember(args: Record<string, unknown>, id = "remember-1") {
  return { id, name: "memory.remember", arguments_json: JSON.stringify({ rationale: "The person said so", ...args }) };
}

async function memoryRows() {
  const rows = await db.pool.query<{
    id: string; content: string; status: string; created_by: string; approved_by: string | null;
    created_from_proposal_id: string | null; supersedes_memory_id: string | null; visibility: string;
  }>(
    `SELECT id, content, status, created_by, approved_by, created_from_proposal_id, supersedes_memory_id, visibility
       FROM memory_entries WHERE space_id=$1 ORDER BY created_at ASC`,
    [SPACE],
  );
  return rows.rows;
}

describe("memory.remember / memory.revise, direct (real Postgres)", () => {
  it("writes the memory in the turn, attributed to the Agent and approved by nobody", async () => {
    if (!db.available) return;
    const result = await (await dispatcher()).dispatch(remember({ content: "Prefers morning meetings" }));
    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ ok: true, outcome: "remembered" });

    const rows = await memoryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      content: "Prefers morning meetings",
      status: "active",
      created_by: `agent:${AGENT_ID}`,
      // Saying a person approved it would be a false record, and the whole
      // point of §2 is that nobody did.
      approved_by: null,
      created_from_proposal_id: null,
      visibility: "private",
    });
    expect(await db.pool.query(`SELECT id FROM proposals WHERE space_id=$1`, [SPACE])).toMatchObject({ rows: [] });

    // Why it is there, readable without a proposal to read.
    const versions = await new PgMemoryReadRepository(db.pool).versions(SPACE, OWNER, rows[0]!.id);
    expect(versions.items).toHaveLength(1);
    expect(versions.items[0]).toMatchObject({
      written_by_agent_id: AGENT_ID,
      run_id: RUN_ID,
      session_id: SESSION_ID,
      rationale: "The person said so",
    });
  });

  it("shows the write in the Project's updates and archives it in one action", async () => {
    if (!db.available) return;
    await (await dispatcher()).dispatch(remember({ content: "Prefers morning meetings", title: "Meeting times" }));
    const rows = await memoryRows();

    const updates = await getProjectUpdates(db.pool, ownerIdentity(), PROJECT, null);
    const written = updates.items.find((item) => item.event_kind === "memory.remembered");
    expect(written).toMatchObject({
      summary: "Meeting times",
      subject: { type: "memory_entry", id: rows[0]!.id },
      undo: { action: "archive_memory", target_id: rows[0]!.id },
      actor: { kind: "agent", id: AGENT_ID },
    });

    await undoProjectUpdate(db.pool, ownerIdentity(), PROJECT, written!.id);
    expect((await memoryRows())[0]).toMatchObject({ status: "archived" });
    // Reversing is itself a row, and the reversed one offers no second undo.
    const after = await getProjectUpdates(db.pool, ownerIdentity(), PROJECT, null);
    expect(after.items.find((item) => item.id === written!.id)?.undo).toBeNull();
    expect(after.items.some((item) => item.event_kind === "memory.archived")).toBe(true);
  });

  it("routes a write that widens reach to the person instead of failing", async () => {
    if (!db.available) return;
    const result = await (await dispatcher()).dispatch(
      remember({ content: "The team agreed on Thursdays", visibility: "space_shared" }),
    );
    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ ok: true, outcome: "proposed" });
    // Nothing stored, and one thing waiting.
    expect(await memoryRows()).toHaveLength(0);
    const proposals = await db.pool.query<ApplyProposal & { created_by_agent_id: string | null }>(
      `SELECT id, space_id, proposal_type, status, title, payload_json, project_folder_id,
              created_by_user_id, created_by_agent_id, created_by_run_id, project_id
         FROM proposals WHERE space_id=$1`,
      [SPACE],
    );
    expect(proposals.rows).toHaveLength(1);
    const proposal = proposals.rows[0]!;
    expect(proposal.proposal_type).toBe("memory_create");
    // Recorded as the Agent's, with what it said. Stamping it as the person's
    // confirmation would be the same false record `approved_by = null` avoids
    // on the direct path.
    expect(proposal.created_by_agent_id).toBe(AGENT_ID);
    expect(JSON.stringify(proposal.payload_json)).toContain("The person said so");

    // A proposal that cannot be applied is not "waiting for the person", it
    // is lost — and asserting only that a row exists would not notice.
    const applied = await acceptProposal(proposal);
    expect(applied.memoryId).toBeTruthy();
    const rows = await memoryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ visibility: "space_shared" });
  });

  it("refuses to promise shared memory where no Project can hold it", async () => {
    if (!db.available) return;
    const run = await new PgRunRepository(db.pool).getRun(SPACE, RUN_ID);
    const dispatch = await SystemActionDispatcher.create(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      { ...run!, project_id: null },
      {} as RuntimeHostExecuteRequest,
    );
    const result = await dispatch.dispatch(
      remember({ content: "The team agreed on Thursdays", visibility: "space_shared" }),
    );
    // Better a refusal the Agent can act on than a pending proposal that
    // would fail forever at apply: a user-scoped entry may not be shared, and
    // a project-scoped one needs a Project.
    expect(result.modelResult).toMatchObject({ ok: false });
    expect(JSON.stringify(result.modelResult)).toContain("Project");
    expect(await db.pool.query(`SELECT id FROM proposals WHERE space_id=$1`, [SPACE])).toMatchObject({ rows: [] });
  });

  it("revises what it wrote as a new version, keeping the old one readable", async () => {
    if (!db.available) return;
    const dispatch = await dispatcher();
    await dispatch.dispatch(remember({ content: "Prefers morning meetings" }));
    const first = (await memoryRows())[0]!;
    const revised = await dispatch.dispatch({
      id: "revise-1",
      name: "memory.revise",
      arguments_json: JSON.stringify({
        memory_id: first.id,
        content: "Prefers mornings, except Fridays",
        rationale: "They corrected me",
      }),
    });
    expect(revised.modelResult, JSON.stringify(revised.modelResult)).toMatchObject({ ok: true, outcome: "revised" });

    const rows = await memoryRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: first.id, status: "superseded" });
    expect(rows[1]).toMatchObject({ content: "Prefers mornings, except Fridays", supersedes_memory_id: first.id });
    // Both versions, with what was said each time — and numbered, since the
    // number is most of what identifies a version where the chain is shown.
    const versions = await new PgMemoryReadRepository(db.pool).versions(SPACE, OWNER, rows[1]!.id);
    expect(versions.items.map((item) => item.rationale)).toEqual(["The person said so", "They corrected me"]);
    expect(versions.items.map((item) => item.memory.version)).toEqual([1, 2]);
  });

  it("asks the person before rewriting an entry it did not write itself", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const write = async (createdBy: string, content: string) => {
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
           subject_user_id, owner_user_id, sensitivity_level, access_level, namespace, title, visibility,
           confidence, importance, created_by, version, access_count)
         VALUES ($1,$2,'user','semantic',$3,'active',$4,$4,$5,$5,'normal','full','user.default','Mine','private',1.0,0.5,$6,1,0)`,
        [id, SPACE, content, now, OWNER, createdBy],
      );
      return id;
    };
    // Both are the person's own private entry — the four reach checks pass —
    // and both take the same route for the same reason: ADR 0003 §2 lets an
    // Agent revise what *it* wrote. What differs is what the Agent is told,
    // which is the only reason these are two cases and not one.
    const byPerson = await write(OWNER, "I wrote this myself");
    const byAnotherAgent = await write("agent:39999999-9999-4999-8999-999999999999", "Another Agent said so");
    const dispatch = await dispatcher();

    const revise = (memoryId: string, id: string) => dispatch.dispatch({
      id,
      name: "memory.revise",
      arguments_json: JSON.stringify({ memory_id: memoryId, content: "Let me fix that", rationale: "It looked wrong" }),
    });

    const person = await revise(byPerson, "revise-user");
    expect(person.modelResult, JSON.stringify(person.modelResult)).toMatchObject({ ok: true, outcome: "proposed" });
    expect(JSON.stringify(person.modelResult)).toContain("something a person wrote");

    const agent = await revise(byAnotherAgent, "revise-other-agent");
    expect(agent.modelResult, JSON.stringify(agent.modelResult)).toMatchObject({ ok: true, outcome: "proposed" });
    expect(JSON.stringify(agent.modelResult)).toContain("another Agent wrote");

    // Neither original moved until the person says so.
    const rows = await memoryRows();
    expect(rows.map((row) => row.content).sort()).toEqual(["Another Agent said so", "I wrote this myself"]);
    expect(rows.every((row) => row.status === "active")).toBe(true);
  });

  it("puts the paused turn in front of the person when the conversation has no session", async () => {
    if (!db.available) return;
    const run = await new PgRunRepository(db.pool).getRun(SPACE, RUN_ID);
    // A group with no Room carries no session (`agentGroups/service.ts`
    // refuses one), which is exactly where the breaker counts per Run.
    const sessionless = await SystemActionDispatcher.create(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_MEMORY_DIRECT_WRITES_PER_SESSION: "3" }),
      { ...run!, session_id: null },
      {} as RuntimeHostExecuteRequest,
    );
    for (let index = 0; index < 3; index += 1) {
      expect((await sessionless.dispatch(remember({ content: `Turn ${index}` }, `s-${index}`))).modelResult)
        .toMatchObject({ ok: true });
    }
    expect((await sessionless.dispatch(remember({ content: "Turn 4" }, "s-4"))).modelResult)
      .toMatchObject({ ok: false });

    // A pause nobody can see is not the fault report the ADR asks for.
    const attention = await new ProjectAttentionService(db.pool).listAttentionItems(ownerIdentity(), PROJECT);
    const paused = attention.find((item) => item.source_type === "memory_session");
    expect(paused).toMatchObject({ attention_class: "uncertain", source_id: RUN_ID });
    expect(paused?.href).toBe(`/memory?run=${RUN_ID}`);
    expect(String(paused?.title)).toContain("One turn");
  });

  it("pauses a session that keeps writing, and puts one item in front of the person", async () => {
    if (!db.available) return;
    const dispatch = await dispatcher();
    for (let index = 0; index < 3; index += 1) {
      const written = await dispatch.dispatch(remember({ content: `Fact ${index}` }, `remember-${index}`));
      expect(written.modelResult, JSON.stringify(written.modelResult)).toMatchObject({ ok: true });
    }
    const refused = await dispatch.dispatch(remember({ content: "Fact 4" }, "remember-4"));
    expect(refused.modelResult).toMatchObject({ ok: false });
    expect(JSON.stringify(refused.modelResult)).toContain("paused");
    expect(await memoryRows()).toHaveLength(3);

    // Not a queue to approve — a fault to look at.
    const attention = await new ProjectAttentionService(db.pool).listAttentionItems(ownerIdentity(), PROJECT);
    const paused = attention.find((item) => item.source_type === "memory_session");
    expect(paused).toMatchObject({ attention_class: "uncertain", source_id: SESSION_ID });
    expect(paused?.href).toContain(SESSION_ID);
  });

  it("keeps writing by proposal for an Agent whose policy says so", async () => {
    if (!db.available) return;
    await db.pool.query(
      `UPDATE agent_versions SET memory_policy_json = '{"requires_proposal": true}'::jsonb WHERE id = $1`,
      [AGENT_VERSION_ID],
    );
    const result = await (await dispatcher()).dispatch(remember({ content: "Prefers morning meetings" }));
    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ ok: true, outcome: "proposed" });
    expect(await memoryRows()).toHaveLength(0);

    // The flag restores the old gate for that Agent; it must not quietly
    // disable memory by producing proposals nobody can accept.
    const proposal = await db.pool.query<ApplyProposal>(
      `SELECT id, space_id, proposal_type, title, payload_json, project_folder_id,
              created_by_user_id, created_by_agent_id, created_by_run_id, project_id
         FROM proposals WHERE space_id=$1`,
      [SPACE],
    );
    await acceptProposal(proposal.rows[0]!);
    expect(await memoryRows()).toHaveLength(1);
  });

  it("will not revise someone else's memory, whoever wrote it", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const theirs = randomUUID();
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
         subject_user_id, owner_user_id, sensitivity_level, access_level, namespace, title, visibility,
         confidence, importance, created_by, version, access_count)
       VALUES ($1,$2,'user','semantic','Theirs','active',$3,$3,NULL,$4,'normal','full','user.default','Theirs','private',1.0,0.5,$5,1,0)`,
      // Written by an Agent and carrying no subject: the reach checks alone
      // would wave this through, so ownership is what has to stop it.
      [theirs, SPACE, now, OTHER, `agent:${AGENT_ID}`],
    );
    const result = await (await dispatcher()).dispatch({
      id: "revise-theirs",
      name: "memory.revise",
      arguments_json: JSON.stringify({ memory_id: theirs, content: "Mine now", rationale: "Because" }),
    });
    // Refused outright, and not even as a proposal: proposing a revision of
    // an entry the person cannot see would itself disclose that it exists.
    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ ok: false });
    expect(await db.pool.query(`SELECT id FROM proposals WHERE space_id=$1`, [SPACE])).toMatchObject({ rows: [] });
    const rows = await db.pool.query<{ id: string; owner_user_id: string; status: string; content: string }>(
      `SELECT id, owner_user_id, status, content FROM memory_entries WHERE space_id=$1`, [SPACE],
    );
    // Untouched: still theirs, still active, still what they had.
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ id: theirs, owner_user_id: OTHER, status: "active", content: "Theirs" });
  });

  it("counts the proposal branch against the same bound", async () => {
    if (!db.available) return;
    await db.pool.query(
      `UPDATE agent_versions SET memory_policy_json = '{"requires_proposal": true}'::jsonb WHERE id = $1`,
      [AGENT_VERSION_ID],
    );
    const dispatch = await dispatcher();
    for (let index = 0; index < 3; index += 1) {
      expect((await dispatch.dispatch(remember({ content: `Fact ${index}` }, `p-${index}`))).modelResult)
        .toMatchObject({ ok: true, outcome: "proposed" });
    }
    // A loop that produces proposals instead of entries is the queue nobody
    // reads, which is exactly what the breaker exists to stop.
    const refused = await dispatch.dispatch(remember({ content: "Fact 4" }, "p-4"));
    expect(refused.modelResult).toMatchObject({ ok: false });
    expect(JSON.stringify(refused.modelResult)).toContain("paused");
  });

  it("lets an over-eager session write again once the person archives what it wrote", async () => {
    if (!db.available) return;
    const dispatch = await dispatcher();
    for (let index = 0; index < 3; index += 1) {
      await dispatch.dispatch(remember({ content: `Fact ${index}` }, `r-${index}`));
    }
    expect((await dispatch.dispatch(remember({ content: "Fact 4" }, "r-4"))).modelResult)
      .toMatchObject({ ok: false });

    const rows = await memoryRows();
    await new PgMemoryApplyRepository(db.pool).setOwnStatus(SPACE, OWNER, rows[0]!.id, "archived");
    // Dealing with the fault is the reset; there is no other one.
    expect((await dispatch.dispatch(remember({ content: "Fact 5" }, "r-5"))).modelResult)
      .toMatchObject({ ok: true, outcome: "remembered" });
  });

  it("raises the attention item for a session that worked across two Projects", async () => {
    if (!db.available) return;
    const second = await new PgProjectRepository(db.pool).create({ spaceId: SPACE, userId: OWNER }, { name: "Second" });
    const now = new Date().toISOString();
    const secondRun = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, created_at, updated_at, owner_user_id, visibility, access_level, project_id, instructed_by_user_id, session_id, permission_snapshot_json)
       VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',$5,$5,$6,'private','full',$7,$6,$8,$9::jsonb)`,
      [secondRun, SPACE, AGENT_ID, AGENT_VERSION_ID, now, OWNER, second.id, SESSION_ID,
        JSON.stringify({ tool_grants: [{ action_id: "memory.remember" }] })],
    );
    const run = await new PgRunRepository(db.pool).getRun(SPACE, RUN_ID);
    const first = await dispatcher();
    const other = await SystemActionDispatcher.create(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_MEMORY_DIRECT_WRITES_PER_SESSION: "3" }),
      { ...run!, id: secondRun, project_id: second.id as string },
      {} as RuntimeHostExecuteRequest,
    );
    await first.dispatch(remember({ content: "A" }, "split-a"));
    await other.dispatch(remember({ content: "B" }, "split-b"));
    await other.dispatch(remember({ content: "C" }, "split-c"));
    // Three writes in one session, split 1/2 across Projects: the session is
    // paused, so it must be visible somewhere rather than in neither.
    expect((await first.dispatch(remember({ content: "D" }, "split-d"))).modelResult).toMatchObject({ ok: false });

    const attention = new ProjectAttentionService(db.pool);
    const inFirst = await attention.listAttentionItems(ownerIdentity(), PROJECT);
    const inSecond = await attention.listAttentionItems(ownerIdentity(), second.id as string);
    expect(inFirst.find((item) => item.source_type === "memory_session")).toMatchObject({ source_id: SESSION_ID });
    expect(inSecond.find((item) => item.source_type === "memory_session")).toMatchObject({ source_id: SESSION_ID });
  });
});

describe("a person's own archive and restore (real Postgres)", () => {
  // ADR 0003 §3. The proposal that used to stand here was the person queueing
  // a request to themselves; someone else's entry still goes through one.
  async function ownMemory(owner: string) {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
         subject_user_id, owner_user_id, sensitivity_level, access_level, namespace, title, visibility,
         confidence, importance, created_by, version, access_count)
       VALUES ($1,$2,'user','semantic','Mine','active',$3,$3,$4,$4,'normal','full','user.default','Mine','private',1.0,0.5,$4,1,0)`,
      [id, SPACE, now, owner],
    );
    return id;
  }

  it("archives and restores in one step, and refuses the second archive", async () => {
    if (!db.available) return;
    const repository = new PgMemoryApplyRepository(db.pool);
    const id = await ownMemory(OWNER);

    expect(await repository.setOwnStatus(SPACE, OWNER, id, "archived")).toMatchObject({ status: "archived" });
    // Archiving what is already archived is a stale page, not a new decision.
    await expect(repository.setOwnStatus(SPACE, OWNER, id, "archived")).rejects.toThrow(/archived/);
    expect(await repository.setOwnStatus(SPACE, OWNER, id, "active")).toMatchObject({ status: "active" });
  });

  it("does not touch someone else's memory, so the route falls back to a proposal", async () => {
    if (!db.available) return;
    const repository = new PgMemoryApplyRepository(db.pool);
    // Owned by them, authored by us: authorship is not ownership, and a
    // `space_shared` entry has no owner at all — those are exactly the
    // entries other people read, so archiving one is a reach change and
    // belongs on the proposal path.
    const id = await ownMemory(OTHER);
    await db.pool.query(`UPDATE memory_entries SET created_by = $2 WHERE id = $1`, [id, OWNER]);
    expect(await repository.setOwnStatus(SPACE, OWNER, id, "archived")).toBeNull();
    const row = await db.pool.query<{ status: string }>(`SELECT status FROM memory_entries WHERE id=$1`, [id]);
    expect(row.rows[0]).toMatchObject({ status: "active" });
  });

  it("restores the version a revision replaced, but only once the newer one is out of the way", async () => {
    if (!db.available) return;
    const dispatch = await dispatcher();
    await dispatch.dispatch(remember({ content: "First" }));
    const first = (await memoryRows())[0]!;
    await dispatch.dispatch({
      id: "revise-head",
      name: "memory.revise",
      arguments_json: JSON.stringify({ memory_id: first.id, content: "Second", rationale: "Corrected" }),
    });
    const head = (await memoryRows())[1]!;
    const repository = new PgMemoryApplyRepository(db.pool);

    // Two active rows on one chain have no answer to "which one is it".
    await expect(repository.setOwnStatus(SPACE, OWNER, first.id, "active")).rejects.toThrow(/newer version/);

    // ADR 0003 §2's "one action restores it": archive what the Agent wrote,
    // then put back what it replaced.
    await repository.setOwnStatus(SPACE, OWNER, head.id, "archived");
    expect(await repository.setOwnStatus(SPACE, OWNER, first.id, "active")).toMatchObject({ status: "active" });
    const rows = await memoryRows();
    expect(rows.filter((row) => row.status === "active").map((row) => row.content)).toEqual(["First"]);
  });

  it("keeps one active version however the restores are ordered", async () => {
    if (!db.available) return;
    const dispatch = await dispatcher();
    await dispatch.dispatch(remember({ content: "First" }));
    const first = (await memoryRows())[0]!;
    await dispatch.dispatch({
      id: "revise-order",
      name: "memory.revise",
      arguments_json: JSON.stringify({ memory_id: first.id, content: "Second", rationale: "Corrected" }),
    });
    const head = (await memoryRows())[1]!;
    const repository = new PgMemoryApplyRepository(db.pool);

    await repository.setOwnStatus(SPACE, OWNER, head.id, "archived");
    await repository.setOwnStatus(SPACE, OWNER, first.id, "active");
    // Restoring the archived head now would put two live rows on one chain by
    // a route that never asked.
    await expect(repository.setOwnStatus(SPACE, OWNER, head.id, "active")).rejects.toThrow(/newer version|active/);
    const rows = await memoryRows();
    expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
  });

  it("stops offering an undo once a later version replaced the memory", async () => {
    if (!db.available) return;
    const dispatch = await dispatcher();
    await dispatch.dispatch(remember({ content: "First", title: "Fact" }));
    const first = (await memoryRows())[0]!;
    await dispatch.dispatch({
      id: "revise-undo",
      name: "memory.revise",
      arguments_json: JSON.stringify({ memory_id: first.id, content: "Second", rationale: "Corrected" }),
    });

    const updates = await getProjectUpdates(db.pool, ownerIdentity(), PROJECT, null);
    const remembered = updates.items.find((item) => item.event_kind === "memory.remembered")!;
    const revised = updates.items.find((item) => item.event_kind === "memory.revised")!;
    // Archiving is what undo means here and only the head can be archived, so
    // the older row must not offer a button that can only fail.
    expect(remembered.undo).toBeNull();
    expect(revised.undo).toMatchObject({ action: "archive_memory" });
    await undoProjectUpdate(db.pool, ownerIdentity(), PROJECT, revised.id);
    expect((await memoryRows()).filter((row) => row.status === "active")).toHaveLength(0);
  });

  it("counts each person's own writes, so one member of a Room cannot spend another's budget", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    const theirRun = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, created_at, updated_at, owner_user_id, visibility, access_level, project_id, instructed_by_user_id, session_id, permission_snapshot_json)
       VALUES ($1,$2,$3,$4,'agent','manual','succeeded','live',$5,$5,$6,'private','full',$7,$6,$8,$9::jsonb)`,
      [theirRun, SPACE, AGENT_ID, AGENT_VERSION_ID, now, OTHER, PROJECT, SESSION_ID,
        JSON.stringify({ tool_grants: [{ action_id: "memory.remember" }] })],
    );
    const run = await new PgRunRepository(db.pool).getRun(SPACE, RUN_ID);
    // The other member's turns in the same Room conversation: same session id,
    // a different person.
    const theirs = await SystemActionDispatcher.create(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_MEMORY_DIRECT_WRITES_PER_SESSION: "3" }),
      { ...run!, id: theirRun, owner_user_id: OTHER, instructed_by_user_id: OTHER },
      {} as RuntimeHostExecuteRequest,
    );
    for (let index = 0; index < 3; index += 1) {
      expect((await theirs.dispatch(remember({ content: `Theirs ${index}` }, `t-${index}`))).modelResult)
        .toMatchObject({ ok: true });
    }
    // Their budget is spent; ours is not — and it must be ours, because the
    // only reset is archiving, which only the owner of those rows can do.
    expect((await theirs.dispatch(remember({ content: "Theirs 4" }, "t-4"))).modelResult).toMatchObject({ ok: false });
    expect((await (await dispatcher()).dispatch(remember({ content: "Ours" }, "ours-1"))).modelResult)
      .toMatchObject({ ok: true, outcome: "remembered" });
  });
});
