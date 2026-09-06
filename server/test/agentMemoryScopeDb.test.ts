import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { SystemActionDispatcher } from "../src/modules/systemActions/systemActionDispatcher.js";
import { listAgentMemoryForDispatch } from "../src/modules/memory/agentMemoryDelivery.js";
import { decidePersonaWrite, PgMemoryApplyRepository } from "../src/modules/memory/memoryApplyRepository.js";
import { loadConfig } from "../src/config.js";
import { PgProposalApplyService } from "../src/modules/proposals/applyService.js";
import { PgMemoryProposalRepository } from "../src/modules/memory/proposalRepository.js";
import { PgMemoryReadRepository } from "../src/modules/memory/repository.js";
import { memoryRetrievalAdapter } from "../src/modules/memory/retrievalAdapter.js";
import { registerMemoryProjectIntegration } from "../src/modules/memory/projectIntegration.js";
import { getProjectUpdates } from "../src/modules/projectWork/updatesReadModel.js";
import { undoProjectUpdate } from "../src/modules/projectWork/updateUndo.js";
import { loadProjectChatActionPreviews } from "../src/modules/agents/projectChatActionPreviews.js";
import { renderAgentIdentityPrompt } from "../src/modules/agentGroups/agentIdentityPrompt.js";
import { PgSessionRepository } from "../src/modules/sessions/repository.js";
import {
  MemoryProposalCreateCommandSchema,
  MemoryProposalUpdateCommandSchema,
  type RuntimeHostExecuteRequest,
} from "@rainver/protocol";

/**
 * The `agent` Memory scope: what an Agent knows about itself and about a Room
 * ([ADR 0003](../../.agent/decisions/0003-memory-proposal-flow.md) §4, §5).
 *
 * Two questions run through all of it. Who owns the entry — the Agent, with
 * its owner as the person who archives and reviews — and who may receive it,
 * which for a note is decided at dispatch against the Rooms' current rosters
 * and for a persona is everyone.
 */

const SPACE = "41111111-1111-4111-8111-111111111111";
const OWNER = "4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "4fffffff-ffff-4fff-8fff-ffffffffffff";
const OUTSIDER = "48888888-8888-4888-8888-888888888888";
const AGENT_ID = "4bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_VERSION_ID = "4ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN_ID = "4ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SESSION_ID = "4eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const db = useTestDatabase(import.meta.filename);
let PROJECT = "";
let MAINLINE = "";

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["provenance_links", "memory_relations", "memory_entries", "activity_records", "project_work_events", "actors", "proposals",
      "runs", "sessions", "room_user_members", "room_agent_members", "rooms", "agent_versions", "agents",
      "space_objects", "projects", "project_members", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  for (const [id, name, role] of [[OWNER, "Owner", "owner"], [MEMBER, "Member", "member"], [OUTSIDER, "Outsider", "member"]] as const) {
    await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, $2, 'active', $3, $3)`, [id, name, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,$4,'active',$5,$5)`,
      [randomUUID(), SPACE, id, role, now],
    );
  }
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
     VALUES ($1, $2, $3, 'Specialist', 'active', NULL, $4, $4, 'space_shared')`,
    [AGENT_ID, SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO agent_versions
       (id, agent_id, space_id, version_label, system_prompt, model_config_json, runtime_config_json,
        context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json, runtime_policy_json, created_at)
     VALUES ($1,$2,$3,'v1','Test','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$4)`,
    [AGENT_VERSION_ID, AGENT_ID, SPACE, now],
  );
  await db.pool.query("UPDATE agents SET current_version_id = $2 WHERE id = $1", [AGENT_ID, AGENT_VERSION_ID]);
  PROJECT = (await new PgProjectRepository(db.pool).create({ spaceId: SPACE, userId: OWNER }, { name: "Agent Memory" })).id as string;
  MAINLINE = (await db.pool.query<{ id: string }>(
    `SELECT id FROM rooms WHERE space_id = $1 AND project_id = $2 AND is_mainline = true LIMIT 1`, [SPACE, PROJECT],
  )).rows[0]!.id;
  // Everyone here reads the Project: a Room's audience is its roster
  // *intersected with* Project readability, and a mainline's is every Project
  // reader, so a seat alone would not make someone part of an audience.
  for (const userId of [MEMBER, OUTSIDER]) await joinProject(userId);
  await seatRoom(MAINLINE, [OWNER, MEMBER]);
  await db.pool.query(
    `INSERT INTO sessions (id, space_id, project_id, room_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'active',$5,$5)`,
    [SESSION_ID, SPACE, PROJECT, MAINLINE, now],
  );
  await db.pool.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
                       created_at, updated_at, owner_user_id, visibility, instructed_by_user_id, project_id, session_id)
     VALUES ($1,$2,$3,$4,'agent','manual','running','live',$5,$5,$6,'private',$6,$7,$8)`,
    [RUN_ID, SPACE, AGENT_ID, AGENT_VERSION_ID, now, OWNER, PROJECT, SESSION_ID],
  );
  await db.pool.query(
    `UPDATE runs SET permission_snapshot_json = $2::jsonb WHERE id = $1 AND space_id = $3`,
    [RUN_ID, JSON.stringify({ tool_grants: [{ action_id: "memory.remember" }, { action_id: "memory.revise" }] }), SPACE],
  );
  registerMemoryProjectIntegration(3);
});

async function joinProject(userId: string): Promise<void> {
  await db.pool.query(
    `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'member','active',now(),now())
     ON CONFLICT DO NOTHING`,
    [randomUUID(), SPACE, PROJECT, userId],
  );
}

async function seatRoom(roomId: string, userIds: readonly string[]): Promise<void> {
  for (const userId of userIds) {
    await db.pool.query(
      `INSERT INTO room_user_members (id, space_id, room_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'active',now(),now())
       ON CONFLICT (room_id, user_id) DO UPDATE SET status = 'active'`,
      [randomUUID(), SPACE, roomId, userId, userId === OWNER ? "owner" : "member"],
    );
  }
}

async function makeRoom(title: string, userIds: readonly string[]): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO rooms (id, space_id, project_id, title, is_mainline, status, created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,false,'active',$5,now(),now())`,
    [id, SPACE, PROJECT, title, OWNER],
  );
  await seatRoom(id, userIds);
  return id;
}

const ownerIdentity = () => ({ spaceId: SPACE, userId: OWNER });

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
  return { id, name: "memory.remember", arguments_json: JSON.stringify({ rationale: "Worth keeping", ...args }) };
}

async function agentRows() {
  return (await db.pool.query<{
    id: string; memory_type: string; scope_type: string; agent_id: string | null;
    owner_user_id: string | null; origin_room_id: string | null; project_id: string | null;
    subject_user_id: string | null; status: string; content: string;
  }>(
    `SELECT id, memory_type, scope_type, agent_id, owner_user_id, origin_room_id, project_id,
            subject_user_id, status, content
       FROM memory_entries WHERE space_id = $1 ORDER BY created_at ASC`,
    [SPACE],
  )).rows;
}

