import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import {
  MemoryApplyError,
  MemoryApplyUnsupportedError,
  PgMemoryApplyRepository,
  type ApplyProposal,
} from "../src/modules/memory/memoryApplyRepository";

// Real-PostgreSQL integration tests for the memory appliers. These run the
// actual INSERT/UPDATE memory_entries + provenance / relation writes against a
// throwaway Postgres loaded with memoryApplySchema.sql, so the column set,
// versioning, supersede, and access invariants are exercised on the real
// stack. Skips gracefully when Docker is unavailable.

const SCHEMA = readFileSync(join(process.cwd(), "test/fixtures/memoryApplySchema.sql"), "utf8");

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let repo: PgMemoryApplyRepository | undefined;
let available = false;

const SPACE = "space-1";
const USER = "user-1";

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename, { empty: true });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(SCHEMA);
    repo = new PgMemoryApplyRepository(pool);
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[memory-apply-integration] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    "TRUNCATE retrieval_edges, retrieval_chunks, retrieval_aliases, retrieval_objects, extracted_evidence, source_snapshots, source_items, memory_entries, provenance_links, memory_relations, spaces, projects, proposals",
  );
  await pool.query("INSERT INTO spaces (id, type) VALUES ($1, 'personal')", [SPACE]);
});

/** Run a callback against a repo bound to a single transaction; commit on
 * success, roll back (and rethrow) on error — mirrors the accept route. */
