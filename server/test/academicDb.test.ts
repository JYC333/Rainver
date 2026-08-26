import { beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { AcademicRepository } from "../src/modules/academic/repository.js";
import { AcademicService } from "../src/modules/academic/service.js";
import { RelationsRepository } from "../src/modules/relations/repository.js";
import { RelationsService } from "../src/modules/relations/service.js";

// Real-Postgres coverage for the Academic Research preset's object extensions:
// papers built on the existing `sources` extension (not a new space_objects
// object_type), authored_by/cites object_relations edges, and space isolation.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["academic_papers", "sources", "relation_people", "object_relations", "space_objects", "users", "spaces"],
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
       VALUES ($1, 'Academic Space', 'household', $2, now(), now())`,
      [spaceId, USER],
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES (gen_random_uuid()::varchar, $1, $2, 'owner', 'active', now(), now())`,
      [spaceId, USER],
    );
  }
});

class PrivateCreationAcademicService extends AcademicService {
  override createPaper(
    identity: Parameters<AcademicService["createPaper"]>[0],
    body: Parameters<AcademicService["createPaper"]>[1],
  ) {
    return super.createPaper(identity, { visibility: "private", ...body });
  }
}

class PrivateCreationRelationsService extends RelationsService {
  override createPerson(
    identity: Parameters<RelationsService["createPerson"]>[0],
    body: Parameters<RelationsService["createPerson"]>[1],
  ) {
    return super.createPerson(identity, { visibility: "private", ...body });
  }
}

function service(): AcademicService {
  return new PrivateCreationAcademicService(db.pool as Pool, new AcademicRepository(db.pool as Pool));
}

function relationsService(): RelationsService {
  return new PrivateCreationRelationsService(db.pool as Pool, new RelationsRepository(db.pool as Pool));
}

const identity = { spaceId: SPACE, userId: USER };