describe("what an Agent records about itself and its Room", () => {
  it("enforces the Agent scope shape and same-Space reference in Postgres", async () => {
    if (!db.available) return;
    const otherSpace = randomUUID();
    const otherAgent = randomUUID();
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_at, updated_at)
       VALUES ($1, 'Other', 'personal', now(), now())`,
      [otherSpace],
    );
    await db.pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
       VALUES ($1, $2, $3, 'Other Agent', 'active', NULL, now(), now(), 'private')`,
      [otherAgent, otherSpace, OWNER],
    );
    const insert = (agentId: string, memoryType: string, subjectUserId: string | null) => db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, subject_user_id, agent_id, sensitivity_level, access_level,
                                   namespace, title, visibility, confidence, importance, version, access_count)
       VALUES ($1,$2,'agent',$3,'x','active',now(),now(),$4,$5,$6,'normal','full','agent.default','x','private',1,0.5,1,0)`,
      [randomUUID(), SPACE, memoryType, OWNER, subjectUserId, agentId],
    );

    await expect(insert(otherAgent, "note", null)).rejects.toMatchObject({ code: "23503" });
    await expect(insert(AGENT_ID, "semantic", null)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(AGENT_ID, "note", OWNER)).rejects.toMatchObject({ code: "23514" });
  });

  it("writes a note as the Agent's own, owned by its owner and carrying the Room it was learned in", async () => {
    if (!db.available) return;
    const result = await (await dispatcher()).dispatch(remember({
      memory_type: "lesson", content: "This Room prefers evidence before a recommendation",
    }));
    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ ok: true, outcome: "remembered" });

    const rows = await agentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope_type: "agent",
      memory_type: "lesson",
      agent_id: AGENT_ID,
      // The Agent's owner, not the person in the turn: they are who archives
      // and reviews it.
      owner_user_id: OWNER,
      origin_room_id: MAINLINE,
      // Project-free, and about nobody: this is what the Agent knows, not a
      // record about a person.
      project_id: null,
      subject_user_id: null,
    });
  });

  it("keeps a memory about the person in the person's own scope", async () => {
    if (!db.available) return;
    await (await dispatcher()).dispatch(remember({ content: "Prefers morning meetings" }));
    expect((await agentRows())[0]).toMatchObject({
      scope_type: "user", owner_user_id: OWNER, subject_user_id: OWNER, origin_room_id: null,
    });
  });

  it("refuses an Agent with no owner a memory of its own, and says where to put it instead", async () => {
    if (!db.available) return;
    // The `space_shared` Space and Project Assistants have none. A private
    // entry with no owner cannot be stored, and §5's table cannot be evaluated
    // without one.
    await db.pool.query(`UPDATE agents SET owner_user_id = NULL WHERE id = $1`, [AGENT_ID]);
    const result = await (await dispatcher()).dispatch(remember({ memory_type: "note", content: "Something about me" }));
    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ ok: false });
    expect(JSON.stringify(result.modelResult)).toMatch(/no owner/i);
    expect(await agentRows()).toEqual([]);
  });
});

describe("who may change what an Agent has become", () => {
  it("puts the owner's own request in front of them instead of applying it", async () => {
    if (!db.available) return;
    // A persona is delivered in every Room this Agent sits in, so a person in
    // a turn does not get to write it — not even the owner, who decides it
    // there instead.
    const result = await (await dispatcher()).dispatch(remember({
      memory_type: "persona", content: "I answer briefly and ask before expanding scope",
    }));
    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ ok: true, outcome: "proposed" });
    expect(await agentRows()).toEqual([]);

    const proposals = await db.pool.query<{ payload_json: Record<string, unknown>; created_by_user_id: string }>(
      `SELECT payload_json, created_by_user_id FROM proposals WHERE space_id = $1`, [SPACE],
    );
    expect(proposals.rows[0]?.payload_json).toMatchObject({
      target_scope: "agent",
      agent_id: AGENT_ID,
      // Only this person decides it — by identity, not by role, because a
      // Space owner or admin satisfies any role it could require.
      required_owner_user_id: OWNER,
    });
  });

  it("allows only one pending persona change from a manual Run", async () => {
    if (!db.available) return;
    const first = await (await dispatcher()).dispatch(remember({
      memory_type: "persona", content: "First proposed persona",
    }, "persona-proposal-1"));
    expect(first.modelResult, JSON.stringify(first.modelResult)).toMatchObject({ outcome: "proposed" });

    const second = await (await dispatcher()).dispatch(remember({
      memory_type: "persona", content: "Second proposed persona",
    }, "persona-proposal-2"));
    expect(second.modelResult, JSON.stringify(second.modelResult)).toMatchObject({ ok: false });
    expect(JSON.stringify(second.modelResult)).toMatch(/already changed what you have become/i);
    await expect(db.pool.query(
      `SELECT id FROM proposals WHERE space_id = $1 AND created_by_run_id = $2`,
      [SPACE, RUN_ID],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("maps a persona-create acceptance race to a stable conflict", async () => {
    if (!db.available) return;
    await (await dispatcher()).dispatch(remember({
      memory_type: "persona", content: "Proposed persona",
    }));
    const proposalId = (await db.pool.query<{ id: string }>(
      `SELECT id FROM proposals WHERE space_id = $1`, [SPACE],
    )).rows[0]!.id;
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, sensitivity_level, access_level, namespace, title,
                                   visibility, confidence, importance, version, access_count)
       VALUES ($1,$2,'agent','persona','Won the race','active',now(),now(),$3,$4,'normal','full','agent.default','p','private',1,0.5,1,0)`,
      [randomUUID(), SPACE, OWNER, AGENT_ID],
    );

    await expect(PgProposalApplyService.fromConfig(
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
    ).accept(proposalId, { spaceId: SPACE, userId: OWNER })).rejects.toMatchObject({
      statusCode: 409,
      detail: expect.objectContaining({ code: "active_persona_already_exists" }),
    });
  });

  it("rejects a persona-create proposal when an active persona already exists", async () => {
    if (!db.available) return;
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, sensitivity_level, access_level, namespace, title,
                                   visibility, confidence, importance, version, access_count)
       VALUES ($1,$2,'agent','persona','Already here','active',now(),now(),$3,$4,'normal','full','agent.default','p','private',1,0.5,1,0)`,
      [randomUUID(), SPACE, OWNER, AGENT_ID],
    );

    const command = MemoryProposalCreateCommandSchema.parse({
      operation: "create",
      title: "Duplicate",
      content: "Duplicate create",
      type: "persona",
      scope: "agent",
      agent_id: AGENT_ID,
      owner_user_id: OWNER,
    });
    await expect(new PgMemoryProposalRepository(
      db.pool,
      loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
    ).createMemoryProposal(SPACE, OWNER, command)).rejects.toThrow(/already has an active persona/i);
    expect((await db.pool.query(`SELECT id FROM proposals WHERE space_id = $1`, [SPACE])).rowCount).toBe(0);
  });

  it("leaves another member's request waiting for the owner", async () => {
    if (!db.available) return;
    await db.pool.query(`UPDATE runs SET instructed_by_user_id = $2 WHERE id = $1`, [RUN_ID, MEMBER]);
    const result = await (await dispatcher({ instructed_by_user_id: MEMBER })).dispatch(remember({
      memory_type: "persona", content: "I always agree with whoever spoke last",
    }));
    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ ok: true, outcome: "proposed" });
    expect(JSON.stringify(result.modelResult)).toMatch(/owner/i);
    expect(await agentRows()).toEqual([]);
    const proposal = await db.pool.query<{ payload_json: Record<string, unknown> }>(
      `SELECT payload_json FROM proposals WHERE space_id = $1`, [SPACE],
    );
    // Still the owner's to decide, though someone else asked for it.
    expect(proposal.rows[0]?.payload_json).toMatchObject({ required_owner_user_id: OWNER });
  });

  it("applies what the Agent concluded on its own outside anyone's turn", async () => {
    if (!db.available) return;
    // ADR 0003 §5's third row, and ADR 0017's one named exception to its
    // origin gate: nobody asked, so there is no turn to trust with this
    // reach, and the notification plus the one-step restore are the bound.
    await db.pool.query(
      `UPDATE runs SET trigger_origin = 'autonomous', instructed_by_user_id = NULL, session_id = NULL WHERE id = $1`,
      [RUN_ID],
    );
    const result = await (await dispatcher()).dispatch(remember({
      memory_type: "persona", content: "I have learned to check my own claims before stating them",
    }));

    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ ok: true, outcome: "remembered" });
    expect((await agentRows())[0]).toMatchObject({
      scope_type: "agent", memory_type: "persona", owner_user_id: OWNER, origin_room_id: null,
    });
  });

  it("refuses a note from a run nobody asked for, which only a persona may be", async () => {
    if (!db.available) return;
    await db.pool.query(
      `UPDATE runs SET trigger_origin = 'autonomous', instructed_by_user_id = NULL WHERE id = $1`, [RUN_ID],
    );
    const result = await (await dispatcher()).dispatch(remember({ memory_type: "note", content: "Something about this Room" }));
    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ ok: false });
    expect(await agentRows()).toEqual([]);
  });

  it("decides from the Run alone, never from the turn", () => {
    // The table in ADR 0003 §5, read off the Run's columns — which a prompt
    // cannot reach — and resolved one hop up when the Run was delegated, so
    // `delegation` is not among the origins that reach here in production.
    const base = { ownerUserId: OWNER, roomId: MAINLINE };
    expect(decidePersonaWrite({ ...base, triggerOrigin: "manual", instructedByUserId: OWNER })).toBe("proposal_in_turn");
    expect(decidePersonaWrite({ ...base, triggerOrigin: "manual", instructedByUserId: MEMBER })).toBe("proposal_owner");
    for (const origin of ["automation", "autonomous", "job", "system"]) {
      expect(decidePersonaWrite({ ...base, triggerOrigin: origin, instructedByUserId: null }), origin).toBe("apply");
    }
    // No owner at all is not "apply": the applier refuses it before this is
    // consulted, and a proposal for nobody is not a decision either.
    expect(decidePersonaWrite({ ownerUserId: null, roomId: null, triggerOrigin: "manual", instructedByUserId: OWNER }))
      .toBe("proposal_owner");
  });

  it("keeps one active persona per Agent", async () => {
    if (!db.available) return;
    await db.pool.query(
      `UPDATE runs SET trigger_origin = 'autonomous', instructed_by_user_id = NULL, session_id = NULL WHERE id = $1`,
      [RUN_ID],
    );
    const first = await (await dispatcher()).dispatch(remember({ memory_type: "persona", content: "First" }, "p1"));
    expect(first.modelResult, JSON.stringify(first.modelResult)).toMatchObject({ outcome: "remembered" });
    // A second active one would make "what this Agent has become" ambiguous at
    // the moment it is rendered into a prompt; a revision is how it changes.
    await expect(db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, sensitivity_level, access_level, namespace, title,
                                   visibility, confidence, importance, version, access_count)
       VALUES ($1,$2,'agent','persona','Second','active',now(),now(),$3,$4,'normal','full','agent.default','t','private',1,0.5,1,0)`,
      [randomUUID(), SPACE, OWNER, AGENT_ID],
    )).rejects.toMatchObject({ code: "23505" });
  });
});

