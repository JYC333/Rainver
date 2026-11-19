import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { DecisionCaseService } from "../src/modules/decisions/caseService.js";
import { RelationsService } from "../src/modules/relations/service.js";
import { RelationsRepository } from "../src/modules/relations/repository.js";
import { ContentAccessAuditService } from "../src/modules/contentAccess/audit.js";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common.js";

/**
 * Readable is not writable, a summary reader is not served the body, and a
 * cross-person body read is recorded (B11) before it is released — for
 * Decision Cases and relation people/organizations, against real Postgres.
 *
 * A owns the content; B is an ordinary Project member; C is a Space admin
 * reading through oversight.
 */
const SPACE = "31313131-3131-4131-8131-313131313131";
const PROJECT = "32323232-3232-4232-8232-323232323232";
const A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const C = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const as = (userId: string): SpaceUserIdentity => ({ spaceId: SPACE, userId });

const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["content_access_logs", "content_access_grants", "decision_option_scores", "decision_commitments", "decision_criteria", "decision_options", "decision_cases", "relation_notes", "relation_identities", "relation_source_links", "object_relations", "relation_people", "relation_organizations", "space_objects", "tasks", "projects", "space_memberships", "users", "spaces"], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: A, project: PROJECT, spaceType: "team" });
  await seedSpaceMember(db.pool, { space: SPACE, user: B });
  await seedSpaceMember(db.pool, { space: SPACE, user: C, role: "admin" });
  for (const user of [B, C]) {
    await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())", [randomUUID(), SPACE, PROJECT, user]);
  }
});

async function setAccess(objectId: string, visibility: string, accessLevel = "full"): Promise<void> {
  await db.pool.query("UPDATE space_objects SET visibility=$2, access_level=$3 WHERE id=$1", [objectId, visibility, accessLevel]);
}

async function grant(objectId: string, grantee: string, level: "full" | "summary"): Promise<void> {
  await db.pool.query(
    "INSERT INTO content_access_grants(id,space_id,resource_type,resource_id,grantee_user_id,access_level,granted_by_user_id,created_at,updated_at) VALUES($1,$2,'space_object',$3,$4,$5,$6,now(),now())",
    [randomUUID(), SPACE, objectId, grantee, level, A],
  );
}

async function logs(objectId: string): Promise<Array<{ viewer_user_id: string; access_type: string }>> {
  return (await db.pool.query("SELECT viewer_user_id, access_type FROM content_access_logs WHERE resource_id=$1 ORDER BY accessed_at, access_type", [objectId])).rows;
}

async function failAudit(): Promise<void> {
  await db.pool.query(`CREATE OR REPLACE FUNCTION rv_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit store unavailable'; END $$`);
  await db.pool.query("CREATE TRIGGER rv_fail_audit BEFORE INSERT ON content_access_logs FOR EACH ROW EXECUTE FUNCTION rv_fail_audit()");
}

async function restoreAudit(): Promise<void> {
  await db.pool.query("DROP TRIGGER IF EXISTS rv_fail_audit ON content_access_logs");
}

async function seededCase(): Promise<{ id: string; optionId: string; criterionId: string }> {
  const cases = new DecisionCaseService(db.pool);
  const created = await cases.createCase(as(A), PROJECT, { title: "Pick a vendor", framing: "Private budget reasoning" });
  const id = created.id as string;
  const option = await cases.addOption(as(A), PROJECT, id, { title: "Vendor A", description: "A's private notes" });
  const criterion = await cases.addCriterion(as(A), PROJECT, id, { name: "Cost" });
  await cases.scoreOption(as(A), PROJECT, id, { option_id: option.id, criterion_id: criterion.id, score: 4, rationale: "secret rationale" });
  return { id, optionId: option.id as string, criterionId: criterion.id as string };
}

