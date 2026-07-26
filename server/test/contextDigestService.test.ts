import { describe, expect, it } from "vitest";
import {
  ContextDigestRefreshService,
  PgContextDigestService,
  renderPolicyBundleContent,
  renderMemoryBundleContent,
  markPolicyBundleDirty,
  markProjectFolderBundleDirty,
  markAgentBundleDirty,
} from "../src/modules/context/digestService";

// ---------------------------------------------------------------------------
// Minimal fake DB that tracks calls and can be configured per test.
// ---------------------------------------------------------------------------

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };
type PolicyInput = Parameters<typeof renderPolicyBundleContent>[0][number];

class FakeDb {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  readonly updates: string[] = [];
  private _policies: Record<string, unknown>[] = [];
  private _memories: Record<string, unknown>[] = [];
  private _digest: Record<string, unknown> | null = null;
  private _insertedDigestId: string | null = null;
  private _dirtyDigests: Record<string, unknown>[] = [];
  private _scopeActive = true;

  withPolicies(rows: Record<string, unknown>[]): this {
    this._policies = rows;
    return this;
  }

  withScopeActive(active: boolean): this {
    this._scopeActive = active;
    return this;
  }

  withMemories(rows: Record<string, unknown>[]): this {
    this._memories = rows;
    return this;
  }

  withDigest(row: Record<string, unknown> | null): this {
    this._digest = row;
    return this;
  }

  withDirtyDigests(rows: Record<string, unknown>[]): this {
    this._dirtyDigests = rows;
    return this;
  }