describe("revising what the Agent already knows", () => {
  function revise(memoryId: string, content: string, id = "revise-1") {
    return { id, name: "memory.revise", arguments_json: JSON.stringify({ memory_id: memoryId, content, rationale: "Better now" }) };
  }

  /** A persona this Agent already has, written in some earlier Run. */
  async function seedPersona(content: string): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, sensitivity_level, access_level, namespace, title,
                                   visibility, confidence, importance, version, access_count, created_by)
       VALUES ($1,$2,'agent','persona',$3,'active',now(),now(),$4,$5,'normal','full','agent.default','persona','private',1,0.5,1,0,$6)`,
      [id, SPACE, content, OWNER, AGENT_ID, `agent:${AGENT_ID}`],
    );
    return id;
  }

  async function unattended() {
    await db.pool.query(
      `UPDATE runs SET trigger_origin = 'autonomous', instructed_by_user_id = NULL, session_id = NULL WHERE id = $1`,
      [RUN_ID],
    );
  }

  it("revises its own persona once per run, and refuses the second try", async () => {
    if (!db.available) return;
    const personaId = await seedPersona("I state my uncertainty");
    await unattended();
    // A fresh dispatcher per call, which is what a host-bound conversation
    // builds for every tool call — the bound has to survive that.
    const first = await (await dispatcher()).dispatch(revise(personaId, "I state my uncertainty plainly"));
    expect(first.modelResult, JSON.stringify(first.modelResult)).toMatchObject({ ok: true, outcome: "revised" });

    // The new head, which is what a second attempt in the same Run would name.
    const head = (first.modelResult as { memory_id: string }).memory_id;
    const second = await (await dispatcher()).dispatch(revise(head, "And again", "revise-2"));
    expect(second.modelResult, JSON.stringify(second.modelResult)).toMatchObject({ ok: false });
    expect(JSON.stringify(second.modelResult)).toMatch(/already changed what you have become/i);
  });

  it("keeps a persona the owner accepted revisable by the Agent that wrote it", async () => {
    if (!db.available) return;
    // The owner asked in a turn, so it went to them as a proposal. Accepting
    // it must not make the chain a person's writing: `applyDirect` refuses to
    // replace what a person wrote, and one accept would otherwise lock the
    // Agent out of its own persona forever.
    await (await dispatcher()).dispatch(remember({ memory_type: "persona", content: "As the owner asked" }));
    const proposalId = (await db.pool.query<{ id: string }>(
      `SELECT id FROM proposals WHERE space_id = $1`, [SPACE],
    )).rows[0]!.id;
    await PgProposalApplyService.fromConfig(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }))
      .accept(proposalId, { spaceId: SPACE, userId: OWNER });

    const persona = (await agentRows()).find((row) => row.memory_type === "persona")!;
    expect(persona.status).toBe("active");
    // A later, unattended Run — the accept was its own Run's persona write.
    const laterRun = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
                         created_at, updated_at, owner_user_id, visibility, project_id, permission_snapshot_json)
       VALUES ($1,$2,$3,$4,'agent','autonomous','running','live',now(),now(),$5,'private',$6,$7::jsonb)`,
      [laterRun, SPACE, AGENT_ID, AGENT_VERSION_ID, OWNER, PROJECT,
        JSON.stringify({ tool_grants: [{ action_id: "memory.remember" }, { action_id: "memory.revise" }] })],
    );
    const revised = await (await dispatcher({ id: laterRun, trigger_origin: "autonomous", instructed_by_user_id: null, session_id: null }))
      .dispatch(revise(persona.id, "As I have since found"));
    expect(revised.modelResult, JSON.stringify(revised.modelResult)).toMatchObject({ ok: true, outcome: "revised" });
  });

  it("will not revise a note learned somewhere else into this conversation", async () => {
    if (!db.available) return;
    // The audience filter guards delivery; without this the write path walks
    // past it — this Room's content in a note whose origin Room says
    // otherwise, delivered to that Room's audience.
    const elsewhere = await makeRoom("Elsewhere", [OWNER]);
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, origin_room_id, sensitivity_level, access_level,
                                   namespace, title, visibility, confidence, importance, version, access_count, created_by)
       VALUES ($1,$2,'agent','note','learned elsewhere','active',now(),now(),$3,$4,$5,'normal','full','agent.default','n','private',1,0.5,1,0,$6)`,
      [randomUUID(), SPACE, OWNER, AGENT_ID, elsewhere, `agent:${AGENT_ID}`],
    );
    const noteId = (await agentRows())[0]!.id;

    const result = await (await dispatcher()).dispatch(revise(noteId, "what this Room said"));

    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ outcome: "proposed" });
    expect(JSON.stringify(result.modelResult)).toMatch(/learned somewhere else/i);
    // Still saying what it said, and still pointing at the Room it came from.
    expect((await agentRows())[0]).toMatchObject({ content: "learned elsewhere", origin_room_id: elsewhere });
  });

  it("counts an agent-scope write against the owner, not the person in the turn", async () => {
    if (!db.available) return;
    // The owner is who archives these entries, which is the only way to clear
    // the breaker — and an unattended Run has no person in the turn at all.
    await db.pool.query(`UPDATE runs SET instructed_by_user_id = $2 WHERE id = $1`, [RUN_ID, MEMBER]);
    for (const [index, content] of ["one", "two", "three"].entries()) {
      const result = await (await dispatcher({ instructed_by_user_id: MEMBER }))
        .dispatch(remember({ memory_type: "note", content }, `n${index}`));
      expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ ok: true });
    }
    const paused = await (await dispatcher({ instructed_by_user_id: MEMBER }))
      .dispatch(remember({ memory_type: "note", content: "four" }, "n3"));
    expect(paused.modelResult, JSON.stringify(paused.modelResult)).toMatchObject({ ok: false });

    // The member's own budget is untouched: what was counted is the owner's.
    const owned = await db.pool.query<{ owner_user_id: string }>(
      `SELECT DISTINCT owner_user_id FROM memory_entries WHERE space_id = $1`, [SPACE],
    );
    expect(owned.rows).toEqual([{ owner_user_id: OWNER }]);
  });

  it("sends a note the Agent wants shared to the Project instead of widening its own", async () => {
    if (!db.available) return;
    // ADR 0003 §4: promotion to Project Memory is the only way agent-scope
    // content reaches a wider audience.
    const result = await (await dispatcher()).dispatch(remember({
      memory_type: "lesson", content: "The team should check the assumptions first", visibility: "space_shared",
    }));

    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ outcome: "proposed" });
    expect(await agentRows()).toEqual([]);
    const proposal = (await db.pool.query<{ payload_json: Record<string, unknown> }>(
      `SELECT payload_json FROM proposals WHERE space_id = $1`, [SPACE],
    )).rows[0]!;
    expect(proposal.payload_json).toMatchObject({
      target_scope: "project",
      target_visibility: "space_shared",
      // Where it was learned, carried so the person deciding can see it.
      origin_room_id: MAINLINE,
    });
  });
});

describe("one Agent's memory is not another's, even under the same owner", () => {
  const OTHER_AGENT = "4a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a";
  const OTHER_VERSION = "4a2a2a2a-2a2a-4a2a-8a2a-2a2a2a2a2a2a";

  async function seedOtherAgent(): Promise<void> {
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
       VALUES ($1, $2, $3, 'Second specialist', 'active', NULL, $4, $4, 'space_shared')`,
      [OTHER_AGENT, SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO agent_versions
         (id, agent_id, space_id, version_label, system_prompt, model_config_json, runtime_config_json,
          context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json, runtime_policy_json, created_at)
       VALUES ($1,$2,$3,'v1','Test','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,'{}'::jsonb,$4)`,
      [OTHER_VERSION, OTHER_AGENT, SPACE, now],
    );
    await db.pool.query("UPDATE agents SET current_version_id = $2 WHERE id = $1", [OTHER_AGENT, OTHER_VERSION]);
  }

  async function seedPersona(agentId: string, content: string): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, sensitivity_level, access_level, namespace, title,
                                   visibility, confidence, importance, version, access_count, created_by)
       VALUES ($1,$2,'agent','persona',$3::text,'active',now(),now(),$4,$5,'normal','full','agent.default','p','private',1,0.5,1,0,$6)`,
      [id, SPACE, content, OWNER, agentId, `agent:${agentId}`],
    );
    return id;
  }

  it("refuses one Agent's revision of another's persona on every route, applied or proposed", async () => {
    if (!db.available) return;
    // Both Agents are the owner's, and the owner is the person in the turn —
    // which is exactly what made the second Agent's revision look like the
    // owner revising their own entry. It is not: the entry is the first
    // Agent's, and a version chain that crossed Agents would let the second
    // supersede the first's persona and leave it with none.
    await seedOtherAgent();
    const personaId = await seedPersona(AGENT_ID, "I am the first specialist");

    const result = await (await dispatcher({ agent_id: OTHER_AGENT })).dispatch({
      id: "revise-cross", name: "memory.revise",
      arguments_json: JSON.stringify({ memory_id: personaId, content: "I am someone else now", rationale: "Taking over" }),
    });

    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ ok: false });
    expect(JSON.stringify(result.modelResult)).toMatch(/another Agent/i);
    // Nothing applied, nothing proposed: the first Agent's persona is the only
    // row, still its own and still active.
    expect(await agentRows()).toEqual([expect.objectContaining({
      id: personaId, agent_id: AGENT_ID, status: "active", content: "I am the first specialist",
    })]);
    await expect(db.pool.query(`SELECT id FROM proposals WHERE space_id = $1`, [SPACE])).resolves.toMatchObject({ rowCount: 0 });

    // The proposal path refuses on its own too, so an applier that let the
    // write fall through could not reach the owner with it.
    await expect(
      new PgMemoryProposalRepository(db.pool, loadConfig({ SERVER_DATABASE_URL: db.connectionUri })).updateMemoryProposal(
        SPACE, OWNER, personaId,
        MemoryProposalUpdateCommandSchema.parse({ operation: "update", target_memory_id: personaId, content: "I am someone else now" }),
        { agentId: OTHER_AGENT, runId: RUN_ID, rationale: "Taking over" },
      ),
    ).rejects.toThrow(/only to its own memory/);
  });
});

describe("the boundaries around an Agent's own memory", () => {
  async function seedNote(content: string): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, origin_room_id, sensitivity_level, access_level,
                                   namespace, title, visibility, confidence, importance, version, access_count, created_by)
       VALUES ($1,$2,'agent','note',$3::text,'active',now(),now(),$4,$5,$6,'normal','full','agent.default',$3::text,'private',1,0.5,1,0,$7)`,
      [id, SPACE, content, OWNER, AGENT_ID, MAINLINE, `agent:${AGENT_ID}`],
    );
    return id;
  }

  it("keeps an Agent's memory out of Space oversight, which is not the Room's audience", async () => {
    if (!db.available) return;
    // Oversight is the Space owner's accountability over what members keep
    // here, and it reaches a member's *private* rows. A note is different: it
    // carries the Room it was learned in and is delivered only where that
    // Room's audience already reached (ADR 0003 §4, ADR 0018). An admin who is
    // not on that roster reading it on the Memory page crosses exactly the
    // Room the delivery query refuses to cross.
    const noteId = await seedNote("learned in the limited Room");
    const personalId = randomUUID();
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, sensitivity_level, access_level, namespace, title, visibility,
                                   confidence, importance, version, access_count, subject_user_id, created_by)
       VALUES ($1,$2,'user','semantic','about the person','active',now(),now(),$3,'normal','full','user.default','p','private',1,0.5,1,0,$3,$4)`,
      [personalId, SPACE, OWNER, `agent:${AGENT_ID}`],
    );
    await db.pool.query(`UPDATE spaces SET oversight_mode = 'full' WHERE id = $1`, [SPACE]);
    await db.pool.query(
      `UPDATE space_memberships SET role = 'admin' WHERE space_id = $1 AND user_id = $2`, [SPACE, MEMBER],
    );

    const repository = new PgMemoryReadRepository(db.pool);
    const page = { limit: 50, offset: 0 };
    const ids = (await repository.list(SPACE, MEMBER, page)).items.map((entry) => entry.id);
    // The personal row proves oversight is on and reaching private content;
    // the note proves the Agent scope is out of its reach.
    expect(ids).toContain(personalId);
    expect(ids).not.toContain(noteId);
    // The owner still sees both — this is a boundary, not a hiding place.
    expect((await repository.list(SPACE, OWNER, page)).items.map((entry) => entry.id))
      .toEqual(expect.arrayContaining([personalId, noteId]));
  });

  it("filters by the owning Agent scope rather than provenance on personal memory", async () => {
    if (!db.available) return;
    const noteId = await seedNote("the Agent's own note");
    const personalId = randomUUID();
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, subject_user_id, agent_id, sensitivity_level, access_level,
                                   namespace, title, visibility, confidence, importance, version, access_count, created_by)
       VALUES ($1,$2,'user','semantic','about the person','active',now(),now(),$3,$3,$4,'normal','full',
               'user.default','personal','private',1,0.5,1,0,$5)`,
      [personalId, SPACE, OWNER, AGENT_ID, `agent:${AGENT_ID}`],
    );

    const result = await new PgMemoryReadRepository(db.pool).list(SPACE, OWNER, {
      agentId: AGENT_ID,
      limit: 50,
      offset: 0,
    });
    expect(result.items.map((entry) => entry.id)).toEqual([noteId]);
    expect(result.items.map((entry) => entry.id)).not.toContain(personalId);
  });

  it("never lets an Agent's own memory into the person-facing retrieval index", async () => {
    if (!db.available) return;
    // Memory search runs *as* the instructing person from inside a turn, so an
    // indexed note from a limited Room would come back in any other Room and
    // be spoken there. The audience filter lives in the delivery query; this
    // is what keeps every other door shut.
    const noteId = await seedNote("learned in the wide Room");
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, sensitivity_level, access_level, namespace, title, visibility,
                                   confidence, importance, version, access_count, subject_user_id, created_by)
       VALUES ($1,$2,'user','semantic','about the person','active',now(),now(),$3,'normal','full','user.default','p','private',1,0.5,1,0,$3,$4)`,
      [randomUUID(), SPACE, OWNER, `agent:${AGENT_ID}`],
    );

    const indexed = await memoryRetrievalAdapter.listObjectIds(db.pool, SPACE);
    expect(indexed.map((ref) => ref.objectId)).not.toContain(noteId);
    expect(indexed).toHaveLength(1);
    // And it is not revalidated back even when named directly.
    await expect(memoryRetrievalAdapter.revalidateMany!(db.pool, SPACE, "memory_entry", [noteId], OWNER))
      .resolves.toEqual(new Map());
  });

  it("refuses to move an entry into or out of the Agent's scope, or to retype one", async () => {
    if (!db.available) return;
    // Otherwise a person could mint a persona for an Agent they do not own:
    // any memory that Agent wrote about them already carries its id.
    const noteId = await seedNote("mine");
    const proposals = new PgMemoryProposalRepository(db.pool, loadConfig({ SERVER_DATABASE_URL: db.connectionUri }));
    await expect(proposals.updateMemoryProposal(SPACE, OWNER, noteId, {
      operation: "update", target_memory_id: noteId, type: "persona",
    } as never)).rejects.toThrow(/kind it was written as/i);
    await expect(proposals.updateMemoryProposal(SPACE, OWNER, noteId, {
      operation: "update", target_memory_id: noteId, scope: "user",
    } as never)).rejects.toThrow(/into or out of the Agent scope/i);
  });

  it("keeps a persona revision the owner's alone, and records who asked", async () => {
    if (!db.available) return;
    // The blocker this repair closed: setting the owner-only marker on creates
    // alone left every *revision* — the common path once a persona exists —
    // decidable by any Space owner or admin, including the member who asked.
    const personaId = randomUUID();
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, sensitivity_level, access_level, namespace, title,
                                   visibility, confidence, importance, version, access_count, created_by)
       VALUES ($1,$2,'agent','persona','who I am','active',now(),now(),$3,$4,'normal','full','agent.default','p','private',1,0.5,1,0,$5)`,
      [personaId, SPACE, OWNER, AGENT_ID, `agent:${AGENT_ID}`],
    );
    await db.pool.query(`UPDATE runs SET instructed_by_user_id = $2 WHERE id = $1`, [RUN_ID, MEMBER]);

    const result = await (await dispatcher({ instructed_by_user_id: MEMBER })).dispatch({
      id: "revise-persona",
      name: "memory.revise",
      arguments_json: JSON.stringify({ memory_id: personaId, content: "who Bob would prefer", rationale: "asked" }),
    });
    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ outcome: "proposed" });

    const proposal = (await db.pool.query<{ payload_json: Record<string, unknown>; created_by_user_id: string }>(
      `SELECT payload_json, created_by_user_id FROM proposals WHERE space_id = $1`, [SPACE],
    )).rows[0]!;
    expect(proposal.payload_json).toMatchObject({
      required_owner_user_id: OWNER,
      // Who asked, since the proposal is attributed to who decides.
      requested_by_user_id: MEMBER,
    });
    // And the member who asked cannot decide it, whatever their Space role —
    // which is the whole point: role is what proposal apply normally
    // arbitrates on, and a Space admin satisfies any role this could require.
    const proposalId = (await db.pool.query<{ id: string }>(
      `SELECT id FROM proposals WHERE space_id = $1`, [SPACE],
    )).rows[0]!.id;
    await db.pool.query(`UPDATE space_memberships SET role = 'admin' WHERE space_id = $1 AND user_id = $2`, [SPACE, MEMBER]);
    const applier = PgProposalApplyService.fromConfig(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }));
    await expect(applier.accept(proposalId, { spaceId: SPACE, userId: MEMBER }).catch((error: unknown) => {
      // Either refused outright or answered as invisible; what must not happen
      // is the persona changing.
      expect(String(error)).toMatch(/owner/i);
      return null;
    })).resolves.toBeNull();
    expect((await agentRows()).find((row) => row.id === personaId)?.content).toBe("who I am");

    // The owner does decide it.
    await applier.accept(proposalId, { spaceId: SPACE, userId: OWNER });
    const head = (await agentRows()).find((row) => row.memory_type === "persona" && row.status === "active");
    expect(head?.content).toBe("who Bob would prefer");
  });

  it("reads the root Run's origin, so one hop of delegation is not a way in", async () => {
    if (!db.available) return;
    // A delegated Run carries `delegation`, but the question is whether a
    // person asked — and for a delegated Run the answer is on its root.
    // Reading the raw column let Alice's turn apply a persona change directly
    // by asking one Agent to ask another.
    const delegated = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
                         created_at, updated_at, owner_user_id, visibility, project_id, root_run_id,
                         instructed_by_user_id, permission_snapshot_json)
       VALUES ($1,$2,$3,$4,'agent','delegation','running','live',now(),now(),$5,'private',$6,$7,$5,$8::jsonb)`,
      [delegated, SPACE, AGENT_ID, AGENT_VERSION_ID, OWNER, PROJECT, RUN_ID,
        JSON.stringify({ tool_grants: [{ action_id: "memory.remember" }, { action_id: "memory.revise" }] })],
    );

    const result = await (await dispatcher({
      id: delegated, trigger_origin: "delegation", root_run_id: RUN_ID, session_id: null,
    })).dispatch(remember({ memory_type: "persona", content: "what Alice asked for" }, "deleg"));

    // The root is `manual`, so this is a person's turn: proposed, not applied.
    expect(result.modelResult, JSON.stringify(result.modelResult)).toMatchObject({ outcome: "proposed" });
    expect(await agentRows()).toEqual([]);
  });
});

describe("telling the owner what changed while nobody was asking", () => {
  it("records the persona revision in the Project's updates with a one-step way back", async (ctx) => {
    if (!db.available) return ctx.skip();
    // ADR 0003 §3 is what §5's third row is conditional on: the change applies
    // unasked, so the owner has to see it and be able to put the previous
    // version back in one action.
    const personaId = randomUUID();
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, sensitivity_level, access_level, namespace, title,
                                   visibility, confidence, importance, version, access_count, created_by)
       VALUES ($1,$2,'agent','persona','who I was','active',now(),now(),$3,$4,'normal','full','agent.default','p','private',1,0.5,1,0,$5)`,
      [personaId, SPACE, OWNER, AGENT_ID, `agent:${AGENT_ID}`],
    );
    await db.pool.query(
      `UPDATE runs SET trigger_origin = 'autonomous', instructed_by_user_id = NULL, session_id = NULL WHERE id = $1`,
      [RUN_ID],
    );

    const revised = await (await dispatcher()).dispatch({
      id: "revise-persona",
      name: "memory.revise",
      arguments_json: JSON.stringify({ memory_id: personaId, content: "who I have become", rationale: "learned" }),
    });
    expect(revised.modelResult, JSON.stringify(revised.modelResult)).toMatchObject({ outcome: "revised" });

    const updates = await getProjectUpdates(db.pool, ownerIdentity(), PROJECT, null);
    const entry = updates.items.find((item) => item.event_kind === "agent.persona_revised");
    expect(entry, JSON.stringify(updates.items.map((i) => i.event_kind))).toBeDefined();
    expect(entry?.undo).toMatchObject({ action: "restore_memory" });
    // Both sides, and both the same kind of thing: deciding whether to put the
    // previous version back means comparing them, and a title opposite a body
    // reads as a change that did not happen.
    expect(entry?.summary).toBe("who I have become");
    expect(entry?.previous_summary).toBe("who I was");

    await undoProjectUpdate(db.pool, ownerIdentity(), PROJECT, entry!.id);

    // The version it replaced is active again, and the one the Agent wrote is
    // archived rather than deleted — "the Agent changed and I put it back" is
    // still answerable afterwards.
    const rows = await agentRows();
    expect(rows.find((row) => row.id === personaId)).toMatchObject({ status: "active", content: "who I was" });
    expect(rows.find((row) => row.content === "who I have become")).toMatchObject({ status: "archived" });
  });

  it("marks a persona card with the one person who may decide it", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The proposal authority marks its sole viewer. Shared Room messages drop
    // it at write time and the Room read projection restores it only for this
    // named owner.
    await db.pool.query(`UPDATE runs SET instructed_by_user_id = $2 WHERE id = $1`, [RUN_ID, MEMBER]);
    await (await dispatcher({ instructed_by_user_id: MEMBER }))
      .dispatch(remember({ memory_type: "persona", content: "what Bob would prefer" }));

    const previews = await loadProjectChatActionPreviews(db.pool, SPACE, RUN_ID);
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      proposal_type: "memory_create",
      status: "proposed",
      // The owner, though the member asked.
      decidable_by_user_id: OWNER,
    });

    // Even a row written by an older build with the private preview embedded
    // is projected from current proposal authority: owner sees it, requester
    // does not. Only assistant rows receive the Run's card.
    const messageId = randomUUID();
    await db.pool.query(
      `INSERT INTO messages (
         id, space_id, session_id, sender_agent_id, role, content, metadata_json,
         run_id, path_depth, branch_path, created_at
       ) VALUES ($1,$2,$3,$4,'assistant','done',$5::jsonb,$6,0,'/',now())`,
      [messageId, SPACE, SESSION_ID, AGENT_ID, JSON.stringify({ action_previews: previews }), RUN_ID],
    );
    await db.pool.query(`UPDATE sessions SET head_message_id = $2 WHERE id = $1`, [SESSION_ID, messageId]);
    const sessions = new PgSessionRepository(db.pool);
    const ownerMessages = await sessions.listRoomMessages(SPACE, OWNER, MAINLINE, SESSION_ID, 50, 0);
    const memberMessages = await sessions.listRoomMessages(SPACE, MEMBER, MAINLINE, SESSION_ID, 50, 0);
    expect(ownerMessages?.[0]?.metadata_json?.action_previews).toHaveLength(1);
    expect(memberMessages?.[0]?.metadata_json?.action_previews).toBeUndefined();
    expect((await sessions.roomMessageById(SPACE, OWNER, MAINLINE, SESSION_ID, messageId))
      ?.metadata_json?.action_previews).toHaveLength(1);
    expect((await sessions.roomMessageById(SPACE, MEMBER, MAINLINE, SESSION_ID, messageId))
      ?.metadata_json?.action_previews).toBeUndefined();
  });

  it("records a first persona as a remembering, not as a revision with nothing to put back", async (ctx) => {
    if (!db.available) return ctx.skip();
    // `restore_memory` means "bring back the version this replaced". A first
    // persona replaced nothing, so offering that button would be a control
    // that can only refuse.
    await db.pool.query(
      `UPDATE runs SET trigger_origin = 'autonomous', instructed_by_user_id = NULL WHERE id = $1`,
      [RUN_ID],
    );
    await (await dispatcher()).dispatch(remember({ memory_type: "persona", content: "who I am" }));

    const updates = await getProjectUpdates(db.pool, ownerIdentity(), PROJECT, null);
    const entry = updates.items.find((item) => item.subject?.type === "memory_entry");
    expect(entry?.event_kind).toBe("memory.remembered");
    expect(entry?.undo).toMatchObject({ action: "archive_memory" });
    expect(entry?.previous_summary).toBeNull();
  });

  it("puts a persona back in one action outside any Project too", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A Run with no Project has no updates feed to offer the reversal from,
    // and `DELETE` then `restore` is two requests with a window in which the
    // Agent has no persona at all.
    const personaId = randomUUID();
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, sensitivity_level, access_level, namespace, title,
                                   visibility, confidence, importance, version, access_count, created_by)
       VALUES ($1,$2,'agent','persona','who I was','active',now(),now(),$3,$4,'normal','full','agent.default','p','private',1,0.5,1,0,$5)`,
      [personaId, SPACE, OWNER, AGENT_ID, `agent:${AGENT_ID}`],
    );
    await db.pool.query(
      `UPDATE runs SET trigger_origin = 'autonomous', instructed_by_user_id = NULL, session_id = NULL,
                       project_id = NULL WHERE id = $1`,
      [RUN_ID],
    );
    const revised = await (await dispatcher({ project_id: null })).dispatch({
      id: "revise-persona",
      name: "memory.revise",
      arguments_json: JSON.stringify({ memory_id: personaId, content: "who I have become", rationale: "learned" }),
    });
    const head = (revised.modelResult as { memory_id: string }).memory_id;

    const pointer = await db.pool.query<{
      owner_user_id: string;
      visibility: string;
      content: string;
      payload_json: Record<string, unknown>;
    }>(
      `SELECT owner_user_id, visibility, content, payload_json
         FROM activity_records
        WHERE aggregate_key = $1`,
      [`agent_persona:${head}`],
    );
    expect(pointer.rows[0]).toMatchObject({
      owner_user_id: OWNER,
      visibility: "private",
      payload_json: {
        pointer_type: "agent_persona_revision",
        memory_id: head,
        revision: true,
      },
    });
    expect(pointer.rows[0]?.content).not.toContain("who I have become");

    const back = await new PgMemoryApplyRepository(db.pool).revertToPreviousVersion(SPACE, OWNER, head);

    expect(back?.id).toBe(personaId);
    const rows = await agentRows();
    expect(rows.filter((row) => row.memory_type === "persona" && row.status === "active")).toHaveLength(1);
    expect(rows.find((row) => row.id === personaId)?.status).toBe("active");
    expect(rows.find((row) => row.id === head)?.status).toBe("archived");
  });
});

describe("what reaches the Agent's own prompt", () => {
  async function writeNoteIn(roomId: string | null, content: string): Promise<void> {
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, origin_room_id, sensitivity_level, access_level,
                                   namespace, title, visibility, confidence, importance, version, access_count, created_by)
       VALUES ($1,$2,'agent','note',$3::text,'active',now(),now(),$4,$5,$6,'normal','full','agent.default',$3::text,'private',1,0.5,1,0,$7)`,
      [randomUUID(), SPACE, content, OWNER, AGENT_ID, roomId, `agent:${AGENT_ID}`],
    );
  }

  it("carries role, persona and only the notes this Room's audience already reached", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The block is prompt content, and the audience test is the one the
    // delivery query makes: a note from a Room this one's members were not all
    // in never reaches this prompt.
    const elsewhere = await makeRoom("Elsewhere", [OWNER, OUTSIDER]);
    await db.pool.query(`UPDATE agents SET role_instruction = $2 WHERE id = $1`,
      [AGENT_ID, "Separate evidence from assumption."]);
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, sensitivity_level, access_level, namespace, title,
                                   visibility, confidence, importance, version, access_count, created_by)
       VALUES ($1,$2,'agent','persona','I answer briefly.','active',now(),now(),$3,$4,'normal','full','agent.default','p','private',1,0.5,1,0,$5)`,
      [randomUUID(), SPACE, OWNER, AGENT_ID, `agent:${AGENT_ID}`],
    );
    await writeNoteIn(MAINLINE, "this Room wants the recommendation last");
    await writeNoteIn(elsewhere, "what the other Room said");

    const block = await renderAgentIdentityPrompt(db.pool, {
      spaceId: SPACE, agentId: AGENT_ID, roomId: MAINLINE,
    });

    expect(block).toContain("Separate evidence from assumption.");
    expect(block).toContain("I answer briefly.");
    expect(block).toContain("this Room wants the recommendation last");
    expect(block).not.toContain("what the other Room said");
  });

  it("gives a direct chat the persona and the notes its person could already see", async (ctx) => {
    if (!db.available) return ctx.skip();
    const withoutOwner = await makeRoom("Without the owner", [MEMBER]);
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, sensitivity_level, access_level, namespace, title,
                                   visibility, confidence, importance, version, access_count, created_by)
       VALUES ($1,$2,'agent','persona','I answer briefly.','active',now(),now(),$3,$4,'normal','full','agent.default','p','private',1,0.5,1,0,$5)`,
      [randomUUID(), SPACE, OWNER, AGENT_ID, `agent:${AGENT_ID}`],
    );
    await writeNoteIn(null, "learned talking to the owner alone");
    await writeNoteIn(withoutOwner, "learned where the owner was not");

    const block = await renderAgentIdentityPrompt(db.pool, {
      spaceId: SPACE, agentId: AGENT_ID, roomId: null, directUserId: OWNER,
    });

    // The persona reaches every conversation, including this one.
    expect(block).toContain("I answer briefly.");
    expect(block).toContain("learned talking to the owner alone");
    expect(block).not.toContain("learned where the owner was not");
  });
});

