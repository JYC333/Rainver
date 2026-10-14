import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ExecutionControlSnapshot } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { WorkContextService, runRetrievalSwitchedOn, workContextRetrievalSwitchedOn } from "../src/modules/runtimeContext/workContextService.js";
import { PgRetrievalIntentProvider } from "../src/modules/runtimeContext/productionAcquisition.js";
import type { RuntimeContextAuthoritySnapshot } from "../src/modules/runtimeContext/acquisitionComposition.js";
import type { RuntimeContextPlanningRequest } from "../src/modules/runtimeContext/planningService.js";

// The conversation knowledge-retrieval switch: off for a new conversation,
// kept per person and conversation as Work Context Setup versions, and
// deciding whether the planner searches at all.

const SPACE = "72000000-0000-4000-8000-000000000001";
const USER = "72000000-0000-4000-8000-000000000002";
const OTHER = "72000000-0000-4000-8000-000000000003";
const AGENT = "72000000-0000-4000-8000-000000000004";

const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["work_context_setups", "policy_decision_records", "sessions", "agents", "space_memberships", "users", "spaces"], { cascade: true });
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Switch','team',now(),now())`, [SPACE]);
  for (const id of [USER, OTHER]) {
    await db.pool.query(
      `INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source)
       VALUES ($1,'Person','active',now(),now(),lower(gen_random_uuid()::text || '@test.invalid'),'system')`,
      [id],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'member','active',now(),now())`,
      [randomUUID(), SPACE, id],
    );
  }
  await db.pool.query(
    `INSERT INTO agents (id,space_id,owner_user_id,name,status,agent_kind,visibility,access_level,created_at,updated_at)
     VALUES ($1,$2,$3,'Assistant','active','standard','space_shared','full',now(),now())`,
    [AGENT, SPACE, USER],
  );
});

async function directSession(userId: string): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO sessions (id,space_id,user_id,agent_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`,
    [id, SPACE, userId, AGENT],
  );
  return id;
}

function authority(setupId: string, version: number): RuntimeContextAuthoritySnapshot {
  return {
    executionControlSnapshotId: randomUUID(),
    setupRef: { type: "work_context_setup", id: setupId, version: String(version) },
    model: null,
    agentId: AGENT,
    projectId: null,
    egressDestination: "internal_process",
    controlSnapshot: {
      readable_scope: {
        retrieval_enabled: true,
        retrieval_max_candidates: 10,
        unrestricted_source_categories: ["retrieval"],
        allowed_source_types: [],
        allowed_source_ids: [],
        excluded_source_ids: [],
      },
    } as unknown as ExecutionControlSnapshot,
  };
}

function planning(scopeId: string, version: number): RuntimeContextPlanningRequest {
  return {
    identity: { spaceId: SPACE, userId: USER },
    turn: {
      work_context_scope_id: scopeId,
      expected_setup_version: version,
      current_message_ref: { type: "message", id: randomUUID() },
      one_off_refs: [],
      invocation_purpose: "conversation_turn",
      retrieval_intent: "launch plan",
    },
  } as unknown as RuntimeContextPlanningRequest;
}

describe("conversation knowledge-retrieval switch (real Postgres)", () => {
  it("is off for a new conversation, on only when the person turns it on, and kept per person and conversation", async () => {
    if (!db.available) return;
    const service = new WorkContextService(db.pool);
    const session = await directSession(USER);
    const identity = { spaceId: SPACE, userId: USER };
    await expect(service.getRetrievalSwitch(identity, session)).resolves.toEqual({
      work_context_scope_id: session, enabled: false, preferred_domains: [], setup_version: null,
    });

    const off = await service.setRetrievalSwitch(identity, session, { enabled: false });
    expect(off).toMatchObject({ enabled: false, setup_version: 1 });
    const setupV1 = (await db.pool.query<{ id: string }>(`SELECT id FROM work_context_setups WHERE work_context_scope_id=$1 AND version=1`, [session])).rows[0]!.id;
    const provider = new PgRetrievalIntentProvider(db.pool);
    await expect(provider.resolve(planning(session, 1), authority(setupV1, 1))).resolves.toBeNull();

    const on = await service.setRetrievalSwitch(identity, session, { enabled: true, preferred_domains: ["knowledge"] });
    expect(on).toEqual({ work_context_scope_id: session, enabled: true, preferred_domains: ["knowledge"], setup_version: 2 });
    const setupV2 = (await db.pool.query<{ id: string }>(`SELECT id FROM work_context_setups WHERE work_context_scope_id=$1 AND version=2`, [session])).rows[0]!.id;
    const intent = await provider.resolve(planning(session, 2), authority(setupV2, 2));
    expect(intent).toMatchObject({ query: "launch plan" });
    expect(intent!.objectTypes).toEqual(expect.arrayContaining(["knowledge_item"]));
    expect(intent!.objectTypes).not.toContain("memory_entry");

    // Another person's conversation, and another conversation of the same
    // person, each start off on their own.
    const otherSession = await directSession(OTHER);
    await expect(service.getRetrievalSwitch({ spaceId: SPACE, userId: OTHER }, otherSession)).resolves.toMatchObject({ enabled: false });
    const second = await directSession(USER);
    await expect(service.getRetrievalSwitch(identity, second)).resolves.toMatchObject({ enabled: false });
    // Someone else's conversation is not theirs to switch.
    await expect(service.setRetrievalSwitch({ spaceId: SPACE, userId: OTHER }, session, { enabled: true })).rejects.toBeTruthy();
    await expect(service.setRetrievalSwitch(identity, session, { enabled: "yes" })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("gives a conversation Run planned without any setup version no retrieval tools, and keeps them for other Runs", async () => {
    if (!db.available) return;
    const session = await directSession(USER);
    // No execution control snapshot names a setup for these Runs.
    await expect(runRetrievalSwitchedOn(db.pool, { id: randomUUID(), space_id: SPACE, session_id: session })).resolves.toBe(false);
    await expect(runRetrievalSwitchedOn(db.pool, { id: randomUUID(), space_id: SPACE, session_id: null })).resolves.toBe(true);
  });

  it("keeps the opt-out default for non-conversation scopes", () => {
    expect(workContextRetrievalSwitchedOn("direct_session", {})).toBe(false);
    expect(workContextRetrievalSwitchedOn("room_recipient", {})).toBe(false);
    expect(workContextRetrievalSwitchedOn("direct_session", { enabled: true })).toBe(true);
    expect(workContextRetrievalSwitchedOn("root_task", {})).toBe(true);
    expect(workContextRetrievalSwitchedOn("workflow_execution", { enabled: false })).toBe(false);
  });
});