async function inTx<T>(fn: (repo: PgMemoryApplyRepository) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(new PgMemoryApplyRepository(client));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function seedProposal(p: ApplyProposal): Promise<void> {
  await pool!.query(
    `INSERT INTO proposals (id, space_id, proposal_type, status, payload_json, created_by_user_id, created_by_run_id, project_folder_id, project_id, title)
     VALUES ($1, $2, $3, 'pending', $4::jsonb, $5, $6, $7, $8, $9)`,
    [
      p.id,
      p.space_id,
      p.proposal_type,
      JSON.stringify(p.payload_json),
      p.created_by_user_id,
      p.created_by_run_id ?? null,
      p.project_folder_id,
      p.project_id,
      p.title,
    ],
  );
}

function proposal(over: Partial<ApplyProposal> & { payload_json: Record<string, unknown> }): ApplyProposal {
  return {
    id: over.id ?? "prop-1",
    space_id: over.space_id ?? SPACE,
    proposal_type: over.proposal_type ?? "memory_create",
    title: over.title ?? "Remember",
    project_folder_id: over.project_folder_id ?? null,
    project_id: over.project_id ?? null,
    created_by_user_id: over.created_by_user_id ?? USER,
    created_by_run_id: over.created_by_run_id ?? null,
    payload_json: over.payload_json,
  };
}

async function insertActiveMemory(over: Record<string, unknown>): Promise<void> {
  const cols: Record<string, unknown> = {
    id: over.id,
    space_id: SPACE,
    scope_type: "user",
    memory_type: "semantic",
    content: "old content",
    status: "active",
    visibility: "private",
    owner_user_id: USER,
    access_level: "full",
    sensitivity_level: "normal",
    namespace: "user.default",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 1,
    access_count: 0,
    ...over,
  };
  const names = Object.keys(cols);
  const ph = names.map((_, i) => `$${i + 1}`);
  await pool!.query(
    `INSERT INTO memory_entries (${names.join(", ")}) VALUES (${ph.join(", ")})`,
    names.map((n) => cols[n]),
  );
}

async function provFor(memoryId: string) {
  const r = await pool!.query(
    "SELECT source_type, source_id, source_trust FROM provenance_links WHERE target_id = $1 ORDER BY source_type, source_id",
    [memoryId],
  );
  return r.rows;
}

const userConf = { source_type: "user_confirmation", source_id: "u1", source_trust: "user_confirmed" };

describe("PgMemoryApplyRepository against real Postgres", () => {
  it("applies memory_create: active row + provenance + dominant trust", async () => {
    if (!available || !repo || !pool) return;
    const out = await repo.applyCreate(
      proposal({
        payload_json: {
          target_visibility: "private",
          proposed_content: "hello world",
          memory_type: "semantic",
          target_scope: "user",
          target_namespace: "ns.x",
          provenance_entries: [userConf, { source_type: "activity", source_id: "act-9", source_trust: "agent_inferred" }],
        },
      }),
      USER,
    );

    expect(out.memory).toMatchObject({
      space_id: SPACE,
      scope_type: "user",
      memory_type: "semantic",
      content: "hello world",
      status: "active",
      visibility: "private",
      owner_user_id: USER,
      namespace: "ns.x",
      version: 1,
      source_trust: "user_confirmed", // dominant over agent_inferred
    });

    const row = (await pool.query("SELECT * FROM memory_entries WHERE id = $1", [out.memory.id])).rows[0];
    expect(row.created_from_proposal_id).toBe("prop-1");
    expect(row.approved_by).toBe(USER);
    expect(row.access_count).toBe(0);

    // Provenance: the two payload entries + the proposal entry.
    const prov = await provFor(out.memory.id);
    expect(prov).toHaveLength(3);
    expect(prov).toContainEqual({ source_type: "activity", source_id: "act-9", source_trust: "agent_inferred" });
    expect(prov).toContainEqual({ source_type: "proposal", source_id: "prop-1", source_trust: "internal_system" });
  });

  it("applies memory_create with a validated project association", async () => {
    if (!available || !repo || !pool) return;
    await pool.query("INSERT INTO projects (id, space_id, deleted_at) VALUES ('project-1', $1, NULL)", [SPACE]);

    const out = await repo.applyCreate(
      proposal({
        project_id: "project-1",
        payload_json: {
          target_scope: "project",
          target_visibility: "space_shared",
          proposed_content: "project memory",
          provenance_entries: [userConf],
        },
      }),
      USER,
    );

    expect(out.memory.project_id).toBe("project-1");
    const row = (await pool.query("SELECT project_id FROM memory_entries WHERE id = $1", [out.memory.id])).rows[0];
    expect(row.project_id).toBe("project-1");
  });

  it("rejects memory_create when the proposal project is outside the current space", async () => {
    if (!available || !repo || !pool) return;

    await expect(
      repo.applyCreate(
        proposal({
          project_id: "project-other",
          payload_json: {
            target_visibility: "space_shared",
            proposed_content: "project memory",
            provenance_entries: [userConf],
          },
        }),
        USER,
      ),
    ).rejects.toBeInstanceOf(MemoryApplyError);
    expect((await pool.query("SELECT count(*)::int AS c FROM memory_entries")).rows[0].c).toBe(0);
  });

  it("allows private visibility in a multi-member space", async () => {
    if (!available || !repo || !pool) return;
    await pool.query("UPDATE spaces SET type = 'team' WHERE id = $1", [SPACE]);
    const out = await repo.applyCreate(
      proposal({ payload_json: { target_visibility: "private", proposed_content: "x", owner_user_id: USER, provenance_entries: [userConf] } }),
      USER,
    );
    expect(out.memory).toMatchObject({ visibility: "private", owner_user_id: USER });
  });

  it("allows private visibility in a personal space with owner fallback", async () => {
    if (!available || !repo) return;
    const out = await repo.applyCreate(
      proposal({ payload_json: { target_visibility: "private", proposed_content: "p", provenance_entries: [userConf] } }),
      USER,
    );
    expect(out.memory.visibility).toBe("private");
    expect(out.memory.owner_user_id).toBe(USER); // fell back to acting user
  });

  it("defaults a no-visibility create to owner-only private in a multi-member space", async () => {
    if (!available || !repo || !pool) return;
    await pool.query("UPDATE spaces SET type = 'team' WHERE id = $1", [SPACE]);
    const creator = "creator-9";

    const out = await repo.applyCreate(
      proposal({
        created_by_user_id: creator,
        payload_json: { proposed_content: "assistant-derived", provenance_entries: [userConf] },
      }),
      USER, // accepting user differs from the creator the memory belongs to
    );

    expect(out.memory.visibility).toBe("private");
    expect(out.memory.owner_user_id).toBe(creator);
    expect(out.memory.access_level).toBe("full");
  });

  it("keeps the no-visibility default private in a personal space", async () => {
    if (!available || !repo) return; // space is 'personal' by default
    const out = await repo.applyCreate(
      proposal({ payload_json: { proposed_content: "personal default", provenance_entries: [userConf] } }),
      USER,
    );
    expect(out.memory.visibility).toBe("private");
  });

  it("promotes an owner-only private memory into Project memory", async () => {
    if (!available || !repo || !pool) return;
    await pool.query("UPDATE spaces SET type = 'team' WHERE id = $1", [SPACE]);
    await insertActiveMemory({
      id: "mem-personal",
      visibility: "private",
      owner_user_id: USER,
      content: "personal note",
    });
    await pool.query(
      "INSERT INTO projects (id, space_id, deleted_at) VALUES ('project-promotion', $1, NULL)",
      [SPACE],
    );

    const out = await repo.applyUpdate(
      proposal({
        proposal_type: "memory_update",
        project_id: "project-promotion",
        payload_json: {
          target_memory_id: "mem-personal",
          target_scope: "project",
          target_visibility: "space_shared",
          provenance_entries: [userConf],
        },
      }),
      USER,
    );

    expect(out.memory.visibility).toBe("space_shared");
    expect(out.memory.scope_type).toBe("project");
    expect(out.memory.project_id).toBe("project-promotion");
    expect(out.memory.owner_user_id).toBe(USER); // promoter stays steward
    const old = (await pool.query("SELECT status FROM memory_entries WHERE id = 'mem-personal'")).rows[0];
    expect(old.status).toBe("superseded");
  });

  it("applies memory_update: new version supersedes old, copies + adds provenance", async () => {
    if (!available || !repo || !pool) return;
    await insertActiveMemory({ id: "mem-old", content: "old", source_trust: "trusted_external" });
    // Seed an existing provenance link on the old memory (must be copied forward).
    await pool.query(
      `INSERT INTO provenance_links (id, space_id, target_type, target_id, source_type, source_id, source_trust, created_at)
       VALUES ('pl-old', $1, 'memory', 'mem-old', 'activity', 'act-old', 'trusted_external', now())`,
      [SPACE],
    );

    const out = await repo.applyUpdate(
      proposal({
        proposal_type: "memory_update",
        payload_json: {
          target_memory_id: "mem-old",
          proposed_content: "updated",
          provenance_entries: [userConf],
        },
      }),
      USER,
    );

    expect(out.memory.content).toBe("updated");
    expect(out.memory.supersedes_memory_id).toBe("mem-old");
    expect(out.memory.root_memory_id).toBe("mem-old");
    expect(out.supersededMemoryId).toBe("mem-old");

    // Old row is superseded.
    const old = (await pool.query("SELECT status FROM memory_entries WHERE id = 'mem-old'")).rows[0];
    expect(old.status).toBe("superseded");

    // supersedes relation recorded.
    const rel = (
      await pool.query("SELECT source_id, target_id, relation_type FROM memory_relations")
    ).rows;
    expect(rel).toEqual([
      { source_id: out.memory.id, target_id: "mem-old", relation_type: "supersedes" },
    ]);

    // New memory carries copied (activity) + payload (user_confirmation) + proposal provenance.
    const prov = await provFor(out.memory.id);
    const kinds = prov.map((p) => `${p.source_type}:${p.source_id}`);
    expect(kinds).toContain("activity:act-old");
    expect(kinds).toContain("user_confirmation:u1");
    expect(kinds).toContain("proposal:prop-1");
  });

  it("applies memory_update across the user-to-project attribution boundary", async () => {
    if (!available || !repo || !pool) return;
    await insertActiveMemory({
      id: "mem-personal-to-project",
      content: "personal content",
    });
    await pool.query(
      "INSERT INTO projects (id, space_id, deleted_at) VALUES ('project-target', $1, NULL)",
      [SPACE],
    );

    const out = await repo.applyUpdate(
      proposal({
        proposal_type: "memory_update",
        project_id: "project-target",
        payload_json: {
          target_memory_id: "mem-personal-to-project",
          target_scope: "project",
          target_visibility: "space_shared",
          proposed_content: "project content",
          provenance_entries: [userConf],
        },
      }),
      USER,
    );

    expect(out.memory.scope_type).toBe("project");
    expect(out.memory.project_id).toBe("project-target");
  });

  it("applies memory_archive: marks target archived and writes provenance", async () => {
    if (!available || !repo || !pool) return;
    await insertActiveMemory({ id: "mem-arch", content: "keep" });

    const out = await repo.applyArchive(
      proposal({
        proposal_type: "memory_archive",
        title: "Archive",
        payload_json: { target_memory_id: "mem-arch", provenance_entries: [userConf] },
      }),
      USER,
    );

    expect(out.memory.status).toBe("archived");
    const row = (await pool.query("SELECT status FROM memory_entries WHERE id = 'mem-arch'")).rows[0];
    expect(row.status).toBe("archived");

    const prov = await provFor("mem-arch");
    const kinds = prov.map((p) => `${p.source_type}:${p.source_id}`);
    expect(kinds).toContain("user_confirmation:u1");
    expect(kinds).toContain("proposal:prop-1");
  });

  it("fails memory_update when the target is missing/inactive", async () => {
    if (!available || !repo) return;
    await expect(
      repo.applyUpdate(
        proposal({ proposal_type: "memory_update", payload_json: { target_memory_id: "nope", proposed_content: "x" } }),
        USER,
      ),
    ).rejects.toBeInstanceOf(MemoryApplyError);
  });

  // ── applyOnly repository contract ────────────────────────────────────────

  it("applyOnly: applies create and returns the proposal payload patch", async () => {
    if (!available || !pool) return;
    const p = proposal({
      payload_json: {
        target_visibility: "private",
        proposed_content: "orchestrated",
        provenance_entries: [userConf],
      },
    });
    await seedProposal(p);

    const out = await inTx((r) => r.applyOnly(p, USER));

    const mem = (await pool.query("SELECT * FROM memory_entries WHERE id = $1", [out.memoryId])).rows[0];
    expect(mem.content).toBe("orchestrated");
    expect(mem.status).toBe("active");
    const prop = (await pool.query("SELECT status, reviewed_by, payload_json FROM proposals WHERE id = $1", [p.id])).rows[0];
    expect(prop.status).toBe("pending");
    expect(prop.reviewed_by).toBeNull();
    expect(prop.payload_json.resulting_memory_id).toBeUndefined();
    expect(out.payloadJson.resulting_memory_id).toBe(out.memoryId);
  });

  it("applyOnly: rejects an agent_inferred-only semantic proposal (source monitoring) with no writes", async () => {
    if (!available || !pool) return;
    const p = proposal({
      payload_json: {
        proposed_content: "weak",
        memory_type: "semantic",
        provenance_entries: [{ source_type: "activity", source_id: "a", source_trust: "agent_inferred" }],
      },
    });
    await seedProposal(p);

    await expect(inTx((r) => r.applyOnly(p, USER))).rejects.toBeInstanceOf(MemoryApplyError);
    // Rolled back: no memory, proposal still pending.
    expect((await pool.query("SELECT count(*)::int AS c FROM memory_entries")).rows[0].c).toBe(0);
    expect((await pool.query("SELECT status FROM proposals WHERE id = $1", [p.id])).rows[0].status).toBe("pending");
  });

  it("applyOnly: returns source_monitoring_result for untrusted_external require_review", async () => {
    if (!available || !pool) return;
    const p = proposal({
      payload_json: {
        proposed_content: "needs review",
        memory_type: "semantic",
        provenance_entries: [{ source_type: "external_source", source_id: "x", source_trust: "untrusted_external" }],
      },
    });
    await seedProposal(p);

    const out = await inTx((r) => r.applyOnly(p, USER));
    expect((out.payloadJson.source_monitoring_result as Record<string, unknown>).reason_code).toBe(
      "untrusted_external_only",
    );
    const mem = (await pool.query("SELECT status FROM memory_entries WHERE id = $1", [out.memoryId])).rows[0];
    expect(mem.status).toBe("active");
  });

  it("applyOnly: fails closed for grant-derived memory proposals", async () => {
    if (!available || !pool) return;
    const runCtx = proposal({
      id: "p-run",
      payload_json: {
        proposed_content: "x",
        provenance_entries: [userConf],
        derived_from_personal_memory_grant: true,
        grant_id: "grant-1",
      },
      created_by_run_id: "run-9",
    });
    await seedProposal(runCtx);
    await expect(inTx((r) => r.applyOnly(runCtx, USER))).rejects.toBeInstanceOf(MemoryApplyUnsupportedError);
  });

  it("applyOnly: returns the Project scope", async () => {
    if (!available || !pool) return;
    await pool.query(
      "INSERT INTO projects (id, space_id, deleted_at) VALUES ('project-scope', $1, NULL)",
      [SPACE],
    );
    const projectScope = proposal({
      id: "p-project",
      payload_json: {
        target_scope: "project",
        target_visibility: "space_shared",
        proposed_content: "x",
        provenance_entries: [userConf],
      },
      project_id: "project-scope",
    });
    await seedProposal(projectScope);
    const result = await inTx((r) => r.applyOnly(projectScope, USER));
    expect(result.scopeType).toBe("project");
    const count = (await pool.query("SELECT count(*)::int AS c FROM memory_entries")).rows[0].c;
    expect(count).toBe(1);
  });
});
