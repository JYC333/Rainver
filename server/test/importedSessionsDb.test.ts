import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { PgImportedSessionRepository } from "../src/modules/importedSessions/repository.js";
import { ImportedSessionService } from "../src/modules/importedSessions/service.js";
import { ambientRecordHash } from "../src/modules/importedSessions/records.js";
import type { AmbientRecord } from "@rainver/protocol";

/**
 * Real-Postgres coverage for ambient-session reconciliation.
 *
 * What needs a database is the reconciliation itself: an ambient source is
 * rewritten on resume, split by compaction, and forked by rewind, so the
 * import has to behave as a set operation over `(session, record_key)` rather
 * than as a cursor advance. These are the cases that would each silently
 * produce a duplicate, a lost record, or a re-import of a whole folder.
 */

const SPACE = "51111111-1111-4111-8111-111111111111";
const OWNER = "5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MACHINE = "5ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOST = "5ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FOLDER = "5eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LOCATION = "5fffffff-ffff-4fff-8fff-ffffffffffff";

const db = useTestDatabase(import.meta.filename);

function record(overrides: Partial<AmbientRecord> & Pick<AmbientRecord, "record_key">): AmbientRecord {
  return {
    kind: "user_message",
    sequence: 0,
    occurred_at: null,
    text: "hello",
    tool_name: null,
    tool_status: null,
    tool_input: null,
    tool_output: null,
    raw_json: null,
    truncated: false,
    ...overrides,
  };
}

function reconcileInput(overrides: Partial<Parameters<PgImportedSessionRepository["reconcile"]>[0]> = {}) {
  return {
    spaceId: SPACE,
    projectId: PROJECT,
    projectFolderId: FOLDER,
    workspaceLocationId: LOCATION,
    executionHostId: HOST,
    ownerUserId: OWNER,
    adapterType: "claude_code",
    installation: "own",
    visibility: "space_shared",
    session: { session_id: "sess-1", cwd: "/home/me/project", title: "Branch review", updated_at: "2026-08-20T10:00:00.000Z" },
    loadState: "complete" as const,
    error: null,
    records: [record({ record_key: "message:msg-1" })],
    ...overrides,
  };
}

