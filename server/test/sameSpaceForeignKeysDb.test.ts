import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { seedRun, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { useTestDatabase } from "./support/testDatabase.js";

// Space isolation enforced by PostgreSQL itself: a child row's space_id is part
// of its composite foreign key, so a row in one Space cannot point at a parent
// that lives in another, whatever the service layer does.
const db = useTestDatabase(import.meta.filename);

type World = {
  space: string; owner: string; agent: string; version: string; run: string; childRun: string;
  objectA: string; objectB: string; claim: string; note: string; collection: string;
  group: string; delegation: string;
};

async function seedWorld(): Promise<World> {
  const p = db.pool;
  const w: World = {
    space: randomUUID(), owner: randomUUID(), agent: randomUUID(), version: randomUUID(), run: randomUUID(), childRun: randomUUID(),
    objectA: randomUUID(), objectB: randomUUID(), claim: randomUUID(), note: randomUUID(), collection: randomUUID(),
    group: randomUUID(), delegation: randomUUID(),
  };
  await seedSpaceOwnerProject(p, { space: w.space, owner: w.owner, project: randomUUID() });
  await seedRun(p, { id: w.run, space: w.space, owner: w.owner, agent: w.agent, version: w.version });
  await seedRun(p, { id: w.childRun, space: w.space, owner: w.owner, agent: w.agent, version: w.version, existingAgent: true });
  for (const [id, type] of [[w.objectA, "concept"], [w.objectB, "concept"], [w.claim, "claim"], [w.note, "note"]]) {
    await p.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, created_at, updated_at) VALUES ($1,$2,$3,'Object',now(),now())`,
      [id, w.space, type],
    );
  }
  await p.query(
    `INSERT INTO claims (object_id, space_id, subject_object_id, claim_kind, claim_text, normalized_claim_hash, confidence_method, resolution_state)
     VALUES ($1,$2,$3,'fact','Water is wet.','hash','human_confirmed','unreviewed')`,
    [w.claim, w.space, w.objectA],
  );
  await p.query(`INSERT INTO notes (object_id, space_id, content_format, content_schema_version) VALUES ($1,$2,'markdown',1)`, [w.note, w.space]);
  await p.query(
    `INSERT INTO note_collections (id, space_id, parent_id, name, system_role, sort_order, is_system, is_hidden, created_at, updated_at)
     VALUES ($1,$2,NULL,'Collection','normal',0,false,false,now(),now())`,
    [w.collection, w.space],
  );
  await p.query(
    `INSERT INTO agent_run_groups (id, space_id, root_run_id, manager_user_id, title, goal, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'Group','Work','active',now(),now())`,
    [w.group, w.space, w.run, w.owner],
  );
  await p.query(
    `INSERT INTO run_delegations (id, space_id, group_id, parent_run_id, requesting_agent_id, target_agent_id, status, instruction, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$5,'requested','Work',now(),now())`,
    [w.delegation, w.space, w.group, w.run, w.agent],
  );
  return w;
}

let home: World;
let foreign: World;

beforeAll(async () => {
  if (!db.available) return;
  home = await seedWorld();
  foreign = await seedWorld();
});

type Statement = [sql: string, params: unknown[]];
// Each case writes a row in `home`; `valid` points at home's own parent, `crossSpace`
// at the foreign Space's parent with every other reference kept in `home` (the
// self-link case instead repeats one endpoint).
type Case = { constraint: string; code: string; rule: string; valid: () => Statement; crossSpace: () => Statement };

const relation = (from: () => string, to: () => string): (() => Statement) => () => [
  `INSERT INTO object_relations (id, space_id, from_object_id, to_object_id, link_type, status, created_at, updated_at)
   VALUES ($1,$2,$3,$4,'related_to','active',now(),now())`,
  [randomUUID(), home.space, from(), to()],
];
const claimSource = (claim: () => string): (() => Statement) => () => [
  `INSERT INTO claim_sources (id, space_id, claim_id, source_object_id, evidence_role, created_at)
   VALUES ($1,$2,$3,$4,'supports',now())`,
  [randomUUID(), home.space, claim(), home.objectA],
];
const collectionItem = (collection: () => string, note: () => string): (() => Statement) => () => [
  `INSERT INTO note_collection_items (id, space_id, collection_id, note_id, sort_order, created_at) VALUES ($1,$2,$3,$4,0,now())`,
  [randomUUID(), home.space, collection(), note()],
];
const childCollection = (parent: () => string): (() => Statement) => () => [
  `INSERT INTO note_collections (id, space_id, parent_id, name, system_role, sort_order, is_system, is_hidden, created_at, updated_at)
   VALUES ($1,$2,$3,'Child','normal',1,false,false,now(),now())`,
  [randomUUID(), home.space, parent()],
];
const runDelegation = (delegation: () => string): (() => Statement) => () => [
  `UPDATE runs SET parent_run_id=$2, delegation_id=$3 WHERE id=$1`,
  [home.childRun, home.run, delegation()],
];
const delegationInGroup = (group: () => string): (() => Statement) => () => [
  `INSERT INTO run_delegations (id, space_id, group_id, parent_run_id, requesting_agent_id, target_agent_id, status, instruction, created_at, updated_at)
   VALUES ($1,$2,$3,$4,$5,$5,'requested','More work',now(),now())`,
  [randomUUID(), home.space, group(), home.run, home.agent],
];
const groupMember = (agent: () => string): (() => Statement) => () => [
  `INSERT INTO agent_run_group_members (id, space_id, group_id, agent_id, role, status, created_at, updated_at)
   VALUES ($1,$2,$3,$4,'worker','active',now(),now())`,
  [randomUUID(), home.space, home.group, agent()],
];

const cases: Case[] = [
  { constraint: "object_relations_from_object_id_fkey", code: "23503", rule: "rejects a reference into another Space",
    valid: relation(() => home.objectA, () => home.objectB), crossSpace: relation(() => foreign.objectA, () => home.objectB) },
  { constraint: "object_relations_to_object_id_fkey", code: "23503", rule: "rejects a reference into another Space",
    valid: relation(() => home.objectA, () => home.objectB), crossSpace: relation(() => home.objectA, () => foreign.objectB) },
  // Not a Space rule, but the same edge table: an object cannot link to itself.
  { constraint: "ck_object_relations_no_self", code: "23514", rule: "rejects an object linked to itself",
    valid: relation(() => home.objectA, () => home.objectB), crossSpace: relation(() => home.objectA, () => home.objectA) },
  { constraint: "claim_sources_claim_id_fkey", code: "23503", rule: "rejects a reference into another Space",
    valid: claimSource(() => home.claim), crossSpace: claimSource(() => foreign.claim) },
  { constraint: "note_collection_items_collection_id_space_id_fkey", code: "23503", rule: "rejects a reference into another Space",
    valid: collectionItem(() => home.collection, () => home.note), crossSpace: collectionItem(() => foreign.collection, () => home.note) },
  { constraint: "note_collection_items_note_id_space_id_fkey", code: "23503", rule: "rejects a reference into another Space",
    valid: collectionItem(() => home.collection, () => home.note), crossSpace: collectionItem(() => home.collection, () => foreign.note) },
  { constraint: "note_collections_parent_id_space_id_fkey", code: "23503", rule: "rejects a reference into another Space",
    valid: childCollection(() => home.collection), crossSpace: childCollection(() => foreign.collection) },
  { constraint: "fk_runs_delegation_same_space", code: "23503", rule: "rejects a reference into another Space",
    valid: runDelegation(() => home.delegation), crossSpace: runDelegation(() => foreign.delegation) },
  { constraint: "fk_run_delegations_group_same_space", code: "23503", rule: "rejects a reference into another Space",
    valid: delegationInGroup(() => home.group), crossSpace: delegationInGroup(() => foreign.group) },
  { constraint: "fk_agent_run_group_members_agent_same_space", code: "23503", rule: "rejects a reference into another Space",
    valid: groupMember(() => home.agent), crossSpace: groupMember(() => foreign.agent) },
];

describe("same-Space foreign keys", () => {
  it.each(cases)("$constraint $rule", async ({ constraint, code, valid, crossSpace }) => {
    // Each case runs in its own rolled-back transaction, so the seeded worlds stay
    // untouched and the valid write cannot collide with another case's.
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const [validSql, validParams] = valid();
      const ok = await client.query(validSql, validParams);
      expect(ok.rowCount).toBe(1);
      await client.query("SAVEPOINT cross_space");
      const [crossSql, crossParams] = crossSpace();
      await expect(client.query(crossSql, crossParams)).rejects.toMatchObject({ code, constraint });
      await client.query("ROLLBACK TO SAVEPOINT cross_space");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
