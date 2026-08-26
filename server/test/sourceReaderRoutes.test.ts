import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { readerModule } from "../src/modules/reader/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { type Queryable } from "../src/modules/routeUtils/common.js";
import { PgReaderActionRepository, PgAnnotationRepository, PgCommentRepository } from "../src/modules/reader/repository.js";
import type { SourceItemRow } from "../src/modules/sources/sourceRepositoryRows.js";
import { __setContentCreationContextResolverForTests } from "../src/modules/access/creationContext.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

const SPACE = "space-1";
const USER = "user-1";
const identity = { spaceId: SPACE, userId: USER };

beforeEach(() => {
  __setContentCreationContextResolverForTests(async (_db, input) => ({
    spaceId: input.requestSpaceId,
    projectId: input.projectId ?? null,
    visibility: input.projectId ? "space_shared" : "private",
  }));
});

function config() {
  return loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space" });
}

/** Annotation row with space_shared visibility and no connection gate. */
function fakeAnnotation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ann-1",
    space_id: SPACE,
    project_id: null,
    document_type: "source_item",
    document_id: "item-1",
    annotation_type: "excerpt",
    quote_text: "The quick brown fox jumps over the lazy dog.",
    anchor_json: { schema_version: 1, normalizer: "plain_text_v1", quote_text: "fox" },
    color: null,
    label: null,
    visibility: "space_shared",
    access_level: "full",
    owner_user_id: USER,
    status: "active",
    anchor_state: "unverified",
    created_by_user_id: USER,
    created_at: "2026-06-30T10:00:00.000Z",
    updated_at: "2026-06-30T10:00:00.000Z",
    ...overrides,
  };
}

/** SourceItem with connection_id=null so no connection consent gate is applied. */
function fakeItem(overrides: Partial<SourceItemRow> = {}): SourceItemRow {
  return {
    id: "item-1",
    space_id: SPACE,
    project_id: null,
    owner_user_id: USER,
    visibility: "space_shared",
    access_level: "full",
    connection_id: null,
    item_type: "article",
    source_object_type: null,
    source_object_id: null,
    created_by_user_id: USER,
    title: "Test article",
    source_uri: null,
    canonical_uri: null,
    source_domain: null,
    source_external_id: null,
    author: null,
    occurred_at: null,
    first_seen_at: null,
    last_seen_at: null,
    content_hash: null,
    excerpt: null,
    content_state: "pending",
    retention_policy: "metadata_only",
    relevance_score: null,
    novelty_score: null,
    raw_artifact_id: null,
    extracted_artifact_id: null,
    summary_artifact_id: null,
    search_index_ref: null,
    embedding_index_ref: null,
    metadata_json: null,
    created_at: "2026-06-30T10:00:00.000Z",
    updated_at: "2026-06-30T10:00:00.000Z",
    ...overrides,
  };
}

function fakeEvidenceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evidence-1",
    title: "The quick brown fox jumps over the lazy dog.",
    status: "candidate",
    evidence_type: "excerpt",
    source_item_id: "item-1",
    source_object_type: "reader_annotation",
    source_object_id: "ann-1",
    ...overrides,
  };
}

function fakeProposalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "proposal-1", space_id: SPACE, created_by_user_id: USER, project_folder_id: null, created_by_run_id: null,
    proposal_type: "memory_create", status: "pending", risk_level: "low", urgency: "normal", preview: false,
    title: "The quick brown fox", payload_json: {}, rationale: "Created from reader annotation.", visibility: "space_shared",
    review_deadline: null, expires_at: null, created_at: "2026-06-30T10:00:00.000Z", reviewed_at: null,
    project_id: null, egress_approval_id: null, egress_approval_status: null, ...overrides,
  };
}

interface CapturedQuery { sql: string; params: readonly unknown[] }

