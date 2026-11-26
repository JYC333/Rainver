import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";
import { withQueryableTransaction } from "../src/modules/routeUtils/common.js";
import { migrate } from "../src/db/migrator.js";
import { PgAgentRepository } from "../src/modules/agents/repository.js";
import { PgProjectAgentRepository } from "../src/modules/projects/projectAgents.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { RoomRosterService } from "../src/modules/rooms/rosterService.js";
import { waitForBlockedBy } from "./support/lockWait.js";
import { PgRoomRosterRepository } from "../src/modules/rooms/rosterRepository.js";
import { contentDecisionFromDb } from "../src/modules/access/contentAccessQuery.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { RuntimeContextPolicyRepository } from "../src/modules/policy/runtimeContextPolicyRepository.js";
import { seedAgentWithVersion, seedMainlineRoomsForAllProjects, seedRun, seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { useTestDatabase } from "./support/testDatabase.js";

const db = useTestDatabase(import.meta.filename, { empty: true, max: 4 });

it("cuts over old Agents once without widening ACLs, transporting policy or moving history", async () => {
  if (!db.available) return;
  const actualMigrations = resolve(import.meta.dirname, "../migrations");
  const migrations = mkdtempSync(join(tmpdir(), "rainver-agent-stages-"));
  for (const file of readdirSync(actualMigrations)) {
    if (/^\d{4}_.*\.sql$/.test(file) && file < "0019") cpSync(join(actualMigrations, file), join(migrations, file));
  }
  const stages = readFileSync(join(actualMigrations, "0019_agent_workspace_and_conversation.sql"), "utf8").split(/\nRESET search_path;\s*(?:\n|$)/).filter(part => part.trim());
  expect(stages).toHaveLength(4);
  for (const [index, sql] of stages.entries()) writeFileSync(join(migrations, `${String(19 + index).padStart(4, '0')}_stage.sql`), sql);
  const prefix = mkdtempSync(join(tmpdir(), "rainver-agent-prefix-"));
  try {
    for (const file of readdirSync(migrations)) {
      if (/^\d{4}_.*\.sql$/.test(file) && file < "0020") cpSync(join(migrations, file), join(prefix, file));
    }
    await migrate(db.pool, prefix);
    const space = randomUUID(), owner = randomUUID(), reader = randomUUID(), projectA = randomUUID(), projectB = randomUUID();
    const agent = randomUUID(), version = randomUUID(), run = randomUUID(), removedAgent = randomUUID();
    await seedSpaceOwnerProject(db.pool, { space, owner, project: projectA, spaceType: "team" });
    await seedSpaceMember(db.pool, { space, user: reader });
    await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Second','active',now(),now())", [projectB, space, owner]);
    await seedMainlineRoomsForAllProjects(db.pool);
    await seedAgentWithVersion(db.pool, { space, owner, agent, version });
    await seedAgentWithVersion(db.pool, { space, owner, agent: removedAgent, version: randomUUID() });
    await db.pool.query("UPDATE agents SET project_id=$1,visibility='space_shared' WHERE id=ANY($2::varchar[])", [projectA, [agent, removedAgent]]);
    const links = new PgProjectAgentRepository(db.pool);
    await links.upsertActive({ spaceId: space, projectId: projectA, agentId: removedAgent, userId: owner });
    await db.pool.query("UPDATE project_agent_links SET status='removed',removed_at=now() WHERE agent_id=$1", [removedAgent]);
    const archived = randomUUID(), assistant = randomUUID(), unattributed = randomUUID(), projectC = randomUUID();
    for (const id of [archived, assistant, unattributed]) await seedAgentWithVersion(db.pool, {space, owner, agent: id, version: randomUUID()});
    await db.pool.query("UPDATE agents SET project_id=$2,status='archived' WHERE id=$1", [archived, projectA]);
    await db.pool.query("UPDATE agents SET project_id=$2,agent_kind='system_assistant',owner_user_id=NULL WHERE id=$1", [assistant, projectA]);
    await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Unowned','active',now(),now())", [projectC, space, owner]);
    await seedMainlineRoomsForAllProjects(db.pool);
    await db.pool.query("UPDATE projects SET owner_user_id=NULL WHERE id=$1", [projectC]);
    await db.pool.query("UPDATE agents SET project_id=$2,owner_user_id=NULL WHERE id=$1", [unattributed, projectC]);
    const session = randomUUID();
    await db.pool.query("INSERT INTO sessions(id,space_id,project_id,user_id,agent_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',now(),now())", [session, space, projectA, owner, agent]);
    await seedRun(db.pool, { id: run, space, owner, agent, version, existingAgent: true });
    await db.pool.query("UPDATE runs SET session_id=$2,project_id=$3 WHERE id=$1", [run, session, projectA]);
    const policies = new RuntimeContextPolicyRepository(db.pool);
    const identity = {spaceId: space, userId: owner};
    // Seed an old-schema policy; the new repository deliberately reads the new ACL column.
    const policyId = randomUUID();
    await db.pool.query("INSERT INTO runtime_context_policy_versions(id,space_id,scope_type,scope_id,version,policy_json,typed_diff_json,reason,created_by_user_id,created_at) VALUES($1,$2,'agent',$3,1,$4::jsonb,'{}','Original Project policy',$5,now())", [policyId, space, agent, JSON.stringify({constraints: {allow_project_brief: false}, preferences: {}}), owner]);
    await db.pool.query("INSERT INTO runtime_context_policy_bindings(space_id,scope_type,scope_id,active_version_id,updated_by_user_id,updated_at) VALUES($1,'agent',$2,$3,$4,now())", [space, agent, policyId, owner]);
    const profilesBefore = (await db.pool.query("SELECT * FROM agent_runtime_profiles WHERE agent_id=$1", [agent])).rows;
    const historyBefore = (await db.pool.query("SELECT * FROM runs WHERE id=$1", [run])).rows;
    const sessionBefore = (await db.pool.query("SELECT * FROM sessions WHERE id=$1", [session])).rows;
    expect((await migrate(db.pool, migrations)).applied).toEqual(readdirSync(migrations).filter(file => /^\d{4}_.*\.sql$/.test(file) && file >= "0020").sort().map(file => file.slice(0, 4)));
    expect((await migrate(db.pool, migrations)).applied).toEqual([]);
    expect((await db.pool.query("SELECT project_id,access_project_id,status FROM agents WHERE id=$1", [archived])).rows[0]).toEqual({project_id: null, access_project_id: projectA, status: 'archived'});
    expect((await db.pool.query("SELECT project_id,access_project_id FROM agents WHERE id=$1", [assistant])).rows[0]).toEqual({project_id: projectA, access_project_id: null});
    expect((await db.pool.query("SELECT project_id,access_project_id FROM agents WHERE id=$1", [unattributed])).rows[0]).toEqual({project_id: null, access_project_id: projectC});
    expect((await db.pool.query("SELECT id FROM project_agent_links WHERE agent_id=$1", [unattributed])).rows).toEqual([]);
    expect((await db.pool.query("SELECT project_id,access_project_id,current_version_id FROM agents WHERE id=$1", [agent])).rows[0]).toEqual({project_id: null, access_project_id: projectA, current_version_id: version});
    expect((await db.pool.query("SELECT status FROM project_agent_links WHERE project_id=$1 AND agent_id=$2", [projectA, agent])).rows).toEqual([{status: "active"}]);
    expect((await db.pool.query("SELECT status FROM project_agent_links WHERE agent_id=$1", [removedAgent])).rows).toEqual([{status: "removed"}]);
    expect((await db.pool.query("SELECT * FROM agent_runtime_profiles WHERE agent_id=$1", [agent])).rows).toEqual(profilesBefore);
    expect((await db.pool.query("SELECT * FROM runs WHERE id=$1", [run])).rows).toEqual(historyBefore);
    expect((await db.pool.query("SELECT * FROM sessions WHERE id=$1", [session])).rows).toEqual(sessionBefore);
    // The cutover is verified at its own stage; the current repositories below need the head schema,
    // so the real migrations after 0019 follow the stages.
    const later = readdirSync(actualMigrations).filter(file => /^\d{4}_.*\.sql$/.test(file) && file >= "0020").sort();
    for (const [index, file] of later.entries()) cpSync(join(actualMigrations, file), join(migrations, `${String(19 + stages.length + index).padStart(4, "0")}_${file.slice(5)}`));
    expect((await migrate(db.pool, migrations)).applied).toHaveLength(later.length);
    expect((await db.pool.query("SELECT project_id,access_project_id FROM agents WHERE id=$1", [agent])).rows[0]).toEqual({project_id: null, access_project_id: projectA});
    // Same Agent can be referenced in B by someone entitled to A. B-only readers gain nothing.
    expect(await links.linkableAgent({spaceId: space, userId: owner, projectId: projectB, agentId: agent})).toEqual({id: agent});
    await links.upsertActive({spaceId: space, projectId: projectB, agentId: agent, userId: owner});
    const roomB = (await db.pool.query("SELECT id FROM rooms WHERE project_id=$1 AND is_mainline", [projectB])).rows[0].id;
    expect((await new PgRoomRosterRepository(db.pool).listAgentCandidates({space_id: space, user_id: owner, room_id: roomB, limit: 20, offset: 0})).items.map(a => a.agent_id)).toContain(agent);
    await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())", [randomUUID(), space, projectB, reader]);
    expect(await contentDecisionFromDb(db.pool, {spaceId: space, userId: reader}, "agent", agent)).toBe("deny");
    expect(await links.linkableAgent({spaceId: space, userId: reader, projectId: projectB, agentId: agent})).toBeNull();
    await db.pool.query("INSERT INTO room_user_members(id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'owner','active',now(),now()) ON CONFLICT(room_id,user_id) DO UPDATE SET status='active'", [randomUUID(), space, roomB, owner]);
    await new RoomRosterService(db.pool).addExistingAgent(identity, roomB, {agent_id: agent, confirm_room_share: true, share_private_with_member_ids: []});
    expect((await db.pool.query("SELECT id FROM room_agent_members WHERE room_id=$1 AND agent_id=$2", [roomB, agent])).rows).toHaveLength(1);
    // Project A policy remains on legacy direct executions, but never follows the Agent into B.
    const projectPolicyId = randomUUID();
    await db.pool.query("INSERT INTO runtime_context_policy_versions(id,space_id,scope_type,scope_id,version,policy_json,typed_diff_json,reason,created_by_user_id,created_at) VALUES($1,$2,'project',$3,1,$4::jsonb,'{}','Project A only',$5,now())", [projectPolicyId, space, projectA, JSON.stringify({constraints: {retrieval_max_candidates: 3}, preferences: {}}), owner]);
    await db.pool.query("INSERT INTO runtime_context_policy_bindings(space_id,scope_type,scope_id,active_version_id,updated_by_user_id,updated_at) VALUES($1,'project',$2,$3,$4,now())", [space, projectA, projectPolicyId, owner]);
    const policyA = await policies.resolveForExecution({spaceId: space, projectId: projectA, agentId: agent, userId: owner});
    const policyB = await policies.resolveForExecution({spaceId: space, projectId: projectB, agentId: agent, userId: owner});
    expect(policyA.policy.constraints.allow_project_brief).toBe(false);
    expect(policyB.policy.constraints.allow_project_brief).toBe(false);
    const direct = await policies.resolveForExecution({spaceId: space, agentId: agent, userId: owner});
    expect(direct.policy.constraints.allow_project_brief).toBe(false);
    expect((await policies.resolve(identity, {agent_id: agent, include_user_policy: false})).policy).toEqual(direct.policy);
    expect(direct.policy.constraints.retrieval_max_candidates).toBe(3);
    expect(policyB.policy.constraints.retrieval_max_candidates).toBeUndefined();
    expect((await policies.resolve(identity, {project_id: projectB, agent_id: agent, include_user_policy: false})).policy).toEqual(policyB.policy);
    expect((await policies.getActive(identity, "agent", agent))?.id).toBe(policyId);
    // Dispatch/reattempt sees current access to the Agent's original Project as well as Run B.
    await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())", [randomUUID(), space, projectA, reader]);
    const authorization = {space_id: space, instructed_by_user_id: reader, project_id: projectB, project_folder_id: null, run_group_id: null, agent_id: agent, session_id: session};
    const runs = new PgRunRepository(db.pool);
    expect(await runs.checkRunExecutionAuthorization(authorization)).toEqual({allowed: true});
    const holder = await db.pool.connect();
    let revoke: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await new PgTaskRepository(db.pool).createTask({spaceId: space, userId: reader}, {project_id: projectB, title: "Assignment holds original ACL", assigned_agent_id: agent}, holder);
      let settled = false;
      revoke = db.pool.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2", [projectA, reader]).finally(() => { settled = true; });
      await waitForBlockedBy(db.pool, pid, {settled: () => settled});
      expect(settled).toBe(false);
      await holder.query("COMMIT");
      await revoke;
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await revoke;
    }
    await expect(new PgTaskRepository(db.pool).createTask({spaceId: space, userId: reader}, {project_id: projectB, title: "Refused after revocation", assigned_agent_id: agent})).rejects.toMatchObject({statusCode: 404});
    expect(await runs.checkRunExecutionAuthorization(authorization)).toMatchObject({allowed: false, error_code: "run_execution_authorization_revoked"});
    // All future standard Agents use this same model and establish their Project reference atomically.
    const created = await withQueryableTransaction(db.pool, tx => new PgAgentRepository(db.pool).createInTransaction(tx, {spaceId: space, userId: owner, projectId: projectA, name: "New reusable Agent"}));
    expect((await db.pool.query("SELECT project_id,access_project_id FROM agents WHERE id=$1", [created.id])).rows[0]).toEqual({project_id: null, access_project_id: projectA});
    expect(await links.projectUsesAgent({spaceId: space, projectId: projectA, agentId: created.id})).toBe(true);
  } finally {
    rmSync(prefix, {recursive: true, force: true});
    rmSync(migrations, {recursive: true, force: true});
  }
});