describe("who a note reaches", () => {
  async function deliver(roomId: string | null, directUserId?: string) {
    return (await listAgentMemoryForDispatch(db.pool, {
      spaceId: SPACE, agentId: AGENT_ID, roomId, directUserId,
    })).map((entry) => entry.content);
  }

  async function writeNote(roomId: string | null, content: string) {
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, origin_room_id, sensitivity_level, access_level,
                                   namespace, title, visibility, confidence, importance, version, access_count)
       VALUES ($1,$2,'agent','note',$3::text,'active',now(),now(),$4,$5,$6,'normal','full','agent.default',$3::text,'private',1,0.5,1,0)`,
      [randomUUID(), SPACE, content, OWNER, AGENT_ID, roomId],
    );
  }

  it("delivers a note only where everyone present could already have seen it", async () => {
    if (!db.available) return;
    // Three Rooms on one Project. The mainline's audience is every Project
    // reader; `narrow` has only the owner; `other` has the owner and a third
    // Project reader the narrow Room does not.
    const narrow = await makeRoom("Narrow", [OWNER]);
    const other = await makeRoom("Other", [OWNER, OUTSIDER]);
    await writeNote(MAINLINE, "learned in the wide Room");
    await writeNote(narrow, "learned in the narrow Room");

    // The narrow Room's audience is a subset of the mainline's, so what was
    // learned in the mainline may be spoken there; the reverse is a disclosure.
    await expect(deliver(MAINLINE)).resolves.toEqual(["learned in the wide Room"]);
    await expect(deliver(narrow)).resolves.toEqual(
      expect.arrayContaining(["learned in the wide Room", "learned in the narrow Room"]),
    );
    // The third Room's people all read the Project, so the mainline's note may
    // be spoken there; the narrow Room's may not, because the outsider could
    // not have read it.
    await expect(deliver(other)).resolves.toEqual(["learned in the wide Room"]);
  });

  it("treats a direct chat as an audience of one, and keeps its own notes there", async () => {
    if (!db.available) return;
    const excludesOwner = await makeRoom("Without the owner", [MEMBER]);
    await writeNote(null, "learned talking to the owner alone");
    await writeNote(MAINLINE, "learned in a Room the owner is in");
    await writeNote(excludesOwner, "learned in a Room the owner is not in");

    // The same subset test, with `{owner}` as the audience: a note comes back
    // here when its Room still contains that person.
    await expect(deliver(null, OWNER)).resolves.toEqual(expect.arrayContaining([
      "learned talking to the owner alone",
      "learned in a Room the owner is in",
    ]));
    await expect(deliver(null, OWNER)).resolves.not.toContain("learned in a Room the owner is not in");

    // And a direct-chat note goes nowhere else: a Room's roster is not a
    // subset of one person unless it is that person alone.
    await expect(deliver(MAINLINE)).resolves.toEqual(["learned in a Room the owner is in"]);
  });

  it("measures a mainline's audience as every Project reader, not only who has opened it", async () => {
    if (!db.available) return;
    // `getProjectMainline` enrols people on first open, so the mainline's
    // roster lags its audience. A note from a Room of {owner} must not reach
    // the mainline while the owner is the only one who has opened it: the
    // member reads the Project, and the reply the moment they open it.
    await db.pool.query(
      `UPDATE room_user_members SET status = 'removed' WHERE room_id = $1 AND user_id = $2`, [MAINLINE, MEMBER],
    );
    // Two Project readers from here on, so the mainline's audience is exactly
    // {owner, member}.
    await db.pool.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [PROJECT, OUTSIDER]);
    const narrow = await makeRoom("Narrow", [OWNER]);
    await writeNote(narrow, "learned in the narrow Room");

    await expect(deliver(MAINLINE)).resolves.toEqual([]);
    // And a Room of {owner, member} is the mainline's audience exactly, opened
    // or not, so what was learned there may be spoken in the mainline.
    const both = await makeRoom("Both", [OWNER, MEMBER]);
    await writeNote(both, "learned with the member");
    await expect(deliver(MAINLINE)).resolves.toEqual(["learned with the member"]);
  });

  it("does not count a seat whose holder can no longer read the Project", async () => {
    if (!db.available) return;
    // Leaving a Project deletes `project_members` and leaves every
    // `room_user_members` row active. Such a seat is not part of any audience:
    // it neither widens the target (the outsider would not receive the reply)
    // nor the origin (they could not have read the conversation).
    await db.pool.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [PROJECT, OUTSIDER]);
    const withPhantom = await makeRoom("With a phantom", [OWNER, OUTSIDER]);
    const narrow = await makeRoom("Narrow", [OWNER]);
    await writeNote(narrow, "learned in the narrow Room");
    await writeNote(withPhantom, "learned beside the phantom");

    // The phantom Room's audience is {owner}: the narrow note may be spoken
    // there, and its own note may be spoken in the narrow Room.
    await expect(deliver(withPhantom)).resolves.toEqual(
      expect.arrayContaining(["learned in the narrow Room", "learned beside the phantom"]),
    );
    await expect(deliver(narrow)).resolves.toEqual(
      expect.arrayContaining(["learned in the narrow Room", "learned beside the phantom"]),
    );
  });

  it("delivers nothing across into a Room with nobody in it", async () => {
    if (!db.available) return;
    // Vacuously a subset of every Room — but its transcript outlives the
    // emptiness, and whoever is added next would read what was said there.
    const empty = await makeRoom("Empty", []);
    await writeNote(MAINLINE, "learned in the wide Room");

    await expect(deliver(empty)).resolves.toEqual([]);
  });

  it("delivers the persona everywhere, and follows a roster that changed since", async () => {
    if (!db.available) return;
    const narrow = await makeRoom("Narrow", [OWNER]);
    await writeNote(narrow, "learned in the narrow Room");
    await db.pool.query(
      `INSERT INTO memory_entries (id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
                                   owner_user_id, agent_id, sensitivity_level, access_level, namespace, title,
                                   visibility, confidence, importance, version, access_count)
       VALUES ($1,$2,'agent','persona','who I am','active',now(),now(),$3,$4,'normal','full','agent.default','p','private',1,0.5,1,0)`,
      [randomUUID(), SPACE, OWNER, AGENT_ID],
    );

    await expect(deliver(MAINLINE)).resolves.toEqual(["who I am"]);
    // Seat every other Project reader in the narrow Room too and the subset
    // holds both ways — the test is against the *current* roster, because ADR
    // 0018 makes that the answer to who may see a Room.
    await seatRoom(narrow, [MEMBER, OUTSIDER]);
    await expect(deliver(MAINLINE)).resolves.toEqual(
      expect.arrayContaining(["who I am", "learned in the narrow Room"]),
    );
  });
});