async function seedTopology(): Promise<void> {
  const now = new Date().toISOString();
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1, $2, 'Laptop', 'laptop', $3, $3)`,
    [MACHINE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'laptop', 'remote', 'linux_native', 'online', $4, $4)`,
    [HOST, OWNER, MACHINE, now],
  );
  await db.pool.query(
    `INSERT INTO project_folders (
       id, space_id, project_id, created_by_user_id, name, status, kind,
       is_primary, protected, system_managed, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'repo', 'active', 'code', true, false, false, $5, $5)`,
    [FOLDER, SPACE, PROJECT, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO workspace_locations (
       id, space_id, project_folder_id, execution_host_id, execution_host_kind, display_path,
       execution_ready, status, preferred, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'remote','/home/me/project',true,'active',true,$5,$5)`,
    [LOCATION, SPACE, FOLDER, HOST, now],
  );
}

describe("imported session reconciliation", () => {
  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      [
        "imported_session_records", "imported_sessions", "activity_records",
        "workspace_locations", "project_folders", "hosts", "machines",
        "projects", "space_memberships", "users", "spaces",
      ],
      { cascade: true },
    );
    await seedTopology();
  });

  it("creates the session and its records on a first import", async () => {
    const repository = new PgImportedSessionRepository(db.pool);
    const outcome = await repository.reconcile(reconcileInput());
    expect(outcome.inserted).toBe(1);
    expect(outcome.session.record_count).toBe(1);
    expect(outcome.session.visibility).toBe("space_shared");
    expect(outcome.session.source_state).toBe("present");
  });

  it("inserts nothing on a second import of the same replay", async () => {
    const repository = new PgImportedSessionRepository(db.pool);
    await repository.reconcile(reconcileInput());
    const second = await repository.reconcile(reconcileInput());
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.session.record_count).toBe(1);
  });

  it("adds only the new records when the conversation continued in the terminal", async () => {
    const repository = new PgImportedSessionRepository(db.pool);
    await repository.reconcile(reconcileInput());
    const second = await repository.reconcile(reconcileInput({
      records: [
        record({ record_key: "message:msg-1" }),
        record({ record_key: "message:msg-2", sequence: 1, text: "and then this" }),
      ],
    }));
    expect(second.inserted).toBe(1);
    expect(second.unchanged).toBe(1);
    expect(second.session.record_count).toBe(2);
  });

  it("keeps the first import when a record comes back different, and records the disagreement", async () => {
    const repository = new PgImportedSessionRepository(db.pool);
    await repository.reconcile(reconcileInput());
    const changed = record({ record_key: "message:msg-1", text: "rewritten by the vendor" });
    const second = await repository.reconcile(reconcileInput({ records: [changed] }));
    expect(second.conflicted).toBe(1);
    expect(second.inserted).toBe(0);
    const rows = (await repository.records(SPACE, second.session.id)).records;
    expect(rows).toHaveLength(1);
    // The imported copy is authoritative: by now it may be the only one left.
    expect(rows[0]!.text).toBe("hello");
    expect(rows[0]!.conflict_hash).toBe(ambientRecordHash(changed));
  });

  it("treats the same vendor session id from another installation as a different session", async () => {
    const repository = new PgImportedSessionRepository(db.pool);
    const own = await repository.reconcile(reconcileInput());
    const managed = await repository.reconcile(reconcileInput({ installation: "managed:1.2.3" }));
    expect(managed.session.id).not.toBe(own.session.id);
  });

  it("does not re-share a session the person made private on a later sync", async () => {
    const repository = new PgImportedSessionRepository(db.pool);
    const first = await repository.reconcile(reconcileInput());
    await repository.setVisibility(SPACE, first.session.id, "private");
    const second = await repository.reconcile(reconcileInput({ visibility: "space_shared" }));
    expect(second.session.visibility).toBe("private");
  });

  it("marks a session gone when the host no longer lists it, and keeps its records", async () => {
    const repository = new PgImportedSessionRepository(db.pool);
    const first = await repository.reconcile(reconcileInput());
    const marked = await repository.markMissingAsGone({
      spaceId: SPACE,
      workspaceLocationId: LOCATION,
      adapterType: "claude_code",
      installation: "own",
      listedVendorSessionIds: [],
    });
    expect(marked).toBe(1);
    const after = await repository.byId(SPACE, first.session.id);
    expect(after?.source_state).toBe("gone");
expect((await repository.records(SPACE, first.session.id)).records).toHaveLength(1);
  });

  it("reports a partial replay as partial and keeps what it produced", async () => {
    const repository = new PgImportedSessionRepository(db.pool);
    const outcome = await repository.reconcile(reconcileInput({
      loadState: "partial",
      error: "session/load timed out after 180000ms",
    }));
    expect(outcome.session.load_state).toBe("partial");
    expect(outcome.inserted).toBe(1);
  });

  it("offers a partial session for replay again, and a complete one only until its timestamp moves", async () => {
    const repository = new PgImportedSessionRepository(db.pool);
    await repository.reconcile(reconcileInput({ loadState: "partial", error: "interrupted" }));
    // A partial session is never reported as held: the next sync must retry it.
    expect(await repository.heldSessions({
      spaceId: SPACE, workspaceLocationId: LOCATION, adapterType: "claude_code", installation: "own",
    })).toHaveLength(0);

    await repository.reconcile(reconcileInput());
    const held = await repository.heldSessions({
      spaceId: SPACE, workspaceLocationId: LOCATION, adapterType: "claude_code", installation: "own",
    });
    expect(held).toEqual([{ session_id: "sess-1", updated_at: "2026-08-20T10:00:00.000Z" }]);
  });

  it("deletes a session and its records when the person asks", async () => {
    const repository = new PgImportedSessionRepository(db.pool);
    const first = await repository.reconcile(reconcileInput());
    expect(await repository.deleteSessions(SPACE, [first.session.id])).toBe(1);
    expect(await repository.byId(SPACE, first.session.id)).toBeNull();
    const remaining = await db.pool.query(
      `SELECT COUNT(*)::int AS total FROM imported_session_records WHERE imported_session_id = $1`,
      [first.session.id],
    );
    expect(remaining.rows[0]!.total).toBe(0);
  });

  it("keeps a session in another Space out of a Space-scoped read", async () => {
    const repository = new PgImportedSessionRepository(db.pool);
    const first = await repository.reconcile(reconcileInput());
    expect(await repository.byId(randomUUID(), first.session.id)).toBeNull();
  });

  describe("authorization", () => {
    const OTHER = "5a111111-1111-4111-8111-111111111111";

    async function service() {
      return new ImportedSessionService(db.pool, { databaseUrl: "postgres://unused" } as never);
    }

    it("refuses an import from a host the caller does not own", async () => {
      await seedSpaceMember(db.pool, { space: SPACE, user: OTHER, role: "admin" });
      // Admin of the Space, but not the owner of this machine. ADR 0016's hard
      // rule is that a host serves only its registered owner, and its ambient
      // history is that person's own terminal work.
      await expect((await service()).policy({ spaceId: SPACE, userId: OTHER }, LOCATION))
        .rejects.toThrow(/host owner/i);
    });

    it("does not show one member's private session to another", async () => {
      await seedSpaceMember(db.pool, { space: SPACE, user: OTHER, role: "member" });
      await db.pool.query(
        `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`,
        [randomUUID(), SPACE, PROJECT, OTHER],
      );
      const repository = new PgImportedSessionRepository(db.pool);
      const shared = await repository.reconcile(reconcileInput());
      const secret = await repository.reconcile(reconcileInput({
        session: { session_id: "sess-2", cwd: "/home/me/project", title: "Private notes", updated_at: null },
        visibility: "private",
      }));

      const visible = await repository.listForProjectAsViewer({ spaceId: SPACE, userId: OTHER }, PROJECT);
      expect(visible.map((row) => row.id)).toEqual([shared.session.id]);

      // Fail-closed, and the same answer as a session that does not exist:
      // no existence oracle for content the viewer may not read.
      await expect((await service()).records({ spaceId: SPACE, userId: OTHER }, secret.session.id))
        .rejects.toThrow(/not found/i);
    });

    it("shows the owner both of their own sessions", async () => {
      const repository = new PgImportedSessionRepository(db.pool);
      await repository.reconcile(reconcileInput());
      await repository.reconcile(reconcileInput({
        session: { session_id: "sess-2", cwd: "/home/me/project", title: "Private notes", updated_at: null },
        visibility: "private",
      }));
      const visible = await repository.listForProjectAsViewer({ spaceId: SPACE, userId: OWNER }, PROJECT);
      expect(visible).toHaveLength(2);
    });
  });
});
