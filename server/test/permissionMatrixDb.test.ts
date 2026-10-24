import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { SystemActionId } from "@rainver/protocol";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { canConfigureAssistant } from "../src/modules/agents/agentAccess.js";
import { PgAgentRepository } from "../src/modules/agents/repository.js";
import { resolveContentCreationContext } from "../src/modules/access/creationContext.js";
import { PgActivityRepository } from "../src/modules/activity/repository.js";
import { PgSkillsRepository } from "../src/modules/skills/repository.js";
import { registerSkillProposalAppliers } from "../src/modules/skills/proposalApplier.js";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import { PgProposalApplyService } from "../src/modules/proposals/applyService.js";
import { registerProposalDecisionExecutor } from "../src/modules/proposals/proposalDecisionExecutor.js";
import { insertProposalRow } from "../src/modules/proposals/reviewPackets.js";
import type { RunRecord } from "../src/modules/runs/repository.js";
import type { SystemActionExecutor } from "../src/modules/systemActions/gateway.js";
import { seedAgentWithVersion, seedMainlineRoomsForAllProjects, seedRun } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { PgMemoryApplyRepository } from "../src/modules/memory/memoryApplyRepository.js";
import { normalizeVersionScopeForWrite } from "../src/modules/evolution/assetAccess.js";
import { insertMemoryEntry } from "./support/memoryFixtures.js";

// The P03 authority matrix, against real Postgres: who configures which
// Assistant, who may create content in a Project, who turns a capture into
// Memory, who sets which Skill overlay, which scope a capability approval may
// land in, who decides an Agent's own Memory, and which proposals a
// conversation may list or decide.
//
// The people: CREATOR made the shared Space and owns it; OTHER_ADMIN is
// another admin of it; PROJECT_OWNER owns PROJECT; READER is a viewer of
// PROJECT; OUTSIDER is a plain member who reads nothing of PROJECT.

const SPACE = "a3a3a3a3-0000-4000-8000-000000000001";
const PERSONAL = "a3a3a3a3-0000-4000-8000-000000000002";
const OTHER_SPACE = "a3a3a3a3-0000-4000-8000-000000000003";
const CREATOR = "a3a3a3a3-0000-4000-8000-0000000000a1";
const OTHER_ADMIN = "a3a3a3a3-0000-4000-8000-0000000000a2";
const PROJECT_OWNER = "a3a3a3a3-0000-4000-8000-0000000000a3";
const READER = "a3a3a3a3-0000-4000-8000-0000000000a4";
const OUTSIDER = "a3a3a3a3-0000-4000-8000-0000000000a5";
const PROJECT = "a3a3a3a3-0000-4000-8000-0000000000b1";
const PERSONAL_PROJECT = "a3a3a3a3-0000-4000-8000-0000000000b2";
const OTHER_SPACE_PROJECT = "a3a3a3a3-0000-4000-8000-0000000000b3";
const AGENT = "a3a3a3a3-0000-4000-8000-0000000000c1";
const AGENT_VERSION = "a3a3a3a3-0000-4000-8000-0000000000c2";
const SPACE_ASSISTANT = "a3a3a3a3-0000-4000-8000-0000000000c3";
const PROJECT_ASSISTANT = "a3a3a3a3-0000-4000-8000-0000000000c4";

const db = useTestDatabase(import.meta.filename);
let config: ServerConfig;

function as(userId: string, spaceId = SPACE) {
  return { spaceId, userId };
}

