import { SkillPackageSchema } from "@rainver/protocol";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { approveSkillImportInTransaction, PgCapabilitiesRepository } from "../src/modules/capabilities/repository.js";
import type { Pool } from "../src/db/pool.js";
import { waitForLockWaiter } from "./support/lockWait.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { previewSkillFiles } from "../src/modules/capabilities/skillImporter.js";
import { loadSkillPackageContent } from "../src/modules/capabilities/skillPackageContent.js";
import { resolveSkillBindings, applySkillPackageBinding } from "../src/modules/capabilities/skillBindings.js";
import { loadSelectedSkills, assertSelectedSkillBindings, assertSelectedSkillsForRecipients } from "../src/modules/capabilities/selectedSkills.js";
import { ConversationInputService, loadConversationSkillDescriptors, renderConversationInputMessage } from "../src/modules/sessions/conversationInputService.js";
import { loadConfig } from "../src/config.js";
import { withTransaction } from "../src/db/tx.js";
import type { ApplyProposal } from "../src/modules/memory/memoryApplyRepository.js";
import { ProposalApplierRegistry } from "../src/modules/proposals/applierRegistry.js";
import { registerCapabilityProposalAppliers } from "../src/modules/capabilities/proposalApplier.js";
import { insertProposalRow } from "../src/modules/proposals/reviewPackets.js";
import { PgProposalApplyService } from "../src/modules/proposals/applyService.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const db = useTestDatabase(import.meta.filename);

async function importOriginalSkill() {
  const markdown = Buffer.from("\ufeff---\r\nname: original\r\ndescription: Use original bytes.\r\n---\r\nRead references/a.txt.\r\n");
  const preview = previewSkillFiles({ files: [
    { path: "skill/SKILL.md", content_base64: markdown.toString("base64") },
    { path: "skill/references/a.txt", content_base64: Buffer.from("reference").toString("base64") },
    { path: "skill/assets/image.bin", content_base64: Buffer.from([0, 255, 128]).toString("base64") },
  ] });
  const repo = new PgCapabilitiesRepository(db.pool);
  const pkg = SkillPackageSchema.parse(await repo.saveImportedSkill({ spaceId: SPACE, userId: USER }, preview));
  return { repo, pkg, preview, markdown };
}

