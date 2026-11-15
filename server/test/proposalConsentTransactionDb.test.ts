import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedSpaceOwnerProject, seedRun } from './support/domainSeeds.js';
import { insertProposalRow } from '../src/modules/proposals/reviewPackets.js';
import { PgProposalApplyService } from '../src/modules/proposals/applyService.js';
import { operationTransaction } from '../src/db/operationTransaction.js';
import { loadConfig } from '../src/config.js';

const db = useTestDatabase(import.meta.filename);
const space = randomUUID(), owner = randomUUID(), project = randomUUID(), requester = randomUUID();
const identity = { spaceId: space, userId: owner };
let proposalId: string;
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ['spaces', 'users'], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space, owner, project });
  await db.pool.query("INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES($1,'Requester','active',$2,'system',now(),now())", [requester, `${requester}@test.invalid`]);
  await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())", [randomUUID(), space, requester]);
  const proposal = await insertProposalRow(db.pool, {
    spaceId: space, proposalType: 'egress_review', title: 'Review consent',
    payload: { requires_approval_type: 'egress_content_owner', required_egress_approver_user_ids: [owner] },
    rationale: 'test consent', createdByUserId: requester, visibility: 'space_shared',
  });
  proposalId = proposal.id;
});
function service() {
  return PgProposalApplyService.fromConfig(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }));
}
async function approvals() {
  return (await db.pool.query('SELECT approver_user_id FROM proposal_approvals WHERE proposal_id=$1', [proposalId])).rows;
}

describe('canonical Proposal consent transaction', () => {
  it.each([false, true])('joins a raw/branded transaction and rolls consent back with its caller (branded=%s)', async branded => {
    if (!db.available) return;
    const client = await db.pool.connect();
    await client.query('BEGIN');
    const port = operationTransaction(client);
    try {
      const consent = await service().approveEgressGrantingUserInTransaction(branded ? port.db : client, proposalId, identity, null);
      expect(consent.approver_user_id).toBe(owner);
      expect(await approvals()).toEqual([]);
      await client.query('ROLLBACK');
      expect(await approvals()).toEqual([]);
    } finally { port.close(); client.release(); }
  });
  it('commits one consent through either entry without making the requester its consenting user', async () => {
    if (!db.available) return;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const first = await service().approveEgressGrantingUserInTransaction(client, proposalId, identity, null);
      await client.query('COMMIT');
      const replay = await service().approveEgressGrantingUser(proposalId, identity, null);
      expect(replay.id).toBe(first.id);
      expect(await approvals()).toEqual([{ approver_user_id: owner }]);
      expect((await db.pool.query('SELECT status,created_by_user_id FROM proposals WHERE id=$1', [proposalId])).rows[0]).toEqual({ status: 'pending', created_by_user_id: requester });
    } finally { client.release(); }
  });
  it('refuses a readable requester who is not the required consenting person', async () => {
    if (!db.available) return;
    await expect(service().approveEgressGrantingUser(proposalId, { spaceId: space, userId: requester }, null)).rejects.toMatchObject({ statusCode: 403 });
    expect(await approvals()).toEqual([]);
  });
  it.each(['user', 'membership'])('rechecks current %s authority even for an existing consent', async revoked => {
    if (!db.available) return;
    await service().approveEgressGrantingUser(proposalId, identity, null);
    if (revoked === 'user') await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [owner]);
    else await db.pool.query("UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2", [space, owner]);
    await expect(service().approveEgressGrantingUser(proposalId, identity, null)).rejects.toMatchObject({ statusCode: 404 });
    expect(await approvals()).toEqual([{ approver_user_id: owner }]);
  });
  it('pins a live personal-memory grant until consent commits, then refuses replay after revocation', async () => {
    if (!db.available) return;
    const run = randomUUID(), grant = randomUUID();
    await seedRun(db.pool, { id: run, space, owner: requester, agent: randomUUID(), version: randomUUID() });
    await db.pool.query(`INSERT INTO personal_memory_grants
      (id,granting_user_id,personal_space_id,target_space_id,target_run_id,grant_scope,access_mode,status,read_expires_at,egress_review_expires_at,created_at,updated_at)
      VALUES($1,$2,$3,$3,$4,'run','summary_only','used',now()+interval '1 hour',now()+interval '1 hour',now(),now())`, [grant, owner, space, run]);
    await db.pool.query('UPDATE proposals SET payload_json=$2::jsonb WHERE id=$1', [proposalId, JSON.stringify({ grant_id: grant, source_run_id: run })]);
    await expect(service().approveEgressGrantingUser(proposalId, { spaceId: space, userId: requester }, grant)).rejects.toMatchObject({ statusCode: 403 });
    const client = await db.pool.connect(), revoker = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await service().approveEgressGrantingUserInTransaction(client, proposalId, identity, grant);
      await revoker.query('BEGIN');
      await revoker.query("SET LOCAL lock_timeout='100ms'");
      await expect(revoker.query("UPDATE personal_memory_grants SET status='revoked' WHERE id=$1", [grant])).rejects.toMatchObject({ code: '55P03' });
      await revoker.query('ROLLBACK');
      await client.query('COMMIT');
      await revoker.query("UPDATE personal_memory_grants SET status='revoked' WHERE id=$1", [grant]);
      await expect(service().approveEgressGrantingUser(proposalId, identity, grant)).rejects.toMatchObject({ statusCode: 403 });
      expect(await approvals()).toEqual([{ approver_user_id: owner }]);
    } finally {
      await client.query('ROLLBACK'); await revoker.query('ROLLBACK');
      client.release(); revoker.release();
    }
  });
  it('refuses an autocommit client before writing consent', async () => {
    if (!db.available) return;
    const client = await db.pool.connect();
    try {
      await expect(service().approveEgressGrantingUserInTransaction(client, proposalId, identity, null)).rejects.toMatchObject({ code: 'operation_approval_state_inconsistent' });
      expect(await approvals()).toEqual([]);
    } finally { client.release(); }
  });
});
