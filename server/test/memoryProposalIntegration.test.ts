import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import { loadConfig } from "../src/config";
import {
  MemoryProposalNotFoundError,
  PgMemoryProposalRepository,
} from "../src/modules/memory/proposalRepository";

let repo: PgMemoryProposalRepository | undefined;

const SPACE = "space-1";
const USER = "user-1";

const db = useTestDatabase(__filename, { max: 10 });

beforeAll(async () => {
  if (!db.available) return;
  repo = new PgMemoryProposalRepository(
    db.pool,
    loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
    }),
  );
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["content_access_grants", "space_memberships", "retrieval_edges", "retrieval_chunks", "retrieval_aliases", "retrieval_objects", "extracted_evidence", "source_snapshots", "source_items", "provenance_links", "proposals", "memory_entries", "projects", "users", "spaces"],
  );
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Main', 'personal', now(), now())`, [SPACE]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ('other', 'other', 'active', now(), now()), ('user-1', 'user-1', 'active', now(), now()) ON CONFLICT (id) DO NOTHING`);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', now(), now())`,
    ["membership-1", SPACE, USER],
  );
});

async function insertMemory(over: Record<string, unknown>): Promise<void> {
  const cols: Record<string, unknown> = {
    id: over.id,
    space_id: SPACE,
    scope_type: "user",
    memory_type: "fact",
    content: "memory content",
    status: "active",
    access_count: 0,
    visibility: "space_shared",
    access_level: "full",
    sensitivity_level: "normal",
    confidence: 1,
    importance: 0.5,
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
  const names = Object.keys(cols);
  const placeholders = names.map((n, i) =>
    n === "tags" ? `$${i + 1}::jsonb` : `$${i + 1}`,
  );
  const values = names.map((n) =>
    n === "tags"
      ? cols[n] === undefined
        ? null
        : JSON.stringify(cols[n])
      : cols[n],
  );
  await db.pool.query(
    `INSERT INTO memory_entries (${names.join(", ")}) VALUES (${placeholders.join(", ")})`,
    values,
  );
}

describe("PgMemoryProposalRepository against real Postgres", () => {
  it("creates a pending memory_create proposal without inserting active memory", async () => {
    if (!db.available || !repo || !db.pool) return;
    const before = await db.pool.query("SELECT count(*)::int AS count FROM memory_entries");

    const out = await repo.createMemoryProposal(SPACE, USER, {
      operation: "create",
      title: "Remember this",
      content: "A proposal-only memory",
      type: "fact",
      scope: "user",
      namespace: "user.default",
      visibility: "space_shared",
      sensitivity_level: "normal",
      confidence: 1,
      importance: 0.5,
      tags: null,
      source_id: null,
      space_id: null,
      subject_user_id: null,
      owner_user_id: null,
      access_level: "full",
      last_confirmed_at: null,
      memory_layer: null,
      actor_user_id: null,
      provenance_entries: [
        {
          source_type: "system",
          source_id: "spoofed",
          source_trust: "system_verified",
          evidence_json: {},
        },
      ],
    });

    expect(out).toMatchObject({ proposal_type: "memory_create", status: "pending" });
    const after = await db.pool.query("SELECT count(*)::int AS count FROM memory_entries");
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    const proposal = await db.pool.query(
      "SELECT proposal_type, status, payload_json FROM proposals WHERE id = $1",
      [out.id],
    );
    expect(proposal.rows[0]).toMatchObject({
      proposal_type: "memory_create",
      status: "pending",
    });
    expect(proposal.rows[0]?.payload_json).toMatchObject({
      operation: "create",
      proposed_content: "A proposal-only memory",
      target_scope: "user",
    });
    expect(proposal.rows[0]?.payload_json.provenance_entries).toHaveLength(1);
    expect(proposal.rows[0]?.payload_json.provenance_entries[0]).toMatchObject({
      source_type: "user_confirmation",
      source_id: USER,
    });
  });

  it("creates update/archive proposals without mutating the target memory", async () => {
    if (!db.available || !repo || !db.pool) return;
    await insertMemory({
      id: "memory-1",
      owner_user_id: USER,
      content: "unchanged",
      title: "Original",
    });

    const update = await repo.updateMemoryProposal(SPACE, USER, "memory-1", {
      operation: "update",
      target_memory_id: "memory-1",
      content: "proposed",
      title: null,
      type: null,
      scope: null,
      namespace: null,
      sensitivity_level: null,
      confidence: null,
      importance: null,
      tags: null,
      subject_user_id: null,
      memory_layer: null,
      actor_user_id: null,
      provenance_entries: [],
    });
    const archive = await repo.archiveMemoryProposal(SPACE, USER, "memory-1", {
      operation: "archive",
      target_memory_id: "memory-1",
      actor_user_id: null,
      provenance_entries: [],
    });

    expect(update.proposal_type).toBe("memory_update");
    expect(archive.proposal_type).toBe("memory_archive");
    const memory = await db.pool.query(
      "SELECT content, status, deleted_at FROM memory_entries WHERE id = 'memory-1'",
    );
    expect(memory.rows[0]).toMatchObject({ content: "unchanged", status: "active" });
    expect(memory.rows[0]?.deleted_at).toBeNull();
    const proposals = await db.pool.query(
      "SELECT proposal_type FROM proposals ORDER BY created_at ASC",
    );
    expect(proposals.rows.map((row) => row.proposal_type).sort()).toEqual([
      "memory_archive",
      "memory_update",
    ]);
  });

  it("hides non-readable target memories on update", async () => {
    if (!db.available || !repo) return;
    await insertMemory({
      id: "private-other",
      owner_user_id: "other",
      visibility: "private",
      content: "secret",
    });

    await expect(
      repo.updateMemoryProposal(SPACE, USER, "private-other", {
        operation: "update",
        target_memory_id: "private-other",
        content: "nope",
        title: null,
        type: null,
        scope: null,
        namespace: null,
        sensitivity_level: null,
        confidence: null,
        importance: null,
        tags: null,
        subject_user_id: null,
        memory_layer: null,
        actor_user_id: null,
        provenance_entries: [],
      }),
    ).rejects.toBeInstanceOf(MemoryProposalNotFoundError);
  });
});