async function applyBindingProposal(id: string) {
  return withTransaction(db.pool, async client => {
    const proposal = (await client.query<ApplyProposal>("SELECT * FROM proposals WHERE id=$1", [id])).rows[0]!;
    const result = await applySkillPackageBinding({ db: client, proposal, userId: USER, config: loadConfig({ SERVER_DATABASE_URL: db.connectionUri }) });
    await client.query("UPDATE proposals SET status='accepted' WHERE id=$1", [id]);
    return result;
  });
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["proposals", "skill_local_overlays", "skill_packages", "skill_sources", "space_memberships", "users", "spaces"], { cascade: true });
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Main', 'personal', now(), now())`, [SPACE]);
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES ($1, 'Owner', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [USER],
  );
  // A Space overlay is its owner's or admin's to set; the person here owns
  // the personal Space they save into.
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, 'owner', 'active', now(), now())`,
    [SPACE, USER],
  );
});

describe("skill import approval (real Postgres)", () => {
  it("round-trips complete original bytes and refuses missing, altered or cross-Space content", async () => {
    if (!db.available) return;
    const { repo, pkg, preview, markdown } = await importOriginalSkill();
    const stored = await repo.getSkillPackageContent({ spaceId: SPACE, userId: USER }, pkg.id);
    expect(Buffer.from(stored.files.find(file => file.path === "SKILL.md")!.content_base64, "base64")).toEqual(markdown);
    expect(stored.package_hash).toBe(preview.package_hash);
    expect(stored.files.find(file => file.path === "assets/image.bin")?.content_base64).toBe("AP+A");
    await expect(loadSkillPackageContent(db.pool, SPACE, pkg.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(loadSkillPackageContent(db.pool, randomUUID(), pkg.id, false)).rejects.toMatchObject({ statusCode: 404 });
    await db.pool.query("UPDATE skill_package_files SET content_base64='YQ==' WHERE skill_package_id=$1 AND kind='asset'", [pkg.id]);
    await expect(repo.getSkillPackageContent({ spaceId: SPACE, userId: USER }, pkg.id)).rejects.toThrow(/integrity/);
    await db.pool.query("UPDATE skill_package_files SET content_base64=NULL WHERE skill_package_id=$1", [pkg.id]);
    await expect(repo.getSkillPackageContent({ spaceId: SPACE, userId: USER }, pkg.id)).rejects.toThrow(/import it again/);
  });

  it("pins reviewed packages, deduplicates binding proposals and honors narrower disablement", async () => {
    if (!db.available) return;
    const { repo, pkg, preview } = await importOriginalSkill();
    const identity = { spaceId: SPACE, userId: USER };
    await expect(repo.createSkillBindingProposal(identity, pkg.id, { scope_type: "space", enabled: true })).rejects.toThrow(/reviewed/);
    await approveSkillImportInTransaction({ db: db.pool, spaceId: SPACE, userId: USER, proposalId: randomUUID(), skillPackageId: pkg.id });
    const proposals = await Promise.all([1, 2].map(() => repo.createSkillBindingProposal(identity, pkg.id, { scope_type: "space", enabled: true })));
    expect(proposals[0]!.id).toBe(proposals[1]!.id);
    await applyBindingProposal(proposals[0]!.id);
    const scope = { space_id: SPACE, project_id: null, agent_id: null, user_id: USER };
    expect(await resolveSkillBindings(db.pool, scope)).toHaveLength(1);
    const reference = { kind: "skill" as const, skill_package_id: pkg.id, package_hash: preview.package_hash, display_name: "original" };
    await expect(assertSelectedSkillBindings(db.pool, scope, [reference])).resolves.toBeUndefined();
    const changedReference = { ...reference, package_hash: "a".repeat(64) };
    await expect(assertSelectedSkillBindings(db.pool, scope, [changedReference])).rejects.toMatchObject({ statusCode: 409 });
    const disabled = await repo.createSkillBindingProposal(identity, pkg.id, { scope_type: "user", scope_id: USER, enabled: false });
    await applyBindingProposal(disabled.id);
    expect(await resolveSkillBindings(db.pool, scope)).toEqual([]);
    expect(await resolveSkillBindings(db.pool, { ...scope, user_id: null })).toHaveLength(1);
    await expect(assertSelectedSkillBindings(db.pool, scope, [reference])).rejects.toMatchObject({ statusCode: 422 });
  });

  it("reviews and enables an imported package with one approval", async () => {
    if (!db.available) return;
    const { repo, pkg } = await importOriginalSkill();
    const identity = { spaceId: SPACE, userId: USER };
    await expect(repo.createSkillImportApprovalProposal({ identity, skillPackageId: pkg.id,
      binding: { scope_type: "user", scope_id: randomUUID(), enabled: true } })).rejects.toMatchObject({ statusCode: 403 });
    const { proposal } = await repo.createSkillImportApprovalProposal({ identity, skillPackageId: pkg.id,
      binding: { scope_type: "space", enabled: true } });
    const registry = new ProposalApplierRegistry();
    registerCapabilityProposalAppliers(registry);
    const result = await withTransaction(db.pool, async client => registry.apply({
      db: client, userId: USER, config: loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      proposal: (await client.query<ApplyProposal>("SELECT * FROM proposals WHERE id=$1", [proposal.id])).rows[0]!,
    }));
    expect(result.result).toMatchObject({ skill_package: { status: "reviewed" }, skill_binding: { enabled: true, user_id: null } });
    const scope = { space_id: SPACE, project_id: null, agent_id: null, user_id: USER };
    expect((await resolveSkillBindings(db.pool, scope)).map(binding => binding.skill_package_id)).toEqual([pkg.id]);
    expect(await repo.listAvailableSkills(identity, {})).toEqual([expect.objectContaining({ skill_package_id: pkg.id })]);
  });

  it("persists a Skill-only message and reloads its exact selected version without attachment hydration", async () => {
    if (!db.available) return;
    const { repo, pkg, preview } = await importOriginalSkill();
    await approveSkillImportInTransaction({ db: db.pool, spaceId: SPACE, userId: USER, proposalId: randomUUID(), skillPackageId: pkg.id });
    await applyBindingProposal((await repo.createSkillBindingProposal({ spaceId: SPACE, userId: USER }, pkg.id, { scope_type: "space", enabled: true })).id);
    const sessionId = randomUUID(), messageId = randomUUID();
    await db.pool.query("INSERT INTO sessions (id,space_id,user_id,status,created_at,updated_at) VALUES ($1,$2,$3,'active',now(),now())", [sessionId, SPACE, USER]);
    await db.pool.query("INSERT INTO messages (id,space_id,session_id,user_id,role,content,path_depth,branch_path,created_at) VALUES ($1,$2,$3,$4,'user','',0,'/',now())", [messageId, SPACE, sessionId, USER]);
    const service = new ConversationInputService(db.pool, loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: "/tmp/rainver-skill-input-test" }));
    const parts = await service.prepareMessageParts({ spaceId: SPACE, userId: USER, sessionId, parts: [
      { kind: "skill", skill_package_id: pkg.id, package_hash: preview.package_hash, display_name: "client supplied name" },
    ] });
    await service.attachMessageParts({ spaceId: SPACE, userId: USER, sessionId, messageId, parts });
    const descriptors = await loadConversationSkillDescriptors(db.pool, { spaceId: SPACE, messageId });
    expect(descriptors).toEqual([{ kind: "skill", skill_package_id: pkg.id, package_hash: preview.package_hash, display_name: "original" }]);
    expect(renderConversationInputMessage("", [], descriptors)).toContain("Explicitly selected Skills");
    const selected = await loadSelectedSkills(db.pool, { space_id: SPACE, project_id: null, agent_id: null, user_id: USER, session_id: sessionId, message_id: messageId });
    expect(selected[0]!.content.package_hash).toBe(preview.package_hash);
    // A viewer who cannot read the conversation is refused, not handed an empty selection.
    await expect(loadSelectedSkills(db.pool, { space_id: SPACE, project_id: null, agent_id: null, user_id: randomUUID(), session_id: sessionId, message_id: messageId })).rejects.toMatchObject({ statusCode: 404 });
  });
  it("marks an imported package reviewed and records who approved it", async () => {
    if (!db.available) return;
    const sourceId = randomUUID();
    const packageId = randomUUID();
    await db.pool.query(
      `INSERT INTO skill_sources (id, space_id, source_type, content_hash, fetched_at, created_by_user_id, created_at)
       VALUES ($1, $2, 'upload', 'hash', now(), $3, now())`,
      [sourceId, SPACE, USER],
    );
    await db.pool.query(
      `INSERT INTO skill_packages (id, space_id, source_id, package_name, risk_level, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'example-skill', 'low', 'imported', now(), now())`,
      [packageId, SPACE, sourceId],
    );

    const approved = await approveSkillImportInTransaction({
      db: db.pool, spaceId: SPACE, userId: USER, proposalId: randomUUID(), skillPackageId: packageId,
    });

    expect(approved).toMatchObject({ id: packageId, status: "reviewed" });
    const row = await db.pool.query<{ manifest_json: { review?: { reviewed_by_user_id?: string } } }>(
      `SELECT manifest_json FROM skill_packages WHERE id = $1`, [packageId]);
    expect(row.rows[0]?.manifest_json.review?.reviewed_by_user_id).toBe(USER);
  });
});

const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function addMember(userId: string, role: string) {
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES ($1, 'Member', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [userId]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES (gen_random_uuid()::varchar, $1, $2, $3, 'active', now(), now())`, [SPACE, userId, role]);
}