/** Every write entry point of a Case, as the person `who`. */
function writes(who: string, c: { id: string; optionId: string; criterionId: string }) {
  const cases = new DecisionCaseService(db.pool);
  return {
    admission: () => cases.authorizeMutation(as(who), PROJECT, { caseId: c.id }),
    addOption: () => cases.addOption(as(who), PROJECT, c.id, { title: "intruder" }),
    addCriterion: () => cases.addCriterion(as(who), PROJECT, c.id, { name: "intruder" }),
    score: () => cases.scoreOption(as(who), PROJECT, c.id, { option_id: c.optionId, criterion_id: c.criterionId, score: 1, rationale: "overwritten" }),
    decide: () => cases.decide(as(who), PROJECT, c.id, { option_id: c.optionId }),
  };
}

async function expectNoWrite(who: string, c: { id: string; optionId: string; criterionId: string }): Promise<void> {
  for (const [name, attempt] of Object.entries(writes(who, c))) {
    await expect(attempt(), name).rejects.toMatchObject({ statusCode: 404 });
  }
  const state = await db.pool.query("SELECT c.status, (SELECT count(*)::int FROM decision_options o WHERE o.decision_case_id=c.object_id) AS options, (SELECT rationale FROM decision_option_scores s WHERE s.decision_case_id=c.object_id) AS rationale FROM decision_cases c WHERE c.object_id=$1", [c.id]);
  expect(state.rows[0]).toEqual({ status: "open", options: 1, rationale: "secret rationale" });
}

describe("Decision Case write rule", () => {
  it("lets a Project writer change a space_shared full Case, and the owner change their own private one", async () => {
    if (!db.available) return;
    const c = await seededCase();
    await expect(writes(B, c).admission()).resolves.toBeUndefined();
    await expect(writes(B, c).addOption()).resolves.toMatchObject({ title: "intruder" });
    await setAccess(c.id, "private");
    await expect(writes(A, c).admission()).resolves.toBeUndefined();
    await expect(writes(A, c).decide()).resolves.toMatchObject({ status: "decided", framing: "Private budget reasoning", effective_access_level: "full" });
  });

  it("refuses a selected_users grantee, even at full", async () => {
    if (!db.available) return;
    const c = await seededCase();
    await setAccess(c.id, "selected_users");
    await grant(c.id, B, "full");
    await expect(new DecisionCaseService(db.pool).getCase(as(B), PROJECT, c.id)).resolves.toMatchObject({ framing: "Private budget reasoning" });
    await expectNoWrite(B, c);
  });

  it("refuses a summary-level reader", async () => {
    if (!db.available) return;
    const c = await seededCase();
    await setAccess(c.id, "space_shared", "summary");
    await expectNoWrite(B, c);
  });

  it("refuses an oversight admin who can read a member's private Case", async () => {
    if (!db.available) return;
    const c = await seededCase();
    await setAccess(c.id, "private");
    await db.pool.query("UPDATE spaces SET oversight_mode='content' WHERE id=$1", [SPACE]);
    await expect(new DecisionCaseService(db.pool).getCase(as(C), PROJECT, c.id)).resolves.toMatchObject({ framing: "Private budget reasoning" });
    await expectNoWrite(C, c);
  });
});