describe("academic module (real Postgres)", () => {
  it("creates a paper backed by the sources extension (not a new object_type)", async () => {
    if (!db.available) return;
    const paper = await service().createPaper(identity, {
      title: "Attention Is All You Need",
      summary: "Introduces the Transformer architecture.",
      arxiv_id: "1706.03762",
      paper_type: "preprint",
    });
    expect(paper.title).toBe("Attention Is All You Need");
    expect(paper.arxiv_id).toBe("1706.03762");
    expect(paper.paper_type).toBe("preprint");

    const objectTypeResult = await db.pool.query(`SELECT object_type FROM space_objects WHERE id = $1`, [paper.object_id]);
    expect(objectTypeResult.rows[0].object_type).toBe("source");
    const sourceTypeResult = await db.pool.query(`SELECT source_type FROM sources WHERE object_id = $1`, [paper.object_id]);
    expect(sourceTypeResult.rows[0].source_type).toBe("paper");
  });

  it("rejects creating a duplicate paper by arxiv_id in the same space", async () => {
    if (!db.available) return;
    await service().createPaper(identity, { title: "Paper One", arxiv_id: "1111.11111" });
    await expect(service().createPaper(identity, { title: "Paper One Duplicate", arxiv_id: "1111.11111" })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("allows the same arxiv_id in different spaces", async () => {
    if (!db.available) return;
    await service().createPaper(identity, { title: "Paper One", arxiv_id: "2222.22222" });
    await expect(
      service().createPaper({ spaceId: OTHER_SPACE, userId: USER }, { title: "Paper One Elsewhere", arxiv_id: "2222.22222" }),
    ).resolves.toMatchObject({ arxiv_id: "2222.22222" });
  });

  it("rejects an invalid paper_type", async () => {
    if (!db.available) return;
    await expect(service().createPaper(identity, { title: "Bad Paper", paper_type: "not_a_type" })).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("proposes an authored_by edge without directly mutating the graph", async () => {
    if (!db.available) return;
    const paper = await service().createPaper(identity, { title: "Deep Learning Survey" });
    const person = await relationsService().createPerson(identity, { title: "Yann LeCun" });

    const proposal = await service().linkAuthor(identity, paper.object_id, { person_object_id: person.object_id, author_position: 1 });
    expect(proposal).toMatchObject({ proposal_type: "object_relation_create", status: "pending" });
    const stored = await db.pool.query<{ payload_json: Record<string, unknown> }>(
      `SELECT payload_json FROM proposals WHERE id=$1`,
      [proposal.id],
    );
    expect(stored.rows[0]!.payload_json).toMatchObject({
      link_type: "authored_by",
      metadata: { author_position: 1, is_corresponding: false },
    });

    const edgeResult = await db.pool.query(
      `SELECT link_type FROM object_relations WHERE from_object_id = $1 AND to_object_id = $2`,
      [paper.object_id, person.object_id],
    );
    expect(edgeResult.rows).toHaveLength(0);
  });

  it("lists author metadata from an approved canonical graph edge", async () => {
    if (!db.available) return;
    const paper = await service().createPaper(identity, { title: "Author Idempotency" });
    const person = await relationsService().createPerson(identity, { title: "First Author" });

    await db.pool.query(
      `INSERT INTO object_relations (
         id, space_id, from_object_id, to_object_id, link_type, status, metadata_json, created_by_user_id, created_at, updated_at
       ) VALUES (gen_random_uuid()::varchar,$1,$2,$3,'authored_by','active',$4::jsonb,$5,now(),now())`,
      [SPACE, paper.object_id, person.object_id, JSON.stringify({ author_position: 1, is_corresponding: true }), USER],
    );
    const authors = await service().listAuthors(identity, paper.object_id);
    expect(authors).toHaveLength(1);
    expect(authors[0]!.author_position).toBe(1);
    expect(authors[0]!.is_corresponding).toBe(true);
  });

  it("rejects linking a non-existent person as an author", async () => {
    if (!db.available) return;
    const paper = await service().createPaper(identity, { title: "Some Paper" });
    await expect(
      service().linkAuthor(identity, paper.object_id, { person_object_id: "does-not-exist" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("proposes a citation edge without directly mutating the graph", async () => {
    if (!db.available) return;
    const citing = await service().createPaper(identity, { title: "Citing Paper" });
    const cited = await service().createPaper(identity, { title: "Cited Paper" });

    const proposal = await service().linkCitation(identity, citing.object_id, { cited_paper_object_id: cited.object_id });
    expect(proposal).toMatchObject({ proposal_type: "object_relation_create", status: "pending" });
    const stored = await db.pool.query<{ payload_json: Record<string, unknown> }>(
      `SELECT payload_json FROM proposals WHERE id=$1`,
      [proposal.id],
    );
    expect(stored.rows[0]!.payload_json).toMatchObject({ link_type: "cites" });
    expect((await db.pool.query(`SELECT id FROM object_relations WHERE from_object_id=$1`, [citing.object_id])).rows).toHaveLength(0);
  });

  it("lists citations from an approved canonical graph edge", async () => {
    if (!db.available) return;
    const citing = await service().createPaper(identity, { title: "Citing Idempotently" });
    const cited = await service().createPaper(identity, { title: "Cited Once" });

    await db.pool.query(
      `INSERT INTO object_relations (
         id, space_id, from_object_id, to_object_id, link_type, status, metadata_json, created_by_user_id, created_at, updated_at
       ) VALUES (gen_random_uuid()::varchar,$1,$2,$3,'cites','active','{}'::jsonb,$4,now(),now())`,
      [SPACE, citing.object_id, cited.object_id, USER],
    );
    const outgoing = await service().listCitations(identity, citing.object_id);
    expect(outgoing).toHaveLength(1);
    const incoming = await service().listCitedBy(identity, cited.object_id);
    expect(incoming).toHaveLength(1);
  });

  it("rejects a paper citing itself", async () => {
    if (!db.available) return;
    const paper = await service().createPaper(identity, { title: "Self-Referential Paper" });
    await expect(
      service().linkCitation(identity, paper.object_id, { cited_paper_object_id: paper.object_id }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects reading a paper from another space", async () => {
    if (!db.available) return;
    const paper = await service().createPaper(identity, { title: "Space-Scoped Paper" });
    await expect(service().getPaper({ spaceId: OTHER_SPACE, userId: USER }, paper.object_id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("paginates listPapers honoring the requested limit and offset", async () => {
    if (!db.available) return;
    for (const title of ["Paper A", "Paper B", "Paper C"]) {
      await service().createPaper(identity, { title });
    }
    const firstPage = await service().listPapers(identity, { q: null, limit: 2, offset: 0 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.total).toBe(3);
  });
});