function sequentialDb(
  rowSets: unknown[][],
): { db: Queryable; calls: CapturedQuery[] } {
  const calls: CapturedQuery[] = [];
  let idx = 0;
  const db: Queryable = {
    async query<Row>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("AS effective_access_level")) {
        const resourceId = String(params[1] ?? "");
        const userId = String(params[2] ?? "");
        const resource = rowSets.flat().find((row) => {
          if (!row || typeof row !== "object") return false;
          return String((row as Record<string, unknown>).id ?? "") === resourceId;
        }) as Record<string, unknown> | undefined;
        const ownerUserId = resource?.owner_user_id ?? resource?.created_by_user_id;
        const readable = ownerUserId === userId || resource?.visibility === "space_shared";
        const rows = readable ? [{ effective_access_level: ownerUserId === userId ? "full" : resource?.access_level ?? "full" }] : [];
        return { rows: rows as Row[], rowCount: rows.length };
      }
      const rows = (rowSets[idx++] ?? []) as Row[];
      return { rows, rowCount: rows.length };
    },
  };
  return { db, calls };
}

// ── Route validation tests ────────────────────────────────────────────────────

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthIdentityForTests(null);
  __setContentCreationContextResolverForTests(null);
  await app?.close();
  app = undefined;
});

describe("source reader routes — auth and input validation", () => {
  it("returns 401 to unauthenticated requests on the reader document endpoint", async () => {
    app = buildModuleServer(config(), [readerModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reader/documents/source_item/item-1",
    });

    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when project_id is missing from GET /reader/annotations", async () => {
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
    app = buildModuleServer(config(), [readerModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reader/annotations",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/project_id/);
  });

  it("returns 401 to unauthenticated requests on POST /reader/annotations", async () => {
    app = buildModuleServer(config(), [readerModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reader/annotations",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ annotation_type: "excerpt", quote_text: "x" }),
    });

    expect(res.statusCode).toBe(401);
  });
});

// ── PgReaderActionRepository unit tests ──────────────────────────────────────

describe("PgReaderActionRepository.createEvidence", () => {
  it("creates private evidence when the caller owns a private annotation", async () => {
    const { db, calls } = sequentialDb([
      // SELECT annotation → private, owned by the caller
      [fakeAnnotation({ visibility: "private", created_by_user_id: USER })],
      [fakeItem({ visibility: "private" })],
      [],
      [{ id: "evidence-1" }],
      [fakeEvidenceRow()],
    ]);
    const repo = new PgReaderActionRepository(db);

    await repo.createEvidence(identity, "ann-1", {});

    const insert = calls.find((call) => call.sql.includes("INSERT INTO extracted_evidence"));
    expect(insert?.params).toContain("private");
  });

  it("throws 404 when a non-owner attempts evidence from a private annotation (no-oracle)", async () => {
    const { db } = sequentialDb([
      // SELECT annotation → private, owned by a different user
      [fakeAnnotation({
        visibility: "private",
        owner_user_id: "other-user",
        created_by_user_id: "other-user",
      })],
    ]);
    const repo = new PgReaderActionRepository(db);

    await expect(
      repo.createEvidence(identity, "ann-1", {}),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws 404 when the annotation is not found", async () => {
    const { db } = sequentialDb([
      // SELECT annotation → empty
      [],
    ]);
    const repo = new PgReaderActionRepository(db);

    await expect(
      repo.createEvidence(identity, "ann-1", {}),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("creates evidence with status=candidate for a space_shared annotation", async () => {
    const { db, calls } = sequentialDb([
      // SELECT annotation
      [fakeAnnotation({ visibility: "space_shared" })],
      // assertDocumentReadable → SELECT source_items
      [fakeItem()],
      // loadAnnotationConnectionPolicy → SELECT policy (empty, no connection)
      [],
      // canonical insert id, then canonical row read
      [{ id: "evidence-1" }],
      [fakeEvidenceRow()],
    ]);
    const repo = new PgReaderActionRepository(db);

    const result = await repo.createEvidence(identity, "ann-1", {});

    expect(result.status).toBe("candidate");
    expect(result.evidence_type).toBe("excerpt");
    expect(result.source_object_type).toBe("reader_annotation");

    const evidenceInsert = calls.find((c) => c.sql.includes("INSERT INTO extracted_evidence"));
    expect(evidenceInsert).toBeDefined();
    expect(evidenceInsert?.params).toContain("candidate");
    expect(evidenceInsert?.params?.[2]).toBeNull();
    expect(evidenceInsert?.params?.[6]).toBeNull();
    expect(evidenceInsert?.params?.[7]).toBe("item-1");
  });

  it("does not write to memory_entries or knowledge_items", async () => {
    const { db, calls } = sequentialDb([
      [fakeAnnotation({ visibility: "space_shared" })],
      [fakeItem()],
      [],
      [{ id: "evidence-1" }],
      [fakeEvidenceRow()],
    ]);
    const repo = new PgReaderActionRepository(db);

    await repo.createEvidence(identity, "ann-1", {});

    const writes = calls.filter((c) => c.sql.startsWith("INSERT INTO"));
    expect(writes.length).toBe(1);
    expect(writes[0]!.sql).toContain("extracted_evidence");
    expect(calls.some((c) => c.sql.includes("memory_entries"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("knowledge_items"))).toBe(false);
  });

  it("uses the supplied title when provided", async () => {
    const { db, calls } = sequentialDb([
      [fakeAnnotation({ visibility: "space_shared" })],
      [fakeItem()],
      [],
      [{ id: "evidence-1" }],
      [fakeEvidenceRow({ title: "Custom title" })],
    ]);
    const repo = new PgReaderActionRepository(db);

    const result = await repo.createEvidence(identity, "ann-1", { title: "Custom title" });

    const insert = calls.find((c) => c.sql.includes("INSERT INTO extracted_evidence"));
    // title is passed as a param — verify the param value appears
    expect(insert?.params).toContain("Custom title");
    expect(result.title).toBe("Custom title");
  });
});

describe("PgReaderActionRepository.createProposal", () => {
  it("throws 422 for an unsupported proposal_type", async () => {
    const { db } = sequentialDb([
      // SELECT annotation
      [fakeAnnotation()],
      // assertDocumentReadable → SELECT source_items
      [fakeItem()],
    ]);
    const repo = new PgReaderActionRepository(db);

    await expect(
      repo.createProposal(identity, "ann-1", { proposal_type: "direct_write" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("creates a memory_create proposal with status=pending", async () => {
    const { db, calls } = sequentialDb([
      // SELECT annotation
      [fakeAnnotation({ visibility: "space_shared" })],
      // assertDocumentReadable → SELECT source_items
      [fakeItem()],
      // loadAnnotationConnectionPolicy → empty (no connection)
      [],
      // INSERT INTO proposals RETURNING
      [fakeProposalRow({ proposal_type: "memory_create", status: "pending" })],
    ]);
    const repo = new PgReaderActionRepository(db);

    const result = await repo.createProposal(identity, "ann-1", {
      proposal_type: "memory_create",
    });

    expect(result.status).toBe("pending");
    expect(result.proposal_type).toBe("memory_create");

    const proposalInsert = calls.find((c) => c.sql.includes("INSERT INTO proposals"));
    expect(proposalInsert).toBeDefined();
    // status is passed as $5 param (index 4), defaulting to "pending"
    expect(proposalInsert?.params[4]).toBe("pending");
  });

  it("creates a knowledge_create proposal with status=pending", async () => {
    const { db, calls } = sequentialDb([
      [fakeAnnotation({ visibility: "space_shared" })],
      [fakeItem()],
      [],
      [fakeProposalRow({ proposal_type: "knowledge_create", status: "pending" })],
    ]);
    const repo = new PgReaderActionRepository(db);

    const result = await repo.createProposal(identity, "ann-1", {
      proposal_type: "knowledge_create",
    });

    expect(result.status).toBe("pending");
    expect(result.proposal_type).toBe("knowledge_create");

    const proposalInsert = calls.find((c) => c.sql.includes("INSERT INTO proposals"));
    expect(proposalInsert).toBeDefined();
    expect(proposalInsert?.params[4]).toBe("pending");
  });

  it("does not write to memory_entries or knowledge_items", async () => {
    const { db, calls } = sequentialDb([
      [fakeAnnotation({ visibility: "space_shared" })],
      [fakeItem()],
      [],
      [fakeProposalRow()],
    ]);
    const repo = new PgReaderActionRepository(db);

    await repo.createProposal(identity, "ann-1", { proposal_type: "memory_create" });

    const writes = calls.filter((c) => c.sql.startsWith("INSERT INTO"));
    expect(writes.length).toBe(1);
    expect(writes[0]!.sql).toContain("proposals");
    expect(calls.some((c) => c.sql.includes("memory_entries"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("knowledge_items"))).toBe(false);
  });

  it("throws 404 when annotation is not found", async () => {
    const { db } = sequentialDb([[]]);
    const repo = new PgReaderActionRepository(db);

    await expect(
      repo.createProposal(identity, "ann-1", { proposal_type: "memory_create" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws 404 for a private annotation when caller is not the creator", async () => {
    const { db } = sequentialDb([
      // SELECT annotation — private, owned by a different user
      [fakeAnnotation({ visibility: "private", created_by_user_id: "other-user" })],
    ]);
    const repo = new PgReaderActionRepository(db);

    await expect(
      repo.createProposal(identity, "ann-1", { proposal_type: "memory_create" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("PgReaderActionRepository.listProjectAnnotations", () => {
  it("throws 404 when canAccessProject returns false", async () => {
    const { db } = sequentialDb([
      // canAccessProject → SELECT FROM project_members or projects → empty
      [],
    ]);
    const repo = new PgReaderActionRepository(db);

    await expect(
      repo.listProjectAnnotations(identity, "project-1", 10),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("filters annotations using a source connection consent check in SQL", async () => {
    // canAccessProject makes 2 queries: SELECT projects, then SELECT spaces.
    // A "personal" space short-circuits to true immediately without a 3rd query.
    const { db, calls } = sequentialDb([
      // canAccessProject #1: SELECT projects → project exists, owned by USER
      [{ owner_user_id: USER }],
      // canAccessProject #2: SELECT spaces → personal space (short-circuits to true)
      [{ type: "personal" }],
      // listProjectAnnotations SELECT → returns one annotation
      [fakeAnnotation({ visibility: "space_shared" })],
    ]);
    const repo = new PgReaderActionRepository(db);

    const results = await repo.listProjectAnnotations(identity, "project-1", 10);
    expect(results.length).toBe(1);

    // The query must inline the consent gate (not a separate query per annotation)
    const listQuery = calls.find((c) => c.sql.includes("reader_annotations"));
    expect(listQuery).toBeDefined();
    expect(listQuery!.sql).toContain("consent_json->>'owner_user_id'");
    expect(listQuery!.sql).toContain("allowed_reader_user_ids");
    expect(listQuery!.sql).toContain("allow_space_admins");
    // anchor_state must be included so the ReaderAnnotation contract is satisfied
    expect(listQuery!.sql).toContain("anchor_state");
    // Project members alone must not unlock consent — the check must reference the user param
    expect(listQuery!.params).toContain(USER);
  });

  it("returns only space_shared annotations", async () => {
    const { db, calls } = sequentialDb([
      // canAccessProject
      [{ owner_user_id: USER }],
      [{ type: "personal" }],
      // list query → empty (no results pass consent filter)
      [],
    ]);
    const repo = new PgReaderActionRepository(db);

    const results = await repo.listProjectAnnotations(identity, "project-1", 10);
    expect(results).toEqual([]);

    const listQuery = calls.find((c) => c.sql.includes("reader_annotations"));
    expect(listQuery!.sql).toContain("'space_shared'");
  });
});

// ── Document gate and annotation/thread visibility ─────────────────────────────

describe("PgAnnotationRepository.listAnnotations — document gate", () => {
  it("throws 404 when the source_item document is not found", async () => {
    const { db } = sequentialDb([
      // assertDocumentReadable → SELECT source_items → not found
      [],
    ]);
    const repo = new PgAnnotationRepository(db);

    await expect(
      repo.listAnnotations(identity, "source_item", "item-1"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws 404 when a source_snapshot's source_item is soft-deleted and has no connection fallback", async () => {
    const { db } = sequentialDb([
      // assertDocumentReadable → SELECT source_snapshots → found with source_item_id but no connection
      [{ source_item_id: "item-1", connection_id: null, artifact_id: null }],
      // SELECT source_items → empty (soft-deleted)
      [],
    ]);
    const repo = new PgAnnotationRepository(db);

    await expect(
      repo.listAnnotations(identity, "source_snapshot", "snap-1"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns annotations after passing the document gate", async () => {
    const { db } = sequentialDb([
      // assertDocumentReadable → SELECT source_items → found (no connection, no consent gate)
      [fakeItem()],
      // SELECT reader_annotations → two rows pass the SQL filter
      [
        fakeAnnotation({ visibility: "space_shared" }),
        fakeAnnotation({ id: "ann-2", visibility: "private", created_by_user_id: USER }),
      ],
    ]);
    const repo = new PgAnnotationRepository(db);

    const results = await repo.listAnnotations(identity, "source_item", "item-1");
    expect(results).toHaveLength(2);
    expect(results[0]!.visibility).toBe("space_shared");
    expect(results[1]!.visibility).toBe("private");
  });

  it("SQL filter includes both space_shared and own-user conditions, parameterized on user id", async () => {
    const { db, calls } = sequentialDb([
      [fakeItem()],
      [],
    ]);
    const repo = new PgAnnotationRepository(db);

    await repo.listAnnotations(identity, "source_item", "item-1");

    const listQuery = calls.find((c) => c.sql.includes("reader_annotations") && c.sql.includes("SELECT"));
    expect(listQuery!.sql).toContain("'space_shared'");
    expect(listQuery!.sql).toContain("created_by_user_id");
    // User id must be a query param, not inlined
    expect(listQuery!.params).toContain(USER);
  });
});

describe("PgAnnotationRepository.createAnnotation — document scope", () => {
  it("rejects client-owned access fields", async () => {
    const { db, calls } = sequentialDb([]);
    const repo = new PgAnnotationRepository(db);

    await expect(repo.createAnnotation(identity, {
      annotation_type: "excerpt",
      quote_text: "fox",
      anchor_json: {
        schema_version: 1,
        quote_text: "fox",
        text_range: { start: 0, end: 3, unit: "utf16" },
        before_context: "",
        after_context: "",
      },
      document_type: "source_item",
      document_id: "item-1",
      project_id: "project-forged",
      visibility: "space_shared",
    })).rejects.toMatchObject({ statusCode: 422 });

    expect(calls.some((call) => call.sql.includes("INSERT INTO reader_annotations"))).toBe(false);
  });

  it("inherits Project and access level from the document but stays private", async () => {
    const { db, calls } = sequentialDb([
      [fakeItem({
        project_id: "project-document",
        visibility: "selected_users",
        access_level: "summary",
      })],
      [{ extracted_artifact_id: null, excerpt: "fox" }],
      [fakeAnnotation({
        project_id: "project-document",
        visibility: "private",
        access_level: "summary",
      })],
      [],
    ]);
    const repo = new PgAnnotationRepository(db);

    await repo.createAnnotation(identity, {
      annotation_type: "excerpt",
      quote_text: "fox",
      anchor_json: {
        schema_version: 1,
        quote_text: "fox",
        text_range: { start: 0, end: 3, unit: "utf16" },
        before_context: "",
        after_context: "",
      },
      document_type: "source_item",
      document_id: "item-1",
    });

    const insert = calls.find((call) => call.sql.includes("INSERT INTO reader_annotations"));
    expect(insert?.params).toContain("project-document");
    expect(insert?.params).toContain("summary");
    // ADR 0013 decision 3a: scope and access level are inherited, visibility is
    // not. A margin note on a shared document stays private until its author
    // says otherwise, so no grants are copied either.
    expect(insert?.params).toContain("private");
    expect(insert?.params).not.toContain("selected_users");
    expect(calls.some((call) => call.sql.includes("INSERT INTO content_access_grants"))).toBe(false);
  });

  it("copies the document's grants only when the author shares the annotation", async () => {
    const { db, calls } = sequentialDb([
      [fakeItem({
        project_id: "project-document",
        visibility: "selected_users",
        access_level: "summary",
      })],
      [{ extracted_artifact_id: null, excerpt: "fox" }],
      [fakeAnnotation({
        project_id: "project-document",
        visibility: "selected_users",
        access_level: "summary",
      })],
      [],
    ]);
    const repo = new PgAnnotationRepository(db);

    await repo.createAnnotation(identity, {
      annotation_type: "excerpt",
      quote_text: "fox",
      anchor_json: {
        schema_version: 1,
        quote_text: "fox",
        text_range: { start: 0, end: 3, unit: "utf16" },
        before_context: "",
        after_context: "",
      },
      document_type: "source_item",
      document_id: "item-1",
      visibility: "selected_users",
    });

    const insert = calls.find((call) => call.sql.includes("INSERT INTO reader_annotations"));
    expect(insert?.params).toContain("selected_users");
    expect(calls.some((call) => call.sql.includes("INSERT INTO content_access_grants"))).toBe(true);
  });

  it("refuses to make an annotation wider than its document", async () => {
    const { db } = sequentialDb([
      [fakeItem({ project_id: "project-document", visibility: "private", access_level: "full" })],
      [{ extracted_artifact_id: null, excerpt: "fox" }],
    ]);
    const repo = new PgAnnotationRepository(db);

    await expect(repo.createAnnotation(identity, {
      annotation_type: "excerpt",
      quote_text: "fox",
      anchor_json: {
        schema_version: 1,
        quote_text: "fox",
        text_range: { start: 0, end: 3, unit: "utf16" },
        before_context: "",
        after_context: "",
      },
      document_type: "source_item",
      document_id: "item-1",
      visibility: "space_shared",
    })).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("PgCommentRepository.listThreads — annotation visibility gate", () => {
  it("throws 404 for a private annotation owned by another user", async () => {
    const { db } = sequentialDb([
      // SELECT annotation → private, other user
      [fakeAnnotation({ visibility: "private", created_by_user_id: "other-user" })],
    ]);
    const repo = new PgCommentRepository(db);

    await expect(
      repo.listThreads(identity, "ann-1"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("allows the annotation owner to list threads on their own private annotation", async () => {
    const { db } = sequentialDb([
      // SELECT annotation → private, owned by USER
      [fakeAnnotation({ visibility: "private", created_by_user_id: USER })],
      // assertDocumentReadable → SELECT source_items → found
      [fakeItem()],
      // SELECT reader_comment_threads → empty
      [],
    ]);
    const repo = new PgCommentRepository(db);

    const result = await repo.listThreads(identity, "ann-1");
    expect(result).toEqual([]);
  });

  it("throws 404 for a space_shared annotation whose document is no longer accessible", async () => {
    const { db } = sequentialDb([
      // SELECT annotation → space_shared (passes visibility check)
      [fakeAnnotation({ visibility: "space_shared" })],
      // assertDocumentReadable → SELECT source_items → empty (document gone)
      [],
    ]);
    const repo = new PgCommentRepository(db);

    await expect(
      repo.listThreads(identity, "ann-1"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws 404 when the annotation itself is not found", async () => {
    const { db } = sequentialDb([
      // SELECT annotation → empty
      [],
    ]);
    const repo = new PgCommentRepository(db);

    await expect(
      repo.listThreads(identity, "ann-1"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("POST /reader/annotations — anchor range validation", () => {
  it("returns 422 when text_range.start is negative", async () => {
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
    app = buildModuleServer(config(), [readerModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reader/annotations",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        annotation_type: "excerpt",
        quote_text: "fox",
        anchor_json: {
          schema_version: 1,
          normalizer: "plain_text_v1",
          quote_text: "fox",
          text_range: { start: -1, end: 3, unit: "utf16" },
          before_context: "",
          after_context: "",
        },
        document_type: "source_item",
        document_id: "item-1",
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/start must be >= 0/);
  });

  it("returns 422 when text_range.end is not greater than start", async () => {
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
    app = buildModuleServer(config(), [readerModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reader/annotations",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        annotation_type: "excerpt",
        quote_text: "fox",
        anchor_json: {
          schema_version: 1,
          normalizer: "plain_text_v1",
          quote_text: "fox",
          text_range: { start: 5, end: 5, unit: "utf16" },
          before_context: "",
          after_context: "",
        },
        document_type: "source_item",
        document_id: "item-1",
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/end must be > start/);
  });
});