describe("Decision Case read projection and B11 audit", () => {
  it("serves a summary reader the Case's existence and nothing it holds, and records nothing", async () => {
    if (!db.available) return;
    const c = await seededCase();
    await setAccess(c.id, "space_shared", "summary");
    const cases = new DecisionCaseService(db.pool);
    const detail = await cases.getCase(as(B), PROJECT, c.id);
    expect(detail).toMatchObject({ id: c.id, title: "Pick a vendor", status: "open", framing: null, effective_access_level: "summary", options: [], criteria: [], scores: [], commitments: [] });
    expect(JSON.stringify(detail)).not.toMatch(/Private budget|secret rationale|private notes/);
    const list = await cases.listCases(as(B), PROJECT);
    expect(list).toEqual([expect.objectContaining({ id: c.id, framing: null, effective_access_level: "summary" })]);
    // A selected_users summary grant is the same level.
    await setAccess(c.id, "selected_users");
    await grant(c.id, B, "summary");
    expect(await cases.getCase(as(B), PROJECT, c.id)).toMatchObject({ framing: null, options: [] });
    expect(await logs(c.id)).toEqual([]);
    // The owner still reads all of it.
    expect(await cases.getCase(as(A), PROJECT, c.id)).toMatchObject({ framing: "Private budget reasoning", effective_access_level: "full" });
  });

  it("records cross-person full reads, including oversight, never the owner's, and shows them to the owner", async () => {
    if (!db.available) return;
    const c = await seededCase();
    const cases = new DecisionCaseService(db.pool);
    await cases.getCase(as(A), PROJECT, c.id);
    await cases.listCases(as(A), PROJECT);
    expect(await logs(c.id)).toEqual([]);
    await cases.getCase(as(B), PROJECT, c.id);
    await cases.listCases(as(B), PROJECT);
    await setAccess(c.id, "private");
    await db.pool.query("UPDATE spaces SET oversight_mode='content' WHERE id=$1", [SPACE]);
    await cases.getCase(as(C), PROJECT, c.id);
    expect(await logs(c.id)).toEqual([
      expect.objectContaining({ viewer_user_id: B, access_type: "detail_read" }),
      expect.objectContaining({ viewer_user_id: B, access_type: "list_read" }),
      expect.objectContaining({ viewer_user_id: C, access_type: "detail_read" }),
    ]);
    const ownerView = await new ContentAccessAuditService(db.pool).listForOwner({ spaceId: SPACE, resourceType: "space_object", resourceId: c.id, ownerUserId: A, limit: 10, offset: 0 });
    expect(ownerView.items.map((item) => item.viewer_user_id).sort()).toEqual([B, B, C].sort());
    // A write's own authorization read is not a read.
    const before = (await logs(c.id)).length;
    await setAccess(c.id, "space_shared");
    await writes(B, c).addCriterion();
    expect((await logs(c.id)).length).toBe(before);
  });

  it("serves nothing when the audit cannot be written", async () => {
    if (!db.available) return;
    const c = await seededCase();
    const cases = new DecisionCaseService(db.pool);
    await failAudit();
    try {
      await expect(cases.getCase(as(B), PROJECT, c.id)).rejects.toMatchObject({ statusCode: 503 });
      await expect(cases.listCases(as(B), PROJECT)).rejects.toMatchObject({ statusCode: 503 });
      // The owner's read records nothing and is unaffected.
      await expect(cases.getCase(as(A), PROJECT, c.id)).resolves.toMatchObject({ framing: "Private budget reasoning" });
    } finally {
      await restoreAudit();
    }
  });
});