async function insertBinding(packageId: string, scope: { agent_id?: string; user_id?: string }, enabled = true) {
  const proposal = await insertProposalRow(db.pool, { spaceId: SPACE, proposalType: "runtime_skill_binding_update", title: "Binding fixture",
    rationale: "fixture", createdByUserId: USER, visibility: "space_shared", payload: {} });
  await db.pool.query(`INSERT INTO skill_bindings (id,space_id,skill_package_id,project_id,agent_id,user_id,enabled,proposal_id,created_at,updated_at)
    VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,now(),now())`, [randomUUID(), SPACE, packageId, scope.agent_id ?? null, scope.user_id ?? null, enabled, proposal.id]);
}

/** A Room with a manager and a member Agent, both people seated, and one conversation. */
async function seedRoom() {
  const project = randomUUID(), room = randomUUID(), session = randomUUID(), manager = randomUUID(), member = randomUUID();
  await db.pool.query(`INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
    VALUES ($1,$2,$3,'Skills','active',now(),now())`, [project, SPACE, USER]);
  await db.pool.query(`INSERT INTO rooms (id, space_id, project_id, title, is_mainline, status, created_by_user_id, created_at, updated_at)
    VALUES ($1,$2,$3,'Room',false,'active',$4,now(),now())`, [room, SPACE, project, USER]);
  for (const userId of [USER, MEMBER]) {
    await db.pool.query(`INSERT INTO room_user_members (id, space_id, room_id, user_id, role, status, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,'active',now(),now())`, [randomUUID(), SPACE, room, userId, userId === USER ? "owner" : "member"]);
  }
  for (const [agent, role] of [[manager, "manager"], [member, "member"]] as const) {
    await db.pool.query(`INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
      VALUES ($1,$2,$3,$4,'active',NULL,now(),now(),'space_shared')`, [agent, SPACE, USER, role]);
    await db.pool.query(`INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,'active',now(),now())`, [randomUUID(), SPACE, room, agent, role]);
  }
  await db.pool.query(`INSERT INTO sessions (id,space_id,room_id,project_id,title,status,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'Thread','active',now(),now())`, [session, SPACE, room, project]);
  return { project, room, session, manager, member };
}