  captureInsertedDigestId(): string | null {
    return this._insertedDigestId;
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.queries.push({ sql, params });
    const norm = sql.replace(/\s+/g, " ").trim();

    if (norm.startsWith("SELECT 1 FROM project_folders") || norm.startsWith("SELECT 1 FROM agents")) {
      return this._scopeActive ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (norm.startsWith("SELECT id, name, domain") && norm.includes("FROM policies")) {
      return { rows: this._policies, rowCount: this._policies.length };
    }
    if (norm.startsWith("SELECT id, title, content, namespace, memory_layer, memory_type")) {
      return { rows: this._memories, rowCount: this._memories.length };
    }
    if (norm.startsWith("SELECT id, version, status, source_hash")) {
      return { rows: this._digest ? [this._digest] : [], rowCount: this._digest ? 1 : 0 };
    }
    if (norm.startsWith("SELECT scope_type, scope_id, digest_type")) {
      return { rows: this._dirtyDigests, rowCount: this._dirtyDigests.length };
    }
    if (norm.startsWith("UPDATE context_digests SET status = 'active'")) {
      this.updates.push("mark_active");
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("UPDATE context_digests SET status = 'superseded'")) {
      this.updates.push("supersede");
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("UPDATE context_digests SET status = 'dirty'")) {
      this.updates.push("mark_dirty");
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("INSERT INTO context_digests")) {
      this._insertedDigestId = params[0] as string;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

function policy(over: Partial<PolicyInput> = {}): PolicyInput & Record<string, unknown> {
  return {
    id: "pol-1",
    name: "AllowTools",
    domain: "runtime",
    policy_key: "runtime.allow_tools",
    enforcement_mode: "allow",
    priority: 10,
    policy_json: { rule: "All tools are permitted" },
    policy_version: 1,
    ...over,
  } as PolicyInput & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// renderPolicyBundleContent
// ---------------------------------------------------------------------------

describe("renderPolicyBundleContent", () => {
  it("returns empty string for no policies", () => {
    expect(renderPolicyBundleContent([])).toBe("");
  });

  it("formats a single policy with enforcement_mode", () => {
    const content = renderPolicyBundleContent([policy()]);
    expect(content).toContain("## runtime");
    expect(content).toContain("**AllowTools**");
    expect(content).toContain("[`allow`]");
    expect(content).toContain("All tools are permitted");
  });

  it("groups policies by domain and sorts domains alphabetically", () => {
    const policies = [
      policy({ id: "p1", domain: "memory", name: "RequireApproval", enforcement_mode: "require_approval", policy_json: {} }),
      policy({ id: "p2", domain: "egress", name: "BlockCrossSpace", enforcement_mode: "deny", policy_json: {} }),
      policy({ id: "p3", domain: "runtime", name: "AllowTools", enforcement_mode: "allow", policy_json: {} }),
    ];
    const content = renderPolicyBundleContent(policies);
    const egressIdx = content.indexOf("## egress");
    const memoryIdx = content.indexOf("## memory");
    const runtimeIdx = content.indexOf("## runtime");
    expect(egressIdx).toBeLessThan(memoryIdx);
    expect(memoryIdx).toBeLessThan(runtimeIdx);
  });

  it("omits detail when policy_json has no recognised text field", () => {
    const content = renderPolicyBundleContent([
      policy({ policy_json: { threshold: 42 } }),
    ]);
    expect(content).toContain("**AllowTools**");
    expect(content).not.toContain("42"); // numeric field not surfaced
  });

  it("omits enforcement_mode suffix when null", () => {
    const content = renderPolicyBundleContent([
      policy({ enforcement_mode: null }),
    ]);
    expect(content).not.toContain("[`");
  });
});

// ---------------------------------------------------------------------------
// PgContextDigestService.generatePolicyBundle
// ---------------------------------------------------------------------------

describe("PgContextDigestService.generatePolicyBundle", () => {
  it("inserts a new digest when none exists", async () => {
    const db = new FakeDb().withPolicies([policy()]).withDigest(null);
    const svc = new PgContextDigestService(db as never);
    const result = await svc.generatePolicyBundle("space-1");
    expect(result.status).toBe("generated");
    expect(result.version).toBe(1);
    expect(result.source_policy_count).toBe(1);
    expect(db.captureInsertedDigestId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns 'unchanged' when source_hash matches existing active digest", async () => {
    // Generate a real source_hash first by running once against an empty db.
    const seeder = new FakeDb().withPolicies([policy()]).withDigest(null);
    const svc1 = new PgContextDigestService(seeder as never);
    const first = await svc1.generatePolicyBundle("space-1");

    // Now run again with the same source_hash pre-seeded as existing.
    const db = new FakeDb()
      .withPolicies([policy()])
      .withDigest({ id: "old-digest", version: 1, status: "active", source_hash: first.source_hash });
    const svc2 = new PgContextDigestService(db as never);
    const result = await svc2.generatePolicyBundle("space-1");
    expect(result.status).toBe("unchanged");
    expect(result.id).toBe("old-digest");
    expect(db.captureInsertedDigestId()).toBeNull(); // no new INSERT
  });

  it("supersedes old digest and inserts new when policies changed", async () => {
    const db = new FakeDb()
      .withPolicies([policy()])
      .withDigest({ id: "old-digest", version: 2, status: "active", source_hash: "stale-hash" });
    const svc = new PgContextDigestService(db as never);
    const result = await svc.generatePolicyBundle("space-1");
    expect(result.status).toBe("generated");
    expect(result.version).toBe(3); // previous version was 2
    expect(db.updates).toContain("supersede");
    expect(db.captureInsertedDigestId()).not.toBeNull();
  });

  it("re-activates a dirty digest when source_hash is unchanged", async () => {
    const seeder = new FakeDb().withPolicies([policy()]).withDigest(null);
    const first = await new PgContextDigestService(seeder as never).generatePolicyBundle("space-1");

    const db = new FakeDb()
      .withPolicies([policy()])
      .withDigest({ id: "dirty-digest", version: 1, status: "dirty", source_hash: first.source_hash });
    const svc = new PgContextDigestService(db as never);
    const result = await svc.generatePolicyBundle("space-1");
    expect(result.status).toBe("unchanged");
    expect(result.id).toBe("dirty-digest");
    expect(db.updates).toContain("mark_active");
    expect(db.captureInsertedDigestId()).toBeNull();
  });

  it("produces a stable source_hash for identical policies", async () => {
    const run = async () => {
      const db = new FakeDb().withPolicies([policy()]).withDigest(null);
      return new PgContextDigestService(db as never).generatePolicyBundle("space-1");
    };
    const [r1, r2] = await Promise.all([run(), run()]);
    expect(r1.source_hash).toBe(r2.source_hash);
  });

  it("changes source_hash when policy priority or applies_to changes", async () => {
    const base = await new PgContextDigestService(
      new FakeDb().withPolicies([
        policy({ priority: 10, applies_to_json: { project_folder_ids: ["ws-1"] } }),
      ]).withDigest(null) as never,
    ).generatePolicyBundle("space-1");
    const priorityChanged = await new PgContextDigestService(
      new FakeDb().withPolicies([
        policy({ priority: 20, applies_to_json: { project_folder_ids: ["ws-1"] } }),
      ]).withDigest(null) as never,
    ).generatePolicyBundle("space-1");
    const scopeChanged = await new PgContextDigestService(
      new FakeDb().withPolicies([
        policy({ priority: 10, applies_to_json: { project_folder_ids: ["ws-2"] } }),
      ]).withDigest(null) as never,
    ).generatePolicyBundle("space-1");

    expect(priorityChanged.source_hash).not.toBe(base.source_hash);
    expect(scopeChanged.source_hash).not.toBe(base.source_hash);
  });

  it("rolls back the active digest transaction when inserting the replacement fails", async () => {
    const client = {
      queries: [] as string[],
      released: false,
      async query(sql: string, params: readonly unknown[] = []) {
        this.queries.push(sql);
        const norm = sql.replace(/\s+/g, " ").trim();
        if (norm.startsWith("SELECT id, name, domain")) {
          return { rows: [policy()], rowCount: 1 };
        }
        if (norm.startsWith("SELECT id, version, status, source_hash")) {
          return {
            rows: [{ id: "active-digest", version: 2, status: "active", source_hash: "stale" }],
            rowCount: 1,
          };
        }
        if (norm.startsWith("INSERT INTO context_digests")) {
          throw new Error(`insert failed for ${params[0]}`);
        }
        return { rows: [], rowCount: 0 };
      },
      release() {
        this.released = true;
      },
    };
    const pool = {
      async connect() {
        return client;
      },
    };

    await expect(
      new PgContextDigestService(pool as never).generatePolicyBundle("space-1"),
    ).rejects.toThrow(/insert failed/);

    expect(client.queries[0]).toBe("BEGIN");
    expect(client.queries).toContain("ROLLBACK");
    expect(client.queries).not.toContain("COMMIT");
    expect(client.released).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// markPolicyBundleDirty
// ---------------------------------------------------------------------------

describe("markPolicyBundleDirty", () => {
  it("issues UPDATE to set status=dirty on active or already-dirty digest", async () => {
    const db = new FakeDb();
    await markPolicyBundleDirty(db as never, "space-1", { triggered_by: "test" });
    expect(db.updates).toContain("mark_dirty");
    const updateQuery = db.queries.find((q) => q.sql.includes("status = 'dirty'"));
    expect(updateQuery).toBeDefined();
    expect(updateQuery?.sql).toContain("status IN ('active', 'dirty')");
    expect(updateQuery?.params).toContain("space-1");
  });

  it("takes the same advisory lock key as generation before marking dirty", async () => {
    const db = new FakeDb();
    await markPolicyBundleDirty(db as never, "space-1", { triggered_by: "test" });
    const lock = db.queries.find((q) => q.sql.includes("pg_advisory_xact_lock"));
    expect(lock).toBeDefined();
    expect(lock?.params).toContain("policy_bundle:space-1");
    // Lock must be acquired before the dirty UPDATE.
    const lockIdx = db.queries.findIndex((q) => q.sql.includes("pg_advisory_xact_lock"));
    const updateIdx = db.queries.findIndex((q) => q.sql.includes("status = 'dirty'"));
    expect(lockIdx).toBeLessThan(updateIdx);
  });
});

// ---------------------------------------------------------------------------
// renderMemoryBundleContent
// ---------------------------------------------------------------------------

function mem(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "mem-1",
    title: "Default title",
    content: "Some workspace context.",
    namespace: "workspace.default",
    memory_layer: "semantic",
    memory_type: null,
    version: 1,
    ...over,
  };
}

describe("renderMemoryBundleContent", () => {
  it("returns empty string for no memories", () => {
    expect(renderMemoryBundleContent([])).toBe("");
  });

  it("formats a single memory using memory_type as group", () => {
    const content = renderMemoryBundleContent([
      mem({ memory_type: "architecture", memory_layer: "semantic" }) as never,
    ]);
    expect(content).toContain("## architecture");
    expect(content).toContain("**Default title**");
    expect(content).toContain("[`semantic`]");
    expect(content).toContain("Some workspace context.");
  });

  it("falls back to namespace suffix when memory_type is null", () => {
    const content = renderMemoryBundleContent([
      mem({ memory_type: null, namespace: "workspace.codebase" }) as never,
    ]);
    expect(content).toContain("## codebase");
  });

  it("groups by memory_type and sorts groups alphabetically", () => {
    const memories = [
      mem({ id: "m1", memory_type: "procedure", title: "How to deploy" }),
      mem({ id: "m2", memory_type: "architecture", title: "System design" }),
      mem({ id: "m3", memory_type: "context", title: "Project background" }),
    ];
    const content = renderMemoryBundleContent(memories as never[]);
    const archIdx = content.indexOf("## architecture");
    const ctxIdx = content.indexOf("## context");
    const procIdx = content.indexOf("## procedure");
    expect(archIdx).toBeLessThan(ctxIdx);
    expect(ctxIdx).toBeLessThan(procIdx);
  });

  it("truncates content to 300 chars", () => {
    const longContent = "x".repeat(500);
    const content = renderMemoryBundleContent([
      mem({ content: longContent }) as never,
    ]);
    expect(content).not.toContain("x".repeat(301));
    expect(content).toContain("x".repeat(300));
  });

  it("omits memory_layer suffix when null", () => {
    const content = renderMemoryBundleContent([
      mem({ memory_layer: null }) as never,
    ]);
    expect(content).not.toContain("[`");
  });
});

// ---------------------------------------------------------------------------
// PgContextDigestService.generateProjectFolderBundle
// ---------------------------------------------------------------------------

describe("PgContextDigestService.generateProjectFolderBundle", () => {
  it("inserts a new digest when none exists", async () => {
    const db = new FakeDb().withMemories([mem()]).withDigest(null);
    const svc = new PgContextDigestService(db as never);
    const result = await svc.generateProjectFolderBundle("space-1", "ws-1");
    expect(result.status).toBe("generated");
    expect(result.version).toBe(1);
    expect(result.scope_id).toBe("ws-1");
    expect(result.source_memory_count).toBe(1);
    expect(db.captureInsertedDigestId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns 'unchanged' when source_hash matches existing active digest", async () => {
    const seeder = new FakeDb().withMemories([mem()]).withDigest(null);
    const first = await new PgContextDigestService(seeder as never).generateProjectFolderBundle("space-1", "ws-1");

    const db = new FakeDb()
      .withMemories([mem()])
      .withDigest({ id: "old-digest", version: 1, status: "active", source_hash: first.source_hash });
    const result = await new PgContextDigestService(db as never).generateProjectFolderBundle("space-1", "ws-1");
    expect(result.status).toBe("unchanged");
    expect(result.id).toBe("old-digest");
    expect(db.captureInsertedDigestId()).toBeNull();
  });

  it("supersedes old digest and inserts new when memories changed", async () => {
    const db = new FakeDb()
      .withMemories([mem()])
      .withDigest({ id: "old-digest", version: 2, status: "active", source_hash: "stale-hash" });
    const result = await new PgContextDigestService(db as never).generateProjectFolderBundle("space-1", "ws-1");
    expect(result.status).toBe("generated");
    expect(result.version).toBe(3);
    expect(db.updates).toContain("supersede");
    expect(db.captureInsertedDigestId()).not.toBeNull();
  });

  it("re-activates a dirty digest when source_hash is unchanged", async () => {
    const seeder = new FakeDb().withMemories([mem()]).withDigest(null);
    const first = await new PgContextDigestService(seeder as never).generateProjectFolderBundle("space-1", "ws-1");

    const db = new FakeDb()
      .withMemories([mem()])
      .withDigest({ id: "dirty-digest", version: 1, status: "dirty", source_hash: first.source_hash });
    const result = await new PgContextDigestService(db as never).generateProjectFolderBundle("space-1", "ws-1");
    expect(result.status).toBe("unchanged");
    expect(db.updates).toContain("mark_active");
    expect(db.captureInsertedDigestId()).toBeNull();
  });

  it("uses project_folder_id column in the memory query", async () => {
    const db = new FakeDb().withMemories([]).withDigest(null);
    await new PgContextDigestService(db as never).generateProjectFolderBundle("space-1", "ws-99");
    const memQuery = db.queries.find((q) => q.sql.includes("FROM memory_entries"));
    expect(memQuery).toBeDefined();
    expect(memQuery?.sql).toContain("project_folder_id");
    expect(memQuery?.sql).toContain("project_id IS NULL");
    expect(memQuery?.sql).toContain("me.visibility = 'space_shared'");
    expect(memQuery?.sql).toContain("highly_restricted");
    expect(memQuery?.params).toContain("ws-99");
  });

  it("fails closed (404) when the workspace is missing or archived", async () => {
    const db = new FakeDb().withMemories([mem()]).withDigest(null).withScopeActive(false);
    await expect(
      new PgContextDigestService(db as never).generateProjectFolderBundle("space-1", "ws-gone"),
    ).rejects.toMatchObject({ statusCode: 404 });
    // Existence is checked before any memory load or digest insert.
    expect(db.queries.some((q) => q.sql.includes("FROM memory_entries"))).toBe(false);
    expect(db.captureInsertedDigestId()).toBeNull();
  });

  it("locks the scope row FOR UPDATE to serialize against a concurrent archive", async () => {
    const db = new FakeDb().withMemories([]).withDigest(null);
    await new PgContextDigestService(db as never).generateProjectFolderBundle("space-1", "ws-1");
    const scopeCheck = db.queries.find((q) => q.sql.includes("FROM project_folders"));
    expect(scopeCheck?.sql).toContain("FOR UPDATE");
  });
});

// ---------------------------------------------------------------------------
// PgContextDigestService.generateAgentBundle
// ---------------------------------------------------------------------------

describe("PgContextDigestService.generateAgentBundle", () => {
  it("inserts a new agent digest when none exists", async () => {
    const db = new FakeDb().withMemories([mem()]).withDigest(null);
    const result = await new PgContextDigestService(db as never).generateAgentBundle("space-1", "agent-1");
    expect(result.status).toBe("generated");
    expect(result.scope_id).toBe("agent-1");
    expect(result.source_memory_count).toBe(1);
    expect(db.captureInsertedDigestId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses agent_id column in the memory query", async () => {
    const db = new FakeDb().withMemories([]).withDigest(null);
    await new PgContextDigestService(db as never).generateAgentBundle("space-1", "agent-42");
    const memQuery = db.queries.find((q) => q.sql.includes("FROM memory_entries"));
    expect(memQuery?.sql).toContain("agent_id");
    expect(memQuery?.sql).toContain("project_id IS NULL");
    expect(memQuery?.sql).toContain("me.visibility = 'space_shared'");
    expect(memQuery?.params).toContain("agent-42");
  });

  it("fails closed (404) when the agent is missing or archived", async () => {
    const db = new FakeDb().withMemories([mem()]).withDigest(null).withScopeActive(false);
    await expect(
      new PgContextDigestService(db as never).generateAgentBundle("space-1", "agent-gone"),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(db.captureInsertedDigestId()).toBeNull();
  });

  it("produces different source hashes for workspace vs agent with same memories", async () => {
    const run = async (method: "generateProjectFolderBundle" | "generateAgentBundle") => {
      const db = new FakeDb().withMemories([mem()]).withDigest(null);
      const svc = new PgContextDigestService(db as never);
      return svc[method]("space-1", "scope-1");
    };
    const [ws, ag] = await Promise.all([run("generateProjectFolderBundle"), run("generateAgentBundle")]);
    expect(ws.source_hash).not.toBe(ag.source_hash);
  });
});

// ---------------------------------------------------------------------------
// markProjectFolderBundleDirty / markAgentBundleDirty
// ---------------------------------------------------------------------------

describe("markProjectFolderBundleDirty", () => {
  it("issues UPDATE with workspace scope_type and workspace scope_id", async () => {
    const db = new FakeDb();
    await markProjectFolderBundleDirty(db as never, "space-1", "ws-1", { triggered_by: "test" });
    expect(db.updates).toContain("mark_dirty");
    const updateQuery = db.queries.find((q) => q.sql.includes("status = 'dirty'"));
    expect(updateQuery?.sql).toContain("scope_type = 'project_folder'");
    expect(updateQuery?.sql).toContain("status IN ('active', 'dirty')");
    expect(updateQuery?.params).toContain("space-1");
    expect(updateQuery?.params).toContain("ws-1");
  });

  it("takes the workspace generation advisory lock before marking dirty", async () => {
    const db = new FakeDb();
    await markProjectFolderBundleDirty(db as never, "space-1", "ws-1", { triggered_by: "test" });
    const lock = db.queries.find((q) => q.sql.includes("pg_advisory_xact_lock"));
    expect(lock?.params).toContain("project_folder:space-1:ws-1");
    const lockIdx = db.queries.findIndex((q) => q.sql.includes("pg_advisory_xact_lock"));
    const updateIdx = db.queries.findIndex((q) => q.sql.includes("status = 'dirty'"));
    expect(lockIdx).toBeLessThan(updateIdx);
  });
});

describe("markAgentBundleDirty", () => {
  it("issues UPDATE with agent scope_type and agent scope_id", async () => {
    const db = new FakeDb();
    await markAgentBundleDirty(db as never, "space-1", "agent-1", { triggered_by: "test" });
    expect(db.updates).toContain("mark_dirty");
    const updateQuery = db.queries.find((q) => q.sql.includes("status = 'dirty'"));
    expect(updateQuery?.sql).toContain("scope_type = 'agent'");
    expect(updateQuery?.sql).toContain("status IN ('active', 'dirty')");
    expect(updateQuery?.params).toContain("space-1");
    expect(updateQuery?.params).toContain("agent-1");
  });

  it("takes the agent generation advisory lock before marking dirty", async () => {
    const db = new FakeDb();
    await markAgentBundleDirty(db as never, "space-1", "agent-1", { triggered_by: "test" });
    const lock = db.queries.find((q) => q.sql.includes("pg_advisory_xact_lock"));
    expect(lock?.params).toContain("agent:space-1:agent-1");
    const lockIdx = db.queries.findIndex((q) => q.sql.includes("pg_advisory_xact_lock"));
    const updateIdx = db.queries.findIndex((q) => q.sql.includes("status = 'dirty'"));
    expect(lockIdx).toBeLessThan(updateIdx);
  });
});

describe("ContextDigestRefreshService", () => {
  it("refreshes every dirty digest in a space", async () => {
    const db = new FakeDb()
      .withPolicies([policy()])
      .withMemories([mem()])
      .withDigest(null)
      .withDirtyDigests([
        { scope_type: "space", scope_id: null, digest_type: "policy_bundle" },
        { scope_type: "project_folder", scope_id: "ws-1", digest_type: "project_folder" },
        { scope_type: "agent", scope_id: "agent-1", digest_type: "agent" },
      ]);

    const results = await new ContextDigestRefreshService(db as never).refreshAllDirty("space-1");

    expect(results.map((r) => `${r.digest_type}:${r.scope_id ?? "space"}`)).toEqual([
      "policy_bundle:space",
      "project_folder:ws-1",
      "agent:agent-1",
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        digest_type: "policy_bundle",
        scope_type: "space",
        scope_id: null,
        source_policy_count: 1,
      }),
      expect.objectContaining({
        digest_type: "project_folder",
        scope_type: "project_folder",
        scope_id: "ws-1",
        source_memory_count: 1,
      }),
      expect.objectContaining({
        digest_type: "agent",
        scope_type: "agent",
        scope_id: "agent-1",
        source_memory_count: 1,
      }),
    ]);
  });
});