describe("Relation read projection and B11 audit", () => {
  async function seededPerson(): Promise<{ person: string; org: string }> {
    const service = new RelationsService(db.pool, new RelationsRepository(db.pool));
    const person = await service.createPerson(as(A), { title: "Dana", summary: "Met at the clinic", pronouns: "they/them", headline: "Patient advocate", visibility: "space_shared" });
    const org = await service.createOrganization(as(A), { title: "Clinic", summary: "Private org note", homepage_url: "https://clinic.example", visibility: "space_shared" });
    await service.createIdentity(as(A), person.object_id, { id_type: "email", id_value: "dana@private.example" });
    await service.createNote(as(A), person.object_id, { body: "Owes me a call" });
    await service.createSourceLink(as(A), person.object_id, { link_type: "external", external_ref: "https://private.example/thread", note: "where we met" });
    await db.pool.query(
      `INSERT INTO object_relations (id, space_id, from_object_id, to_object_id, link_type, status, metadata_json, created_by_user_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'affiliated_with','active',$5::jsonb,$6,now(),now())`,
      [randomUUID(), SPACE, person.object_id, org.object_id, JSON.stringify({ role: "volunteer", title: "Night shift" }), A],
    );
    return { person: person.object_id, org: org.object_id };
  }

  const relations = () => new RelationsService(db.pool, new RelationsRepository(db.pool));

  async function everyRead(who: string, ids: { person: string; org: string }) {
    const s = relations();
    return {
      person: await s.getPerson(as(who), ids.person),
      people: (await s.listPeople(as(who), { q: null, limit: 10, offset: 0 })).items,
      org: await s.getOrganization(as(who), ids.org),
      orgs: (await s.listOrganizations(as(who), { q: null, limit: 10, offset: 0 })).items,
      identities: await s.listIdentities(as(who), ids.person),
      notes: await s.listNotes(as(who), ids.person),
      links: await s.listSourceLinks(as(who), ids.person),
      affiliations: await s.listAffiliations(as(who), { personObjectId: ids.person, organizationObjectId: null }),
    };
  }

  it("withholds what the owner wrote from a summary reader, keeping the metadata", async () => {
    if (!db.available) return;
    const ids = await seededPerson();
    await setAccess(ids.person, "space_shared", "summary");
    await setAccess(ids.org, "selected_users");
    await grant(ids.org, B, "summary");
    const read = await everyRead(B, ids);
    expect(JSON.stringify(read)).not.toMatch(/clinic\.example|Met at the clinic|they\/them|Patient advocate|Private org note|dana@private|Owes me a call|private\.example\/thread|where we met|volunteer|Night shift/);
    expect(read.person).toMatchObject({ object_id: ids.person, title: "Dana", summary: null, pronouns: null, headline: null, effective_access_level: "summary" });
    expect(read.org).toMatchObject({ title: "Clinic", homepage_url: null, effective_access_level: "summary" });
    expect(read.identities).toEqual([expect.objectContaining({ id_type: "email", id_value: null })]);
    expect(read.notes).toEqual([expect.objectContaining({ body: null })]);
    expect(read.links).toEqual([expect.objectContaining({ link_type: "external", external_ref: null, note: null })]);
    expect(read.affiliations).toEqual([expect.objectContaining({ role: null, title: null })]);
    expect(await logs(ids.person)).toEqual([]);
    expect(await logs(ids.org)).toEqual([]);
  });

  it("serves full reads to a full grantee and to oversight, records them, never the owner's", async () => {
    if (!db.available) return;
    const ids = await seededPerson();
    await everyRead(A, ids);
    expect(await logs(ids.person)).toEqual([]);
    await setAccess(ids.person, "selected_users");
    await grant(ids.person, B, "full");
    const read = await everyRead(B, ids);
    expect(read.person).toMatchObject({ summary: "Met at the clinic", effective_access_level: "full" });
    expect(read.identities[0]).toMatchObject({ id_value: "dana@private.example" });
    expect(read.affiliations[0]).toMatchObject({ role: "volunteer" });
    const types = (await logs(ids.person)).filter((row) => row.viewer_user_id === B).map((row) => row.access_type).sort();
    // getPerson, listPeople, three sub-resources, affiliations.
    expect(types).toEqual(["detail_read", "detail_read", "detail_read", "detail_read", "list_read", "list_read"]);
    await setAccess(ids.person, "private");
    await db.pool.query("UPDATE spaces SET oversight_mode='content' WHERE id=$1", [SPACE]);
    expect((await relations().getPerson(as(C), ids.person)).summary).toBe("Met at the clinic");
    expect((await logs(ids.person)).some((row) => row.viewer_user_id === C)).toBe(true);
    // Writes stay owner-only, oversight or not.
    await expect(relations().createNote(as(C), ids.person, { body: "x" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("serves nothing when the audit cannot be written", async () => {
    if (!db.available) return;
    const ids = await seededPerson();
    await failAudit();
    try {
      await expect(relations().getPerson(as(B), ids.person)).rejects.toMatchObject({ statusCode: 503 });
      await expect(relations().listNotes(as(B), ids.person)).rejects.toMatchObject({ statusCode: 503 });
      await expect(relations().listPeople(as(B), { q: null, limit: 10, offset: 0 })).rejects.toMatchObject({ statusCode: 503 });
      await expect(relations().getPerson(as(A), ids.person)).resolves.toMatchObject({ summary: "Met at the clinic" });
    } finally {
      await restoreAudit();
    }
  });
});
