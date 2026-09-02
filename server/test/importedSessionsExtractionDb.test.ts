import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { ImportedHistoryExtractionService } from "../src/modules/importedSessions/extraction.js";
import { PgImportedSessionRepository } from "../src/modules/importedSessions/repository.js";
import * as invocation from "../src/modules/providers/invocation/invocation.js";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import { registerImportedHistoryProposalAppliers } from "../src/modules/importedSessions/extractionApplier.js";
import { registerProjectDefinitionProposalAppliers } from "../src/modules/projects/projectDefinitionProposalApplier.js";
import { PgMemoryApplyRepository } from "../src/modules/memory/memoryApplyRepository.js";
import { withQueryableTransaction } from "../src/modules/routeUtils/common.js";
import type { AmbientRecord } from "@rainver/protocol";

/**
 * Extraction from imported CLI history.
 *
 * The model call is stubbed; what needs a database is everything around it —
 * which records are eligible to be read at all, that reading them twice is not
 * possible, and that what comes back becomes proposals rather than writes. The
 * eligibility rule is the load-bearing one: the Brief has no per-object
 * visibility, so a private session reaching extraction would publish its
 * content to every Project member through it.
 */

const SPACE = "71111111-1111-4111-8111-111111111111";
const OWNER = "7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "7bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MACHINE = "7ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOST = "7ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FOLDER = "7eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LOCATION = "7fffffff-ffff-4fff-8fff-ffffffffffff";

const db = useTestDatabase(import.meta.filename);
const identity = { spaceId: SPACE, userId: OWNER };

function serverConfig() {
  return { databaseUrl: db.connectionUri } as never;
}

function record(key: string, text: string): AmbientRecord {
  return {
    record_key: key,
    kind: "user_message",
    sequence: 0,
    occurred_at: null,
    text,
    tool_name: null,
    tool_status: null,
    tool_input: null,
    tool_output: null,
    raw_json: null,
    truncated: false,
  };
}

/** Stands in for the model, echoing back refs the caller supplies. */
function stubExtractor(build: (recordIds: string[]) => Record<string, unknown>) {
  return vi.spyOn(invocation, "completeProviderText").mockImplementation(async (_store, _space, body) => {
    const user = JSON.parse((body as { user: string }).user) as {
      selected_event_delta: Array<{ canonical_ref: { id: string } }>;
    };
    const ids = user.selected_event_delta.map((entry) => entry.canonical_ref.id);
    return { text: JSON.stringify(build(ids)), provider: "test", model: "test" } as never;
  });
}

function extraction(): Record<string, unknown> {
  return {
    goals: [], user_intent: [], decisions: [], constraints: [], facts: [],
    open_questions: [], tasks: [], artifact_refs: [], tool_refs: [], correction_refs: [],
  };
}