beforeEach(async () => {
  if (!db.available) return;
  config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
  await resetTables(db.pool, [
    "settings", "skill_local_overlays", "skill_packages", "skill_sources", "proposals", "activity_records", "memory_entries",
    "sessions", "runs", "agent_runtime_profiles", "agent_versions", "agents", "project_members", "projects",
    "space_memberships", "users", "spaces",
  ], { cascade: true });
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     SELECT id, id, 'active', $2, $2, lower(gen_random_uuid()::text || '@test.invalid'), 'system' FROM unnest($1::text[]) AS id`,
    [[CREATOR, OTHER_ADMIN, PROJECT_OWNER, READER, OUTSIDER], now],
  );
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at) VALUES
       ($1, 'Team', 'household', $2, $5, $5),
       ($3, 'Personal', 'personal', $4, $5, $5),
       ($6, 'Elsewhere', 'household', $2, $5, $5)`,
    [SPACE, CREATOR, PERSONAL, PROJECT_OWNER, now, OTHER_SPACE],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     SELECT gen_random_uuid()::varchar, s, u, r, 'active', $1, $1
       FROM (VALUES ($2::text, $3::text, 'owner'), ($2, $4, 'admin'), ($2, $5, 'member'), ($2, $6, 'member'),
                    ($2, $7, 'member'), ($8, $5, 'owner')) AS m(s, u, r)`,
    [now, SPACE, CREATOR, OTHER_ADMIN, PROJECT_OWNER, READER, OUTSIDER, PERSONAL],
  );
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES
       ($1, $2, $3, 'Shared work', 'active', $4, $4),
       ($5, $6, $3, 'Own work', 'active', $4, $4),
       ($7, $8, $9, 'Elsewhere', 'active', $4, $4)`,
    [PROJECT, SPACE, PROJECT_OWNER, now, PERSONAL_PROJECT, PERSONAL, OTHER_SPACE_PROJECT, OTHER_SPACE, CREATOR],
  );
  await db.pool.query(
    `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, $3, 'viewer', 'active', $4, $4)`,
    [SPACE, PROJECT, READER, now],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: AGENT_VERSION, space: SPACE, owner: READER, name: "Reader's Agent", now });
  await db.pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, project_id, name, status, agent_kind, visibility, created_at, updated_at) VALUES
       ($1, $2, NULL, NULL, 'Space Assistant', 'active', 'system_assistant', 'space_shared', $4, $4),
       ($3, $2, NULL, $5, 'Shared work Assistant', 'active', 'system_assistant', 'space_shared', $4, $4)`,
    [SPACE_ASSISTANT, SPACE, PROJECT_ASSISTANT, now, PROJECT],
  );
});

describe("P03 authority matrix (real Postgres)", () => {
  it("lets each Assistant be configured only by its own person", async () => {
    if (!db.available) return;
    const space = { projectId: null };
    const project = { projectId: PROJECT };
    // Shared Space: the creator, by identity, not another owner/admin by role.
    expect(await canConfigureAssistant(db.pool, as(CREATOR), space)).toBe(true);
    expect(await canConfigureAssistant(db.pool, as(OTHER_ADMIN), space)).toBe(false);
    expect(await canConfigureAssistant(db.pool, as(PROJECT_OWNER), space)).toBe(false);
    // A Project's Assistant: the Project owner, not the Space's creator or admin.
    expect(await canConfigureAssistant(db.pool, as(PROJECT_OWNER), project)).toBe(true);
    expect(await canConfigureAssistant(db.pool, as(CREATOR), project)).toBe(false);
    expect(await canConfigureAssistant(db.pool, as(OTHER_ADMIN), project)).toBe(false);
    expect(await canConfigureAssistant(db.pool, as(READER), project)).toBe(false);
    // A personal Space's Assistant: its person.
    expect(await canConfigureAssistant(db.pool, as(PROJECT_OWNER, PERSONAL), space)).toBe(true);
    expect(await canConfigureAssistant(db.pool, as(CREATOR, PERSONAL), space)).toBe(false);

    const repository = new PgAgentRepository(db.pool);
    // The Space's and the Project's Assistant keep separate settings.
    const spaceSettings = await repository.getAssistantSettings({ spaceId: SPACE, projectId: null });
    const projectSettings = await repository.getAssistantSettings({ spaceId: SPACE, projectId: PROJECT });
    expect(spaceSettings).toMatchObject({ scope: "space", project_id: null, assistant_agent_id: SPACE_ASSISTANT });
    expect(projectSettings).toMatchObject({ scope: "project", project_id: PROJECT, assistant_agent_id: PROJECT_ASSISTANT });
    await repository.updateAssistantSettings({ spaceId: SPACE, projectId: PROJECT }, { verbosity: "concise" }, { actorUserId: PROJECT_OWNER });
    expect((await repository.getAssistantSettings({ spaceId: SPACE, projectId: null })).verbosity).toBeNull();
    // A Project the reader cannot read is absent to them.
    await expect(repository.assertAssistantSettingsReadable(as(OUTSIDER), { spaceId: SPACE, projectId: PROJECT }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.assertAssistantSettingsReadable(as(READER), { spaceId: SPACE, projectId: PROJECT }))
      .resolves.toBeUndefined();
  });

  it("lets only an Assistant's configurer change where it runs, and only an Agent's configurer change what it resolves", async () => {
    if (!db.available) return;
    const agents = new PgAgentRepository(db.pool);
    // A Project Assistant's runtime profiles: its Project owner, not the Space owner or a Project reader.
    expect(await agents.canWriteRuntimeProfiles(SPACE, PROJECT_OWNER, PROJECT_ASSISTANT)).toBe(true);
    expect(await agents.canWriteRuntimeProfiles(SPACE, CREATOR, PROJECT_ASSISTANT)).toBe(false);
    expect(await agents.canWriteRuntimeProfiles(SPACE, READER, PROJECT_ASSISTANT)).toBe(false);
    // The Space Assistant's: the Space creator, not another admin.
    expect(await agents.canWriteRuntimeProfiles(SPACE, CREATOR, SPACE_ASSISTANT)).toBe(true);
    expect(await agents.canWriteRuntimeProfiles(SPACE, OTHER_ADMIN, SPACE_ASSISTANT)).toBe(false);
    // The Space Assistant's profiles are read by its configurer, not by any admin.
    expect(await agents.canReadRuntimeProfiles(SPACE, CREATOR, SPACE_ASSISTANT)).toBe(true);
    expect(await agents.canReadRuntimeProfiles(SPACE, OTHER_ADMIN, SPACE_ASSISTANT)).toBe(false);
    // Agent-scope asset versions are what that Agent resolves at run time.
    await expect(normalizeVersionScopeForWrite(db.pool, as(READER), "agent", AGENT)).resolves.toBe(AGENT);
    await expect(normalizeVersionScopeForWrite(db.pool, as(OTHER_ADMIN), "agent", AGENT)).rejects.toMatchObject({ statusCode: 403 });
    await expect(normalizeVersionScopeForWrite(db.pool, as(PROJECT_OWNER), "agent", PROJECT_ASSISTANT)).resolves.toBe(PROJECT_ASSISTANT);
    await expect(normalizeVersionScopeForWrite(db.pool, as(CREATOR), "agent", PROJECT_ASSISTANT)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses a default Project the configurer cannot read, from another Space, or other than a Project Assistant's own", async () => {
    if (!db.available) return;
    const repository = new PgAgentRepository(db.pool);
    const spaceTarget = { spaceId: SPACE, projectId: null };
    // The creator is not a reader of the shared Project.
    await expect(repository.updateAssistantSettings(spaceTarget, { default_project_id: PROJECT }, { actorUserId: CREATOR }))
      .rejects.toMatchObject({ statusCode: 422 });
    await expect(repository.updateAssistantSettings(spaceTarget, { default_project_id: OTHER_SPACE_PROJECT }, { actorUserId: CREATOR }))
      .rejects.toMatchObject({ statusCode: 422 });
    await expect(repository.updateAssistantSettings({ spaceId: SPACE, projectId: PROJECT }, { default_project_id: PERSONAL_PROJECT }, { actorUserId: PROJECT_OWNER }))
      .rejects.toMatchObject({ statusCode: 422 });
    const own = await repository.updateAssistantSettings({ spaceId: SPACE, projectId: PROJECT }, { default_project_id: PROJECT }, { actorUserId: PROJECT_OWNER });
    expect(own.default_project_id).toBe(PROJECT);
  });

  it("creates content in a Project only for someone who reads and writes it", async () => {
    if (!db.available) return;
    const create = (userId: string) => resolveContentCreationContext(db.pool, { userId, requestSpaceId: SPACE, projectId: PROJECT });
    await expect(create(PROJECT_OWNER)).resolves.toMatchObject({ projectId: PROJECT, visibility: "space_shared" });
    // A reader who cannot write.
    await expect(create(READER)).rejects.toMatchObject({ statusCode: 403 });
    // A Space admin who writes by role but does not read the Project: absent.
    await expect(create(OTHER_ADMIN)).rejects.toMatchObject({ statusCode: 404 });
    await expect(create(OUTSIDER)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lets only a capture's owner consolidate it into Memory", async () => {
    if (!db.available) return;
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO activity_records (id, space_id, user_id, owner_user_id, activity_type, title, content,
         payload_json, status, visibility, occurred_at, created_at, updated_at)
       VALUES ($1, $2, $3, $3, 'user_capture', 'Shared thought', 'A shared capture worth keeping.', '{}'::jsonb,
               'raw', 'space_shared', now(), now(), now())`,
      [id, SPACE, CREATOR],
    );
    const activity = new PgActivityRepository(db.pool);
    await expect(activity.consolidate(as(OUTSIDER), id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(activity.consolidate(as(OTHER_ADMIN), id)).rejects.toMatchObject({ statusCode: 403 });
    expect(await activity.consolidate(as(CREATOR), id)).toHaveLength(1);
  });

  it("sets each Skill overlay only under the authority of the scope it configures", async () => {
    if (!db.available) return;
    const sourceId = randomUUID();
    const packageId = randomUUID();
    await db.pool.query(
      `INSERT INTO skill_sources (id, space_id, source_type, content_hash, fetched_at, metadata_json, created_at)
       VALUES ($1, $2, 'github', 'hash', now(), '{}'::jsonb, now())`,
      [sourceId, SPACE],
    );
    await db.pool.query(
      `INSERT INTO skill_packages (id, space_id, source_id, package_name, manifest_json, normalized_json, risk_level, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'pkg', '{}'::jsonb, '{}'::jsonb, 'low', 'reviewed', now(), now())`,
      [packageId, SPACE, sourceId],
    );
    const repo = new PgSkillsRepository(db.pool);
    const put = (userId: string, scope_type: "space" | "project" | "agent", scope_id: string | null) =>
      repo.upsertSkillLocalOverlay(as(userId), packageId, { scope_type, scope_id, status: "active", overlay_json: { alias: "x", endpoint_defaults: {}, user_preferences: {} } });
    // Space overlay: a Space owner or admin.
    await expect(put(OUTSIDER, "space", null)).rejects.toMatchObject({ statusCode: 403 });
    await expect(put(OTHER_ADMIN, "space", null)).resolves.toMatchObject({ scope_type: "space" });
    // Project overlay: a Project writer; a reader may not; a non-reader is told nothing.
    await expect(put(READER, "project", PROJECT)).rejects.toMatchObject({ statusCode: 403 });
    await expect(put(OUTSIDER, "project", PROJECT)).rejects.toMatchObject({ statusCode: 404 });
    await expect(put(OTHER_ADMIN, "project", PROJECT)).rejects.toMatchObject({ statusCode: 404 });
    await expect(put(PROJECT_OWNER, "project", PROJECT)).resolves.toMatchObject({ scope_type: "project" });
    // An ordinary Agent: its manager. A managed Assistant: its configurer, so
    // the Space admin's general overlay authority does not reach it.
    await expect(put(CREATOR, "agent", AGENT)).rejects.toMatchObject({ statusCode: 403 });
    await expect(put(READER, "agent", AGENT)).resolves.toMatchObject({ scope_type: "agent" });
    await expect(put(OTHER_ADMIN, "agent", SPACE_ASSISTANT)).rejects.toMatchObject({ statusCode: 403 });
    await expect(put(CREATOR, "agent", SPACE_ASSISTANT)).resolves.toMatchObject({ scope_type: "agent" });
    await expect(put(PROJECT_OWNER, "agent", PROJECT_ASSISTANT)).resolves.toMatchObject({ scope_type: "agent" });
    await expect(put(CREATOR, "agent", PROJECT_ASSISTANT)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses a Skill review filed under Project approval authority", async () => {
    const registry = new ProposalApplierRegistry();
    registerSkillProposalAppliers(registry);
    const unreachable = { query: async () => { throw new Error("must refuse before touching the database"); } };
    await expect(registry.get("skill_import_approve")!({
      config: loadConfig({ SERVER_DATABASE_URL: "postgresql://unused@db:5432/unused" }),
      db: unreachable as never, userId: PROJECT_OWNER,
      proposal: { id: randomUUID(), space_id: SPACE, proposal_type: "skill_import_approve", project_id: PROJECT,
        payload_json: { operation: "skill_import_approve", skill_package_id: "p" } } as never,
    })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("decides an Agent's own Memory by the Agent's owner, whatever the payload claims", async () => {
    if (!db.available) return;
    const service = new PgProposalApplyService(config);
    const agentMemoryProposal = async (payload: Record<string, unknown>) => (await insertProposalRow(db.pool, {
      spaceId: SPACE,
      proposalType: "memory_create",
      title: "What the Agent has become",
      payload: { operation: "create", target_scope: "agent", agent_id: AGENT, proposed_content: "x", ...payload },
      rationale: "",
      createdByUserId: CREATOR,
      ownerUserId: CREATOR,
      visibility: "space_shared",
      requiredApproverRole: "owner",
    })).id;
    // A forged decider: the Space owner names themselves.
    const forged = await agentMemoryProposal({ required_owner_user_id: CREATOR });
    expect(await service.reject(forged, as(CREATOR))).toBeNull();
    // Omitted: still the Agent's owner, not anyone by role.
    const omitted = await agentMemoryProposal({});
    expect(await service.reject(omitted, as(CREATOR))).toBeNull();
    expect(await service.reject(omitted, as(OTHER_ADMIN))).toBeNull();
    // The Agent's owner decides both.
    expect(await service.reject(forged, as(READER))).toMatchObject({ status: "rejected" });
    expect(await service.reject(omitted, as(READER))).toMatchObject({ status: "rejected" });
  });

  it("decides a revision or archive of an Agent's memory by the stored entry, not by the payload's scope", async () => {
    if (!db.available) return;
    const service = new PgProposalApplyService(config);
    const personaId = randomUUID();
    await insertMemoryEntry(db.pool, SPACE, {
      id: personaId, scope_type: "agent", agent_id: AGENT, owner_user_id: READER,
      memory_type: "persona", root_memory_id: personaId,
    });
    const about = async (proposalType: string, payload: Record<string, unknown>) => (await insertProposalRow(db.pool, {
      spaceId: SPACE,
      proposalType,
      title: "Change what the Agent has become",
      // No `target_scope`: the stored entry is what this proposal is about.
      payload: { target_memory_id: personaId, ...payload },
      rationale: "",
      createdByUserId: CREATOR,
      ownerUserId: CREATOR,
      visibility: "space_shared",
      requiredApproverRole: "owner",
    })).id;
    for (const proposalId of [
      await about("memory_update", { operation: "update", proposed_content: "changed" }),
      await about("memory_archive", { operation: "archive" }),
      // A claim that it is someone's personal memory changes nothing either.
      await about("memory_update", { operation: "update", target_scope: "user", proposed_content: "changed" }),
    ]) {
      expect(await service.reject(proposalId, as(CREATOR))).toBeNull();
      expect(await service.reject(proposalId, as(OTHER_ADMIN))).toBeNull();
      expect(await service.reject(proposalId, as(READER))).toMatchObject({ status: "rejected" });
    }
    // Even its owner cannot move it out of the Agent's scope.
    const crossing = await about("memory_update", { operation: "update", target_scope: "user", proposed_content: "now mine" });
    await expect(new PgMemoryApplyRepository(db.pool).applyUpdate(
      (await db.pool.query(`SELECT * FROM proposals WHERE id = $1`, [crossing])).rows[0],
      READER,
    )).rejects.toThrow(/into or out of an Agent/);
  });

  it("lists and decides only the conversation's proposals its person may read", async () => {
    if (!db.available) return;
    const runId = randomUUID();
    const sessionId = randomUUID();
    await seedRun(db.pool, { id: runId, space: SPACE, owner: OUTSIDER, agent: randomUUID(), version: randomUUID() });
    await db.pool.query(
      `INSERT INTO sessions (id, space_id, user_id, status, created_at, updated_at) VALUES ($1, $2, $3, 'active', now(), now())`,
      [sessionId, SPACE, OUTSIDER],
    );
    await db.pool.query(`UPDATE runs SET session_id = $2, instructed_by_user_id = $3 WHERE id = $1`, [runId, sessionId, OUTSIDER]);
    const proposal = async (visibility: string, ownerUserId: string) => (await insertProposalRow(db.pool, {
      spaceId: SPACE,
      proposalType: "memory_create",
      title: `${visibility} proposal`,
      payload: { operation: "create", target_scope: "user", proposed_content: "x" },
      rationale: "",
      createdByUserId: ownerUserId,
      ownerUserId,
      visibility,
      createdByRunId: runId,
    })).id;
    const shared = await proposal("space_shared", OUTSIDER);
    const othersPrivate = await proposal("private", CREATOR);
    const executors = new Map<SystemActionId, SystemActionExecutor>();
    const run = { id: runId, space_id: SPACE, session_id: sessionId, instructed_by_user_id: OUTSIDER } as unknown as RunRecord;
    registerProposalDecisionExecutor(executors, config, run);
    const listed = await executors.get("proposal.list_pending" as SystemActionId)!({}, {} as never) as {
      modelResult: { proposals: Array<{ proposal_id: string }> };
    };
    expect(listed.modelResult.proposals.map((item) => item.proposal_id)).toEqual([shared]);
    await expect(executors.get("proposal.decide" as SystemActionId)!({ proposal_id: othersPrivate, decision: "reject" }, {} as never))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(await db.pool.query(`SELECT status FROM proposals WHERE id = $1`, [othersPrivate]))
      .toMatchObject({ rows: [{ status: "pending" }] });
  });
});