async function reviewedSkill() {
  const imported = await importOriginalSkill();
  await approveSkillImportInTransaction({ db: db.pool, spaceId: SPACE, userId: USER, proposalId: randomUUID(), skillPackageId: imported.pkg.id });
  const reference = { kind: "skill" as const, skill_package_id: imported.pkg.id, package_hash: imported.preview.package_hash, display_name: "original" };
  return { ...imported, reference };
}

describe("selected Skills across Room recipients and retries (real Postgres)", () => {
  it("offers only Skills enabled for every addressed recipient, defaulting to the manager", async () => {
    if (!db.available) return;
    await addMember(MEMBER, "member");
    const { pkg } = await reviewedSkill();
    const room = await seedRoom();
    const identity = { spaceId: SPACE, userId: USER };
    await insertBinding(pkg.id, { agent_id: room.manager });
    const ids = async (recipient_agent_ids?: string[]) => (await new PgCapabilitiesRepository(db.pool)
      .listAvailableSkills(identity, { session_id: room.session, recipient_agent_ids })).map(item => item.skill_package_id);
    expect(await ids()).toEqual([pkg.id]);
    expect(await ids([room.manager])).toEqual([pkg.id]);
    expect(await ids([room.member])).toEqual([]);
    expect(await ids([room.manager, room.member])).toEqual([]);
    await expect(ids([randomUUID()])).rejects.toMatchObject({ statusCode: 422 });
    await insertBinding(pkg.id, { agent_id: room.member });
    expect(await ids([room.manager, room.member])).toEqual([pkg.id]);
  });

  it("checks the message author's selection for every recipient when another member retries", async () => {
    if (!db.available) return;
    await addMember(MEMBER, "member");
    const { pkg, reference } = await reviewedSkill();
    const room = await seedRoom();
    await insertBinding(pkg.id, { user_id: USER });
    const scope = { space_id: SPACE, project_id: room.project, session_id: room.session };
    const verified = await assertSelectedSkillsForRecipients(db.pool, { ...scope, user_id: USER, setup_user_id: MEMBER },
      [room.manager, room.member], [reference]);
    expect([...verified.keys()]).toEqual([pkg.id]);
    // The retrier's own bindings do not stand in for the author's.
    await expect(assertSelectedSkillsForRecipients(db.pool, { ...scope, user_id: MEMBER }, [room.manager], [reference]))
      .rejects.toMatchObject({ statusCode: 422, responseBody: { code: "selected_skill_not_enabled", agent_ids: [room.manager] } });

    const messageId = randomUUID();
    await db.pool.query("INSERT INTO messages (id,space_id,session_id,user_id,role,content,path_depth,branch_path,created_at) VALUES ($1,$2,$3,$4,'user','',0,'/',now())", [messageId, SPACE, room.session, USER]);
    await db.pool.query(`INSERT INTO message_input_parts (id,space_id,session_id,message_id,position,kind,skill_package_id,display_name,media_type,byte_size,sha256)
      VALUES ($1,$2,$3,$4,0,'skill',$5,'original','application/vnd.rainver.skill',0,$6)`, [randomUUID(), SPACE, room.session, messageId, pkg.id, reference.package_hash]);
    const load = (viewer: string) => loadSelectedSkills(db.pool, { space_id: SPACE, project_id: room.project, agent_id: room.member,
      user_id: viewer, session_id: room.session, message_id: messageId });
    // Member B retrying A's turn gets exactly what the rendered message names.
    const selected = await load(MEMBER);
    const descriptors = await loadConversationSkillDescriptors(db.pool, { spaceId: SPACE, messageId });
    expect(selected.map(skill => skill.content.skill_package_id)).toEqual(descriptors.map(skill => skill.skill_package_id));
    await expect(load(randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    await db.pool.query("UPDATE skill_bindings SET enabled=false WHERE skill_package_id=$1", [pkg.id]);
    await expect(load(MEMBER)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("skill Review/Convert proposals (real Postgres)", () => {
  it("answers 409 for a different pending review, stops reporting it once reviewed and supersedes others' reviews", async () => {
    if (!db.available) return;
    await addMember(MEMBER, "member");
    const { repo, pkg } = await importOriginalSkill();
    const identity = { spaceId: SPACE, userId: USER };
    const reviewOnly = await repo.createSkillImportApprovalProposal({ identity, skillPackageId: pkg.id });
    await expect(repo.createSkillImportApprovalProposal({ identity, skillPackageId: pkg.id, binding: { scope_type: "space", enabled: true } }))
      .rejects.toMatchObject({ statusCode: 409, responseBody: { code: "skill_review_pending", proposal_id: reviewOnly.proposal.id } });
    await expect(repo.createSkillImportApprovalProposal({ identity, skillPackageId: pkg.id }))
      .resolves.toMatchObject({ created: false, proposal: { id: reviewOnly.proposal.id } });
    const others = await repo.createSkillImportApprovalProposal({ identity: { spaceId: SPACE, userId: MEMBER }, skillPackageId: pkg.id,
      binding: { scope_type: "user", scope_id: MEMBER, enabled: true } });
    const approvers = await db.pool.query<{ required_approver_role: string }>(
      "SELECT required_approver_role FROM proposals WHERE id = ANY($1::varchar[])", [[reviewOnly.proposal.id, others.proposal.id]]);
    expect(approvers.rows.map(row => row.required_approver_role)).toEqual(["admin", "admin"]);

    const registry = new ProposalApplierRegistry();
    registerCapabilityProposalAppliers(registry);
    await withTransaction(db.pool, async client => registry.apply({
      db: client, userId: USER, config: loadConfig({ SERVER_DATABASE_URL: db.connectionUri }),
      proposal: (await client.query<ApplyProposal>("SELECT * FROM proposals WHERE id=$1", [reviewOnly.proposal.id])).rows[0]!,
    }));
    await db.pool.query("UPDATE proposals SET status='accepted' WHERE id=$1", [reviewOnly.proposal.id]);
    const statuses = await db.pool.query<{ status: string }>("SELECT status FROM proposals WHERE id=$1", [others.proposal.id]);
    expect(statuses.rows[0]!.status).toBe("superseded");
    // A review the package no longer awaits is not reported as pending.
    await db.pool.query("UPDATE proposals SET status='pending' WHERE id=$1", [others.proposal.id]);
    await expect(repo.getSkillPackage({ spaceId: SPACE, userId: MEMBER }, pkg.id)).resolves.toMatchObject({ pending_proposal: null });
  });

  it("settles two reviews of one package approved at once: one applies, the other is superseded, neither deadlocks", async () => {
    if (!db.available) return;
    await addMember(MEMBER, "member");
    const { repo, pkg } = await importOriginalSkill();
    const own = await repo.createSkillImportApprovalProposal({ identity: { spaceId: SPACE, userId: USER }, skillPackageId: pkg.id });
    const others = await repo.createSkillImportApprovalProposal({ identity: { spaceId: SPACE, userId: MEMBER }, skillPackageId: pkg.id,
      binding: { scope_type: "user", scope_id: MEMBER, enabled: true } });
    const service = new PgProposalApplyService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }));
    // Holding the package row lets both approvals lock their own proposal
    // first and then queue on the package: the order that used to deadlock.
    const holder = await db.pool.connect();
    let outcomes: PromiseSettledResult<unknown>[];
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM skill_packages WHERE id = $1 FOR UPDATE", [pkg.id]);
      let settled = 0;
      const accepts = [own, others].map(review => service.accept(review.proposal.id, { spaceId: SPACE, userId: USER })
        .finally(() => { settled += 1; }));
      await waitForLockWaiter(db.pool, { waiters: 2, settled: () => settled > 0 });
      await holder.query("COMMIT");
      outcomes = await Promise.allSettled(accepts);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toEqual([]);
    const ids = [own.proposal.id, others.proposal.id];
    const rows = (await db.pool.query<{ id: string; status: string; superseded_by: string | null }>(
      `SELECT id, status, payload_json->>'superseded_by_proposal_id' AS superseded_by
         FROM proposals WHERE id = ANY($1::varchar[])`, [ids])).rows;
    const accepted = rows.filter(row => row.status === "accepted");
    expect(accepted).toHaveLength(1);
    const winner = accepted[0]!.id;
    expect(rows.find(row => row.id !== winner)).toMatchObject({ status: "superseded", superseded_by: winner });
    const reviewed = await db.pool.query<{ status: string; reviewed_from: string }>(
      `SELECT status, manifest_json->'review'->>'reviewed_from_proposal_id' AS reviewed_from FROM skill_packages WHERE id = $1`, [pkg.id]);
    expect(reviewed.rows[0]).toEqual({ status: "reviewed", reviewed_from: winner });
    // Only the applied review's binding is written.
    const bindings = await db.pool.query("SELECT 1 FROM skill_bindings WHERE skill_package_id = $1", [pkg.id]);
    expect(bindings.rowCount).toBe(winner === others.proposal.id ? 1 : 0);
  });

  it("files binding proposals for an admin approver and re-checks the Agent at apply", async () => {
    if (!db.available) return;
    await addMember(MEMBER, "member");
    const { repo, pkg } = await reviewedSkill();
    const room = await seedRoom();
    const identity = { spaceId: SPACE, userId: USER };
    const proposal = await repo.createSkillBindingProposal(identity, pkg.id, { scope_type: "agent", scope_id: room.member, enabled: true });
    const role = await db.pool.query<{ required_approver_role: string }>("SELECT required_approver_role FROM proposals WHERE id=$1", [proposal.id]);
    expect(role.rows[0]!.required_approver_role).toBe("admin");
    await db.pool.query("UPDATE agents SET status='archived' WHERE id=$1", [room.member]);
    await expect(applyBindingProposal(proposal.id)).rejects.toMatchObject({ statusCode: 409 });
    await db.pool.query("UPDATE agents SET status='active', owner_user_id=$2 WHERE id=$1", [room.member, MEMBER]);
    await expect(applyBindingProposal(proposal.id)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("files one pending proposal per person, snapshot and operation, and a new one once it is decided", async () => {
    if (!db.available) return;
    const sourceId = randomUUID();
    const packageId = randomUUID();
    await db.pool.query(
      `INSERT INTO skill_sources (id, space_id, source_type, content_hash, fetched_at, created_by_user_id, created_at)
       VALUES ($1, $2, 'upload', 'hash-a', now(), $3, now())`,
      [sourceId, SPACE, USER],
    );
    await db.pool.query(
      `INSERT INTO skill_packages (id, space_id, source_id, package_name, risk_level, status, manifest_json, created_at, updated_at)
       VALUES ($1, $2, $3, 'example-skill', 'low', 'imported', '{"package_hash":"hash-a"}'::jsonb, now(), now())`,
      [packageId, SPACE, sourceId],
    );
    const identity = { spaceId: SPACE, userId: USER };
    const repo = new PgCapabilitiesRepository(db.pool);

    // Two concurrent requests and a repeat file one proposal between them.
    const [first, second] = await Promise.all([
      repo.createSkillImportApprovalProposal({ identity, skillPackageId: packageId }),
      repo.createSkillImportApprovalProposal({ identity, skillPackageId: packageId }),
    ]);
    const again = await repo.createSkillImportApprovalProposal({ identity, skillPackageId: packageId });
    expect(first.proposal.id).toBe(second.proposal.id);
    expect(again).toMatchObject({ created: false, proposal: { id: first.proposal.id } });
    expect([first.created, second.created].sort()).toEqual([false, true]);
    const pending = await db.pool.query(`SELECT 1 FROM proposals WHERE space_id = $1 AND status = 'pending'`, [SPACE]);
    expect(pending.rowCount).toBe(1);
    await expect(repo.getSkillPackage(identity, packageId)).resolves.toMatchObject({
      pending_proposal: { id: first.proposal.id, operation: "skill_import_approve" },
    });

    // Once decided, asking again is a new legitimate request.
    await db.pool.query(`UPDATE proposals SET status = 'rejected' WHERE id = $1`, [first.proposal.id]);
    const afterReject = await repo.createSkillImportApprovalProposal({ identity, skillPackageId: packageId });
    expect(afterReject.created).toBe(true);
    expect(afterReject.proposal.id).not.toBe(first.proposal.id);
    const listed = await repo.listSkillPackages(identity, { limit: 10, offset: 0 }) as { items: Array<{ pending_proposal: unknown }> };
    expect(listed.items[0]?.pending_proposal).toEqual({ id: afterReject.proposal.id, operation: "skill_import_approve" });
  });
});

describe("skill local overlay writes (real Postgres)", () => {
  it("keeps one active overlay per scope when two first saves race", async () => {
    if (!db.available) return;
    const sourceId = randomUUID();
    const packageId = randomUUID();
    await db.pool.query(
      `INSERT INTO skill_sources (id, space_id, source_type, content_hash, fetched_at, created_by_user_id, created_at)
       VALUES ($1, $2, 'upload', 'hash', now(), $3, now())`,
      [sourceId, SPACE, USER],
    );
    await db.pool.query(
      `INSERT INTO skill_packages (id, space_id, source_id, package_name, risk_level, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'example-skill', 'low', 'imported', now(), now())`,
      [packageId, SPACE, sourceId],
    );
    const identity = { spaceId: SPACE, userId: USER };
    const first = await db.pool.connect();
    try {
      await first.query("BEGIN");
      await new PgCapabilitiesRepository(first as unknown as Pool).upsertSkillLocalOverlay(identity, packageId, {
        scope_type: "space",
        status: "active",
        overlay_json: { alias: "first", endpoint_defaults: {}, user_preferences: {} },
      });
      let settled = false;
      const second = new PgCapabilitiesRepository(db.pool).upsertSkillLocalOverlay(identity, packageId, {
        scope_type: "space",
        status: "active",
        overlay_json: { alias: "second", endpoint_defaults: {}, user_preferences: {} },
      }).finally(() => { settled = true; });
      await waitForLockWaiter(db.pool, { settled: () => settled });
      await first.query("COMMIT");
      await expect(second).resolves.toMatchObject({ overlay_json: { alias: "second" } });
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      first.release();
    }
    const active = await db.pool.query<{ alias: string }>(
      `SELECT overlay_json->>'alias' AS alias FROM skill_local_overlays WHERE skill_package_id = $1 AND status = 'active'`,
      [packageId],
    );
    expect(active.rows).toEqual([{ alias: "second" }]);
  });
});