async function seedSession(visibility: "private" | "space_shared", records: AmbientRecord[]): Promise<string> {
  const outcome = await new PgImportedSessionRepository(db.pool).reconcile({
    spaceId: SPACE,
    projectId: PROJECT,
    projectFolderId: FOLDER,
    workspaceLocationId: LOCATION,
    executionHostId: HOST,
    ownerUserId: OWNER,
    adapterType: "claude_code",
    installation: "own",
    visibility,
    session: {
      session_id: `sess-${visibility}-${records.length}`,
      cwd: "/home/me/project",
      title: visibility,
      updated_at: "2026-08-20T10:00:00.000Z",
    },
    loadState: "complete",
    error: null,
    records,
  });
  return outcome.session.id;
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
       execution_ready, status, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'remote','/home/me/project',true,'active',$5,$5)`,
    [LOCATION, SPACE, FOLDER, HOST, now],
  );
  const briefId = randomUUID();
  await db.pool.query(
    `INSERT INTO project_brief_versions (
       id, space_id, project_id, version, goal, project_status, status, created_at
     ) VALUES ($1, $2, $3, 'v1', 'Ship the importer', 'active', 'published', now())`,
    [briefId, SPACE, PROJECT],
  );
  await db.pool.query(
    `UPDATE projects SET active_brief_version_id = $2 WHERE id = $1`,
    [PROJECT, briefId],
  );
}

describe("imported history extraction", () => {
  beforeEach(async () => {
    if (!db.available) return;
    vi.restoreAllMocks();
    await resetTables(
      db.pool,
      [
        "proposals", "imported_session_records", "imported_sessions", "project_brief_versions",
        "workspace_locations", "project_folders", "hosts", "machines",
        "projects", "space_memberships", "users", "spaces",
      ],
      { cascade: true },
    );
    await seedTopology();
  });

  function service() {
    return new ImportedHistoryExtractionService(db.pool, serverConfig());
  }

  it("never reads a session the person kept private", async () => {
    await seedSession("private", [record("m1", "a private thought")]);
    // The Brief the extraction feeds has no visibility of its own, so a
    // private session reaching it would publish its content to the Project.
    expect(await service().pending(identity, PROJECT)).toEqual({ records: 0, sessions: 0 });

    const stub = stubExtractor(() => extraction());
    const outcome = await service().extract(identity, PROJECT);
    expect(outcome.records_covered).toBe(0);
    expect(stub).not.toHaveBeenCalled();
  });

  it("reads a shared session once and not again", async () => {
    await seedSession("space_shared", [record("m1", "we decided to use ACP")]);
    expect(await service().pending(identity, PROJECT)).toEqual({ records: 1, sessions: 1 });

    stubExtractor((ids) => ({
      ...extraction(),
      decisions: [{ id: randomUUID(), text: "Use ACP", confirmation_state: "candidate", source_refs: [{ type: "imported_session_record", id: ids[0] }] }],
    }));
    const first = await service().extract(identity, PROJECT);
    expect(first.records_covered).toBe(1);
    expect(first.decisions).toBe(1);

    // Marked read whether or not anything was found: re-reading the same
    // records forever would spend model budget on the same silence.
    expect(await service().pending(identity, PROJECT)).toEqual({ records: 0, sessions: 0 });
    const second = await service().extract(identity, PROJECT);
    expect(second.records_covered).toBe(0);
    expect(second.brief_proposal_id).toBeNull();
  });

  it("proposes rather than writes: the active Brief is unchanged until the proposal is accepted", async () => {
    await seedSession("space_shared", [record("m1", "the control group was wrong")]);
    stubExtractor((ids) => ({
      ...extraction(),
      decisions: [{ id: randomUUID(), text: "Rebuild the control group", confirmation_state: "candidate", source_refs: [{ type: "imported_session_record", id: ids[0] }] }],
    }));
    const outcome = await service().extract(identity, PROJECT);
    expect(outcome.brief_proposal_id).not.toBeNull();

    const proposals = await db.pool.query<{ proposal_type: string; status: string }>(
      `SELECT proposal_type, status FROM proposals WHERE space_id = $1`,
      [SPACE],
    );
    expect(proposals.rows).toEqual([{ proposal_type: "project_brief_publish", status: "pending" }]);
    const briefs = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM project_brief_versions WHERE project_id = $1`,
      [PROJECT],
    );
    expect(briefs.rows[0]!.total).toBe("1");
  });

  it("packs what was learned into one proposal, not one per fact", async () => {
    await seedSession("space_shared", [record("m1", "pnpm, not npm"), record("m2", "tests need real postgres")]);
    stubExtractor((ids) => ({
      ...extraction(),
      facts: ids.map((id) => ({
        id: randomUUID(),
        text: `fact from ${id}`,
        confirmation_state: "candidate",
        fact_status: "asserted",
        source_refs: [{ type: "imported_session_record", id }],
      })),
    }));
    const outcome = await service().extract(identity, PROJECT);
    expect(outcome.facts).toBe(2);

    // One item on the Project's attention list, not one per fact.
    const packets = await db.pool.query<{ payload_json: { candidates: unknown[] } }>(
      `SELECT payload_json FROM proposals WHERE space_id = $1 AND proposal_type = 'imported_history_memory_packet'`,
      [SPACE],
    );
    expect(packets.rows).toHaveLength(1);
    expect(packets.rows[0]!.payload_json.candidates).toHaveLength(2);
  });

  it("drops a citation the model invented rather than storing one that cannot be opened", async () => {
    await seedSession("space_shared", [record("m1", "real material")]);
    stubExtractor(() => ({
      ...extraction(),
      decisions: [{
        id: randomUUID(),
        text: "Something the material never said",
        confirmation_state: "candidate",
        source_refs: [{ type: "imported_session_record", id: randomUUID() }],
      }],
    }));
    const outcome = await service().extract(identity, PROJECT);
    expect(outcome.decisions).toBe(0);
    expect(outcome.brief_proposal_id).toBeNull();
  });

  it("does not invent a goal for a Project that has none", async () => {
    await db.pool.query(`UPDATE projects SET active_brief_version_id = NULL WHERE id = $1`, [PROJECT]);
    await seedSession("space_shared", [record("m1", "we decided to use ACP")]);
    stubExtractor((ids) => ({
      ...extraction(),
      decisions: [{ id: randomUUID(), text: "Use ACP", confirmation_state: "candidate", source_refs: [{ type: "imported_session_record", id: ids[0] }] }],
    }));
    const outcome = await service().extract(identity, PROJECT);
    // History says how the work went, not what the Project is for. A
    // placeholder goal published into the Brief is worse than an empty one:
    // the next Run reads it as the Project's purpose.
    expect(outcome.brief_proposal_id).toBeNull();
    expect(outcome.records_covered).toBe(1);
  });

  it("carries each decision's citations into the Brief proposal", async () => {
    const sessionId = await seedSession("space_shared", [record("m1", "we decided to use ACP")]);
    let citedRecordId = "";
    stubExtractor((ids) => {
      citedRecordId = ids[0]!;
      return {
        ...extraction(),
        decisions: [{ id: randomUUID(), text: "Use ACP", confirmation_state: "candidate", source_refs: [{ type: "imported_session_record", id: ids[0] }] }],
      };
    });
    await service().extract(identity, PROJECT);
    const proposal = await db.pool.query<{
      id: string;
      payload_json: { confirmed_decisions: string[]; source_refs: Array<{ id: string }> };
    }>(
      `SELECT id, payload_json FROM proposals WHERE space_id = $1 AND proposal_type = 'project_brief_publish'`,
      [SPACE],
    );
    const payload = proposal.rows[0]!.payload_json;
    // Decisions are strings, because that is what `confirmed_decisions` is
    // everywhere; an object parses into the proposal and then fails 422 at
    // acceptance, which is a proposal nobody can accept. The citations ride in
    // `source_refs`, so a reader can still trace a decision back.
    expect(payload.confirmed_decisions).toContain("Use ACP");
    expect(payload.source_refs.map((ref) => ref.id)).toContain(citedRecordId);
    expect(sessionId).toBeTruthy();

    // The proposal must actually be acceptable — the whole point of it.
    const registry = new ProposalApplierRegistry();
    registerProjectDefinitionProposalAppliers(registry);
    const applied = await withQueryableTransaction(db.pool, (tx) => registry.apply({
      db: tx,
      proposal: { ...proposal.rows[0]!, space_id: SPACE, project_id: PROJECT, proposal_type: "project_brief_publish" },
      userId: OWNER,
    } as never));
    expect(applied.result_type).toBe("project_brief_version");
    const active = await db.pool.query<{ goal: string; confirmed_decisions_json: string[] }>(
      `SELECT b.goal, b.confirmed_decisions_json FROM projects p
         JOIN project_brief_versions b ON b.id = p.active_brief_version_id
        WHERE p.id = $1`,
      [PROJECT],
    );
    expect(active.rows[0]!.confirmed_decisions_json).toContain("Use ACP");
  });

  it("merges into a Brief proposal already waiting instead of opening a second that overwrites it", async () => {
    await seedSession("space_shared", [record("m1", "first decision")]);
    stubExtractor((ids) => ({
      ...extraction(),
      decisions: [{ id: randomUUID(), text: "Decision one", confirmation_state: "candidate", source_refs: [{ type: "imported_session_record", id: ids[0] }] }],
    }));
    const first = await service().extract(identity, PROJECT);

    await seedSession("space_shared", [record("m2", "second decision"), record("m3", "and more")]);
    stubExtractor((ids) => ({
      ...extraction(),
      decisions: [{ id: randomUUID(), text: "Decision two", confirmation_state: "candidate", source_refs: [{ type: "imported_session_record", id: ids[0] }] }],
    }));
    const second = await service().extract(identity, PROJECT);

    // Each proposal carries a complete replacement for the decision list, so
    // two pending ones would silently drop each other's work.
    expect(second.brief_proposal_id).toBe(first.brief_proposal_id);
    const proposals = await db.pool.query<{ payload_json: { confirmed_decisions: string[] } }>(
      `SELECT payload_json FROM proposals WHERE space_id = $1 AND proposal_type = 'project_brief_publish'`,
      [SPACE],
    );
    expect(proposals.rows).toHaveLength(1);
    expect(proposals.rows[0]!.payload_json.confirmed_decisions).toEqual(
      expect.arrayContaining(["Decision one", "Decision two"]),
    );
  });

  it("keeps what it found when the Project has no goal to define, instead of burning the records", async () => {
    await db.pool.query(`UPDATE projects SET active_brief_version_id = NULL WHERE id = $1`, [PROJECT]);
    await seedSession("space_shared", [record("m1", "we decided to use ACP")]);
    stubExtractor((ids) => ({
      ...extraction(),
      decisions: [{ id: randomUUID(), text: "Use ACP", confirmation_state: "candidate", source_refs: [{ type: "imported_session_record", id: ids[0] }] }],
    }));
    const outcome = await service().extract(identity, PROJECT);
    expect(outcome.brief_proposal_id).toBeNull();
    // The records were read and paid for; losing what was found in them is the
    // one outcome worse than not extracting at all.
    expect(outcome.memory_packet_proposal_id).not.toBeNull();
    const packet = await db.pool.query<{ payload_json: { candidates: Array<{ text: string }> } }>(
      `SELECT payload_json FROM proposals WHERE id = $1`,
      [outcome.memory_packet_proposal_id!],
    );
    expect(packet.rows[0]!.payload_json.candidates.map((candidate) => candidate.text)).toContain("Use ACP");
  });

  it("does not let a concurrent extraction read the same records twice", async () => {
    await seedSession("space_shared", [record("m1", "material")]);
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    vi.spyOn(invocation, "completeProviderText").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await held;
      return { text: JSON.stringify(extraction()), provider: "test", model: "test" } as never;
    });

    const first = service().extract(identity, PROJECT);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The batch is claimed before the model is called, so the second caller
    // finds nothing rather than paying for the same records again.
    const second = await service().extract(identity, PROJECT);
    expect(second.records_covered).toBe(0);
    release!();
    expect((await first).records_covered).toBe(1);
    expect(calls).toBe(1);
  });

  it("puts a claimed batch back when the model call fails, so the records are not lost", async () => {
    await seedSession("space_shared", [record("m1", "material")]);
    vi.spyOn(invocation, "completeProviderText").mockRejectedValue(new Error("provider unavailable"));
    await expect(service().extract(identity, PROJECT)).rejects.toThrow(/provider unavailable/);
    // A batch marked read but never proposed would be invisible to every
    // future extraction, and on the automatic path invisible to the person.
    expect(await service().pending(identity, PROJECT)).toEqual({ records: 1, sessions: 1 });
  });

  it("turns an accepted packet into memory proposals that actually apply", async () => {
    await seedSession("space_shared", [record("m1", "this project uses pnpm, never npm")]);
    stubExtractor((ids) => ({
      ...extraction(),
      facts: [{
        id: randomUUID(),
        text: "This project uses pnpm, never npm",
        confirmation_state: "candidate",
        fact_status: "asserted",
        source_refs: [{ type: "imported_session_record", id: ids[0] }],
      }],
    }));
    const outcome = await service().extract(identity, PROJECT);
    expect(outcome.memory_packet_proposal_id).not.toBeNull();

    const packet = await db.pool.query<{
      id: string; space_id: string; payload_json: Record<string, unknown>;
      created_by_user_id: string | null; visibility: string; proposal_type: string;
    }>(`SELECT id, space_id, payload_json, created_by_user_id, visibility, proposal_type
          FROM proposals WHERE id = $1`, [outcome.memory_packet_proposal_id!]);

    const registry = new ProposalApplierRegistry();
    registerImportedHistoryProposalAppliers(registry);
    const result = await registry.apply({
      db: db.pool,
      proposal: packet.rows[0]! as never,
      userId: OWNER,
    } as never);
    expect(result.result_type).toBe("imported_history_memory_packet");

    const children = await db.pool.query<{ id: string; proposal_type: string; payload_json: Record<string, unknown> }>(
      `SELECT id, proposal_type, payload_json FROM proposals
        WHERE space_id = $1 AND proposal_type = 'memory_create'`,
      [SPACE],
    );
    expect(children.rows).toHaveLength(1);

    // The half the packet exists for: a child that cannot be applied would
    // make the whole memory path produce nothing, and the packet's own
    // acceptance would still look like a success.
    // In a transaction, because the apply path takes a savepoint around its
    // retrieval reindex — the same way the real accept route calls it.
    const applied = await withQueryableTransaction(db.pool, (tx) =>
      new PgMemoryApplyRepository(tx).applyOnly(
        {
          id: children.rows[0]!.id,
          space_id: SPACE,
          proposal_type: "memory_create",
          payload_json: children.rows[0]!.payload_json,
          created_by_user_id: OWNER,
          created_by_agent_id: null,
          created_by_run_id: null,
        } as never,
        OWNER,
      ));
    expect(applied.memoryId).toBeTruthy();
    const memory = await db.pool.query<{ scope_type: string; visibility: string; project_id: string | null }>(
      `SELECT scope_type, visibility, project_id FROM memory_entries WHERE id = $1`,
      [applied.memoryId],
    );
    expect(memory.rows[0]).toMatchObject({ scope_type: "project", visibility: "space_shared", project_id: PROJECT });
  });

  it("keeps an earlier extraction's constraints when a later one merges into the same proposal", async () => {
    await seedSession("space_shared", [record("m1", "first")]);
    stubExtractor((ids) => ({
      ...extraction(),
      constraints: [{ id: randomUUID(), text: "Never run against prod", confirmation_state: "candidate", source_refs: [{ type: "imported_session_record", id: ids[0] }] }],
    }));
    await service().extract(identity, PROJECT);

    await seedSession("space_shared", [record("m2", "second"), record("m3", "third")]);
    stubExtractor((ids) => ({
      ...extraction(),
      constraints: [{ id: randomUUID(), text: "Tests need real Postgres", confirmation_state: "candidate", source_refs: [{ type: "imported_session_record", id: ids[0] }] }],
    }));
    await service().extract(identity, PROJECT);

    // The merge builds on the waiting proposal, not on the active Brief: the
    // proposal has not been accepted, so the active Brief does not yet hold
    // the first extraction's constraint and computing from it would drop it.
    const proposals = await db.pool.query<{ payload_json: { constraints: string } }>(
      `SELECT payload_json FROM proposals WHERE space_id = $1 AND proposal_type = 'project_brief_publish'`,
      [SPACE],
    );
    expect(proposals.rows).toHaveLength(1);
    expect(proposals.rows[0]!.payload_json.constraints.split("\n")).toEqual([
      "Never run against prod",
      "Tests need real Postgres",
    ]);
  });

  it("keeps constraints too when there is no goal to define them under", async () => {
    await db.pool.query(`UPDATE projects SET active_brief_version_id = NULL WHERE id = $1`, [PROJECT]);
    await seedSession("space_shared", [record("m1", "material")]);
    stubExtractor((ids) => ({
      ...extraction(),
      constraints: [{ id: randomUUID(), text: "Never run against prod", confirmation_state: "candidate", source_refs: [{ type: "imported_session_record", id: ids[0] }] }],
    }));
    const outcome = await service().extract(identity, PROJECT);
    expect(outcome.brief_proposal_id).toBeNull();
    const packet = await db.pool.query<{ payload_json: { candidates: Array<{ text: string }> } }>(
      `SELECT payload_json FROM proposals WHERE id = $1`,
      [outcome.memory_packet_proposal_id!],
    );
    expect(packet.rows[0]!.payload_json.candidates.map((candidate) => candidate.text))
      .toContain("Never run against prod");
  });

  it("finalizes a claim once its proposals exist, and releases one that was abandoned", async () => {
    await seedSession("space_shared", [record("m1", "material")]);
    stubExtractor(() => extraction());
    await service().extract(identity, PROJECT);

    // A finalized read is a bare id. Left as `claim:…` it would be swept back
    // 30 minutes later and the whole batch read — and paid for — again.
    const finalized = await db.pool.query<{ extracted_in: string }>(
      `SELECT extracted_in FROM imported_session_records WHERE space_id = $1`,
      [SPACE],
    );
    expect(finalized.rows[0]!.extracted_in).not.toMatch(/^claim:/);

    // An extraction whose process died leaves a claim behind; the sweep is the
    // only way those records ever come back.
    await db.pool.query(
      `UPDATE imported_session_records
          SET extracted_in = 'claim:' || $1, extracted_at = now() - interval '2 hours'
        WHERE space_id = $2`,
      [randomUUID(), SPACE],
    );
    // Swept by the count itself, not only by an extraction: the count is what
    // decides whether the button that runs one is shown, so a stale claim that
    // survived it would hide the only path back.
    expect(await service().pending(identity, PROJECT)).toEqual({ records: 1, sessions: 1 });
    const swept = await db.pool.query<{ extracted_in: string | null }>(
      `SELECT extracted_in FROM imported_session_records WHERE space_id = $1`,
      [SPACE],
    );
    expect(swept.rows[0]!.extracted_in).toBeNull();
  });
});
