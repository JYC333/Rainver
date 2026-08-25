import { beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import { RelationsRepository } from "../src/modules/relations/repository";
import { RelationsService } from "../src/modules/relations/service";

// Real-Postgres coverage for Relation Core: the space_objects composite-FK
// extension pattern, proposal-gated canonical affiliation edges, and space isolation across relation
// entities. A FakeDb unit test cannot catch constraint/FK-shape bugs here.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";


const db = useTestDatabase(__filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["relation_source_links", "relation_notes", "relation_identities", "relation_organizations", "relation_people", "object_relations", "space_objects", "users", "spaces"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'User', 'active', now(), now())`,
    [USER],
  );
  for (const spaceId of [SPACE, OTHER_SPACE]) {
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ($1, 'Relations Space', 'household', $2, now(), now())`,
      [spaceId, USER],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES (gen_random_uuid()::varchar, $1, $2, 'owner', 'active', now(), now())`,
      [spaceId, USER],
    );
  }
});

class PrivateCreationRelationsService extends RelationsService {
  override createPerson(
    identity: Parameters<RelationsService["createPerson"]>[0],
    body: Parameters<RelationsService["createPerson"]>[1],
  ) {
    return super.createPerson(identity, { visibility: "private", ...body });
  }

  override createOrganization(
    identity: Parameters<RelationsService["createOrganization"]>[0],
    body: Parameters<RelationsService["createOrganization"]>[1],
  ) {
    return super.createOrganization(identity, { visibility: "private", ...body });
  }
}

function service(): RelationsService {
  // Route-level creation resolution is outside this repository integration
  // suite; its direct service calls model an already-resolved private context.
  return new PrivateCreationRelationsService(db.pool as Pool, new RelationsRepository(db.pool as Pool));
}

describe("relations module (real Postgres)", () => {
  it("creates and reads a relation person", async () => {
    if (!db.available) return;
    const person = await service().createPerson(
      { spaceId: SPACE, userId: USER },
      { title: "Ada Lovelace", summary: "Mathematician", pronouns: "she/her", headline: "Analytical Engine pioneer" },
    );
    expect(person.title).toBe("Ada Lovelace");
    expect(person.pronouns).toBe("she/her");
    expect(person.headline).toBe("Analytical Engine pioneer");

    const fetched = await service().getPerson({ spaceId: SPACE, userId: USER }, person.object_id);
    expect(fetched.object_id).toBe(person.object_id);
  });

  it("updates a person's fields, including clearing summary with an explicit null", async () => {
    if (!db.available) return;
    const person = await service().createPerson(
      { spaceId: SPACE, userId: USER },
      { title: "Hedy Lamarr", summary: "Actress and inventor", pronouns: "she/her" },
    );
    const renamed = await service().updatePerson({ spaceId: SPACE, userId: USER }, person.object_id, {
      title: "Hedy Lamarr (updated)",
      summary: null,
    });
    expect(renamed.title).toBe("Hedy Lamarr (updated)");
    expect(renamed.summary).toBeNull();
    expect(renamed.pronouns).toBe("she/her");

    await expect(
      service().updatePerson({ spaceId: SPACE, userId: USER }, "does-not-exist", { title: "Nope" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("paginates listPeople honoring the requested limit and offset", async () => {
    if (!db.available) return;
    for (const name of ["Person A", "Person B", "Person C", "Person D"]) {
      await service().createPerson({ spaceId: SPACE, userId: USER }, { title: name });
    }
    const firstPage = await service().listPeople({ spaceId: SPACE, userId: USER }, { q: null, limit: 2, offset: 0 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.total).toBe(4);
    expect(firstPage.items.map((p) => p.title)).toEqual(["Person A", "Person B"]);

    const secondPage = await service().listPeople({ spaceId: SPACE, userId: USER }, { q: null, limit: 2, offset: 2 });
    expect(secondPage.items.map((p) => p.title)).toEqual(["Person C", "Person D"]);
  });

  it("rejects reading a person from another space", async () => {
    if (!db.available) return;
    const person = await service().createPerson({ spaceId: SPACE, userId: USER }, { title: "Alan Turing" });
    await expect(service().getPerson({ spaceId: OTHER_SPACE, userId: USER }, person.object_id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("creates an organization with org_type and parent linkage", async () => {
    if (!db.available) return;
    const university = await service().createOrganization({ spaceId: SPACE, userId: USER }, {
      title: "Stanford University",
      org_type: "university",
      homepage_url: "https://stanford.edu",
    });
    expect(university.org_type).toBe("university");

    const lab = await service().createOrganization({ spaceId: SPACE, userId: USER }, {
      title: "AI Lab",
      org_type: "lab",
      parent_organization_object_id: university.object_id,
    });
    expect(lab.parent_organization_object_id).toBe(university.object_id);
  });

  it("rejects an invalid org_type", async () => {
    if (!db.available) return;
    await expect(
      service().createOrganization({ spaceId: SPACE, userId: USER }, { title: "Bad Org", org_type: "not_a_type" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("creates identities and enforces the unique (space, object, type, value) index", async () => {
    if (!db.available) return;
    const person = await service().createPerson({ spaceId: SPACE, userId: USER }, { title: "Grace Hopper" });
    const identity = await service().createIdentity({ spaceId: SPACE, userId: USER }, person.object_id, {
      id_type: "email",
      id_value: "grace@example.com",
      is_primary: true,
    });
    expect(identity.id_type).toBe("email");

    await expect(db.pool.query(
      `INSERT INTO relation_identities (id, space_id, object_id, id_type, id_value, is_primary, source, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'email', 'grace@example.com', false, 'manual', now(), now())`,
      [SPACE, person.object_id],
    )).rejects.toThrow();

    const identities = await service().listIdentities({ spaceId: SPACE, userId: USER }, person.object_id);
    expect(identities).toHaveLength(1);
  });

  it("creates a pending proposal instead of directly writing an affiliation edge", async () => {
    if (!db.available) return;
    const person = await service().createPerson({ spaceId: SPACE, userId: USER }, { title: "Barbara Liskov" });
    const org = await service().createOrganization({ spaceId: SPACE, userId: USER }, { title: "MIT", org_type: "university" });

    const proposal = await service().createAffiliation({ spaceId: SPACE, userId: USER }, {
      person_object_id: person.object_id,
      organization_object_id: org.object_id,
      role: "professor",
      title: "Professor of Computer Science",
    });
    expect(proposal).toMatchObject({ proposal_type: "object_relation_create", status: "pending" });
    const stored = await db.pool.query<{ payload_json: Record<string, unknown> }>(
      `SELECT payload_json FROM proposals WHERE id=$1`,
      [proposal.id],
    );
    expect(stored.rows[0]!.payload_json).toMatchObject({
      operation: "object_relation_create",
      from_object_id: person.object_id,
      to_object_id: org.object_id,
      link_type: "affiliated_with",
      metadata: expect.objectContaining({ role: "professor", title: "Professor of Computer Science" }),
    });

    const edgeResult = await db.pool.query(
      `SELECT link_type, status FROM object_relations WHERE from_object_id = $1 AND to_object_id = $2`,
      [person.object_id, org.object_id],
    );
    expect(edgeResult.rows).toHaveLength(0);

    const approved = await db.pool.query<{ id: string }>(
      `INSERT INTO object_relations (
         id, space_id, from_object_id, to_object_id, link_type, status,
         confidence, metadata_json, created_by_user_id, created_at, updated_at
       ) VALUES (gen_random_uuid()::varchar,$1,$2,$3,'affiliated_with','active',0.9,$4::jsonb,$5,now(),now())
       RETURNING id`,
      [SPACE, person.object_id, org.object_id, JSON.stringify({ role: "professor", source: "manual" }), USER],
    );
    await expect(service().listAffiliations(
      { spaceId: SPACE, userId: USER },
      { personObjectId: person.object_id, organizationObjectId: org.object_id },
    )).resolves.toEqual([expect.objectContaining({ id: approved.rows[0]!.id, role: "professor" })]);

    const archiveProposal = await service().endAffiliation(
      { spaceId: SPACE, userId: USER },
      approved.rows[0]!.id,
      "2020-01-01T00:00:00.000Z",
    );
    expect(archiveProposal).toMatchObject({ proposal_type: "object_relation_delete", status: "pending" });
    expect((await db.pool.query(`SELECT status FROM object_relations WHERE id=$1`, [approved.rows[0]!.id])).rows[0]!.status).toBe("active");
  });

  it("rejects an affiliation referencing a person from another space", async () => {
    if (!db.available) return;
    const person = await service().createPerson({ spaceId: OTHER_SPACE, userId: USER }, { title: "Cross Space Person" });
    const org = await service().createOrganization({ spaceId: SPACE, userId: USER }, { title: "Local Org", org_type: "company" });
    await expect(
      service().createAffiliation({ spaceId: SPACE, userId: USER }, {
        person_object_id: person.object_id,
        organization_object_id: org.object_id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("creates and lists relation notes", async () => {
    if (!db.available) return;
    const person = await service().createPerson({ spaceId: SPACE, userId: USER }, { title: "Katherine Johnson" });
    await service().createNote({ spaceId: SPACE, userId: USER }, person.object_id, { body: "Met at a conference in 2024." });
    const notes = await service().listNotes({ spaceId: SPACE, userId: USER }, person.object_id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe("Met at a conference in 2024.");
  });

  it("creates and lists relation source links", async () => {
    if (!db.available) return;
    const person = await service().createPerson({ spaceId: SPACE, userId: USER }, { title: "Margaret Hamilton" });
    await service().createSourceLink({ spaceId: SPACE, userId: USER }, person.object_id, {
      link_type: "external",
      external_ref: "https://example.com/bio",
    });
    const links = await service().listSourceLinks({ spaceId: SPACE, userId: USER }, person.object_id);
    expect(links).toHaveLength(1);
    expect(links[0]!.link_type).toBe("external");

    await expect(db.pool.query(
      `INSERT INTO relation_source_links (
         id, space_id, object_id, link_type, created_by_user_id, created_at
       ) VALUES ($1,$2,$3,'external',$4,now())`,
      ["33333333-3333-4333-8333-333333333333", SPACE, person.object_id, USER],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(db.pool.query(
      `INSERT INTO relation_source_links (
         id, space_id, object_id, link_type, external_ref, created_by_user_id, created_at
       ) VALUES ($1,$2,$3,'activity','https://example.com/wrong-target',$4,now())`,
      ["44444444-4444-4444-8444-444444444444", SPACE, person.object_id, USER],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an invalid source link type", async () => {
    if (!db.available) return;
    const person = await service().createPerson({ spaceId: SPACE, userId: USER }, { title: "Invalid Link Target" });
    await expect(
      service().createSourceLink({ spaceId: SPACE, userId: USER }, person.object_id, { link_type: "not_a_type" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("does not write or reveal links to unreadable Source and Evidence endpoints", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1,'Other','active',$2,$2)`,
      [OTHER_USER, now],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES (gen_random_uuid()::varchar,$1,$2,'member','active',$3,$3)`,
      [SPACE, OTHER_USER, now],
    );
    const sourceItemId = "55555555-5555-4555-8555-555555555555";
    await db.pool.query(
      `INSERT INTO source_items (
         id, space_id, owner_user_id, visibility, access_level, item_type, title,
         first_seen_at, last_seen_at, content_state, retention_policy, created_at, updated_at
       ) VALUES ($1,$2,$3,'private','full','document','Private source',$4,$4,'excerpt_saved','summary_only',$4,$4)`,
      [sourceItemId, SPACE, OTHER_USER, now],
    );
    const evidenceId = "66666666-6666-4666-8666-666666666666";
    await db.pool.query(
      `INSERT INTO extracted_evidence (
         id, space_id, owner_user_id, visibility, access_level, source_item_id,
         evidence_type, title, content_excerpt, metadata_json, extraction_method,
         trust_level, status, created_at, updated_at
       ) VALUES ($1,$2,$3,'space_shared','full',$4,'excerpt','Derived evidence','Secret','{}'::jsonb,'manual','normal','active',$5,$5)`,
      [evidenceId, SPACE, OTHER_USER, sourceItemId, now],
    );
    const sourceObjectId = "88888888-8888-4888-8888-888888888888";
    await db.pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, visibility, access_level, owner_user_id, created_at, updated_at) VALUES ($1,$2,'source','Private canonical source','private','full',$3,$4,$4)`,
      [sourceObjectId, SPACE, OTHER_USER, now],
    );
    const objectEvidenceId = "99999999-9999-4999-8999-999999999999";
    await db.pool.query(
      `INSERT INTO extracted_evidence (
         id, space_id, owner_user_id, visibility, access_level, source_object_type,
         source_object_id, evidence_type, title, content_excerpt, metadata_json,
         extraction_method, trust_level, status, created_at, updated_at
       ) VALUES ($1,$2,$3,'space_shared','full','source',$4,'excerpt','Object evidence','Secret','{}'::jsonb,'manual','normal','active',$5,$5)`,
      [objectEvidenceId, SPACE, OTHER_USER, sourceObjectId, now],
    );
    const person = await service().createPerson({ spaceId: SPACE, userId: USER }, { title: "Private source boundary" });

    await expect(service().createSourceLink({ spaceId: SPACE, userId: USER }, person.object_id, {
      link_type: "source_item", source_item_id: sourceItemId,
    })).rejects.toMatchObject({ statusCode: 422 });
    await expect(service().createSourceLink({ spaceId: SPACE, userId: USER }, person.object_id, {
      link_type: "evidence", evidence_id: evidenceId,
    })).rejects.toMatchObject({ statusCode: 422 });
    await expect(service().createSourceLink({ spaceId: SPACE, userId: USER }, person.object_id, {
      link_type: "evidence", evidence_id: objectEvidenceId,
    })).rejects.toMatchObject({ statusCode: 422 });

    await db.pool.query(
      `INSERT INTO relation_source_links (
         id, space_id, object_id, link_type, source_item_id, created_by_user_id, created_at
       ) VALUES ($1,$2,$3,'source_item',$4,$5,$6)`,
      ["77777777-7777-4777-8777-777777777777", SPACE, person.object_id, sourceItemId, OTHER_USER, now],
    );
    await db.pool.query(
      `INSERT INTO relation_source_links (
         id, space_id, object_id, link_type, evidence_id, created_by_user_id, created_at
       ) VALUES ($1,$2,$3,'evidence',$4,$5,$6)`,
      ["aaaaaaaa-7777-4777-8777-777777777777", SPACE, person.object_id, objectEvidenceId, OTHER_USER, now],
    );
    await expect(service().listSourceLinks({ spaceId: SPACE, userId: USER }, person.object_id)).resolves.toEqual([]);
  });

  it("searches people and organizations by title within a space", async () => {
    if (!db.available) return;
    await service().createPerson({ spaceId: SPACE, userId: USER }, { title: "Radia Perlman" });
    await service().createOrganization({ spaceId: SPACE, userId: USER }, { title: "Perlman Labs", org_type: "lab" });
    await service().createPerson({ spaceId: OTHER_SPACE, userId: USER }, { title: "Perlman Impostor" });

    const results = await service().search({ spaceId: SPACE, userId: USER }, "Perlman", 20);
    expect(results.map((r) => r.title).sort()).toEqual(["Perlman Labs", "Radia Perlman"]);
  });

  it("archives a person via soft delete", async () => {
    if (!db.available) return;
    const person = await service().createPerson({ spaceId: SPACE, userId: USER }, { title: "To Be Archived" });
    await service().archivePerson({ spaceId: SPACE, userId: USER }, person.object_id);
    const result = await db.pool.query(`SELECT status FROM relation_people WHERE object_id = $1`, [person.object_id]);
    expect(result.rows[0].status).toBe("archived");
  });
});
