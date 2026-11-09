import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from './support/testDatabase.js';
import { resetTables } from './support/resetTables.js';
import { seedSpaceOwnerProject, seedRun } from './support/domainSeeds.js';
import { linkProposalOperation } from './support/linkedProposalOperation.js';
import { insertProposalRow } from '../src/modules/proposals/reviewPackets.js';
import { withCheckpointDecisionOwner } from '../src/modules/systemActions/operations/proposalTransitions.js';
import { lockRequestKey } from '../src/modules/systemActions/operations/repository.js';
import { PgProposalApplyService } from '../src/modules/proposals/applyService.js';
import { PgRunRepository } from '../src/modules/runs/repository.js';
import { operationTransaction } from '../src/db/operationTransaction.js';
import { loadConfig } from '../src/config.js';
import type { Queryable } from '../src/modules/routeUtils/common.js';
const db = useTestDatabase(import.meta.filename);
const space = randomUUID(),
  owner = randomUUID(),
  project = randomUUID(),
  agent = randomUUID(),
  version = randomUUID();
const identity = {
  spaceId: space,
  userId: owner
};
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ['spaces', 'users'], {
    cascade: true
  });
  await seedSpaceOwnerProject(db.pool, {
    space,
    owner,
    project
  });
  await seedRun(db.pool, {
    id: randomUUID(),
    space,
    owner,
    agent,
    version
  });
});
async function graph(root: string | null = null, kind = 'workflow_execution_checkpoint') {
  const operation = randomUUID(),
    execution = randomUUID(),
    asset = randomUUID(),
    assetVersion = randomUUID(),
    automation = randomUUID(),
    node = randomUUID();
  await db.pool.query("INSERT INTO project_operations(id,space_id,project_id,kind,title,status,progress_json,created_at,updated_at) VALUES($1,$2,$3,'research','Research pass','active','{}',now(),now())", [operation, space, project]);
  await db.pool.query("INSERT INTO evolvable_assets(id,space_id,asset_type,asset_key,display_name,owner_scope_type,owner_scope_id,status,metadata_json,created_at,updated_at) VALUES($1,$2,'workflow_template',$1,'Nested workflow','space',$2,'active','{}',now(),now())", [asset, space]);
  await db.pool.query("INSERT INTO evolvable_asset_versions(id,asset_id,space_id,scope_type,scope_id,version,status,source,content_json,created_at,updated_at) VALUES($1,$2,$3,'space',$3,1,'approved','user_authored','{}',now(),now())", [assetVersion, asset, space]);
  await db.pool.query("INSERT INTO automations(id,space_id,owner_user_id,agent_id,name,trigger_type,status,config_json,project_id,created_at,updated_at) VALUES($1,$2,$3,$4,'Nested workflow','manual','active','{}',$5,now(),now())", [automation, space, owner, agent, project]);
  await db.pool.query("INSERT INTO workflow_executions(id,space_id,automation_id,workflow_version_id,status,root_run_id,trigger_type,input_json,definition_json,resolution_trace_json,budget_snapshot_json,responsible_user_id,research_operation_id,created_at,updated_at) VALUES($1,$2,$3,$4,'running',$5,'manual','{}','{}','[]','{}',$6,$7,now(),now())", [execution, space, automation, assetVersion, root, owner, operation]);
  const proposal = await insertProposalRow(db.pool, {
    spaceId: space,
    proposalType: kind,
    title: 'Review pass',
    payload: {
      proposal_type: kind,
      project_id: project,
      workflow_execution_id: execution,
      node_id: node
    },
    rationale: 'review',
    createdByUserId: owner,
    visibility: 'private'
  });
  await db.pool.query("INSERT INTO workflow_execution_nodes(id,space_id,execution_id,node_key,node_kind,title,status,approval_proposal_id,created_at,updated_at) VALUES($1,$2,$3,'review','approval_checkpoint','Review','waiting_for_review',$4,now(),now())", [node, space, execution, proposal.id]);
  return {
    operation,
    execution,
    node,
    proposal: proposal.id
  };
}
async function run() {
  const r = await new PgRunRepository(db.pool).createCoordinatorRun({
    execution_kind: 'agent',
    space_id: space,
    user_id: owner,
    agent_id: agent,
    mode: 'live',
    run_type: 'workflow',
    trigger_origin: 'manual'
  });
  return r.id;
}
async function output(root: string) {
  const p = await insertProposalRow(db.pool, {
    spaceId: space,
    createdByRunId: root,
    proposalType: 'memory_create',
    title: 'Frozen graph output',
    payload: {
      proposed_content: 'Pending'
    },
    rationale: 'test',
    createdByUserId: owner,
    visibility: 'private'
  });
  const request = await linkProposalOperation(db.pool, identity, p.id);
  await db.pool.query("UPDATE proposals SET status='staged' WHERE id=$1", [p.id]);
  return {
    id: p.id,
    request
  };
}
const terminal = (port: Queryable, id: string) => new PgRunRepository(port).markRunTerminal({
  space_id: space,
  run_id: id,
  status: 'cancelled',
  completed_at: new Date().toISOString()
});
describe('nested decision admission against real PG', () => {
  it('accepts an actual null-root Workflow checkpoint in BEGIN rather than inventing an empty-owner 503', async () => {
    if (!db.available) return;
    const f = await graph();
    const service = PgProposalApplyService.fromConfig(loadConfig({
      SERVER_DATABASE_URL: db.connectionUri
    }));
    expect((await service.accept(f.proposal, identity))?.proposal.status).toBe('accepted');
    expect((await db.pool.query('SELECT status FROM workflow_executions WHERE id=$1', [f.execution])).rows[0].status).toBe('completed');
  });
  it.each([false, true])('admits same-Project related Run keys before checkpoint domain locks (busy=%s)', async busy => {
    if (!db.available) return;
    const root = await run(),
      related = await run(),
      f = await graph(root);
    await graph(related);
    const a = await output(root),
      b = await output(related);
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      if (busy) {
        const r = (await holder.query('SELECT * FROM operation_idempotency WHERE id=$1', [b.request])).rows[0];
        await lockRequestKey(holder, [r.space_id, r.principal_kind, r.principal_id, r.on_behalf, r.authority_scope_id, r.operation_id, r.idempotency_key]);
        await holder.query('SELECT id FROM workflow_execution_nodes WHERE id=$1 FOR UPDATE', [f.node]);
      }
      const service = PgProposalApplyService.fromConfig(loadConfig({
        SERVER_DATABASE_URL: db.connectionUri
      }));
      if (busy) {
        await expect(service.accept(f.proposal, identity)).rejects.toMatchObject({
          code: 'idempotency_in_progress'
        });
        expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1', [f.proposal])).rows[0].status).toBe('pending');
      } else expect((await service.accept(f.proposal, identity))?.proposal.status).toBe('accepted');
      expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE id=ANY($1::varchar[])', [[a.request, b.request]])).rows.every(r => r.state === 'pending_approval')).toBe(true);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
  it('does not lock an immutable terminal history receipt while accepting a live checkpoint', async () => {
    if (!db.available) return;
    const historyRoot=await run(),history=await graph(historyRoot);
    const service=PgProposalApplyService.fromConfig(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
    await service.accept(history.proposal,identity);
    const old=await insertProposalRow(db.pool,{spaceId:space,createdByRunId:historyRoot,proposalType:'memory_create',title:'Historical review',payload:{proposed_content:'Still reviewable'},rationale:'old output',createdByUserId:owner,visibility:'private'});
    const request=await linkProposalOperation(db.pool,identity,old.id);
    const current=await graph(await run()),holder=await db.pool.connect();
    try{
      await holder.query('BEGIN');
      const r=(await holder.query('SELECT * FROM operation_idempotency WHERE id=$1',[request])).rows[0];
      await lockRequestKey(holder,[r.space_id,r.principal_kind,r.principal_id,r.on_behalf,r.authority_scope_id,r.operation_id,r.idempotency_key]);
      await holder.query('SELECT id FROM proposals WHERE id=$1 FOR UPDATE',[old.id]);
      expect((await service.accept(current.proposal,identity))?.proposal.status).toBe('accepted');
      expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE id=$1',[request])).rows[0].state).toBe('pending_approval');
      expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[old.id])).rows[0].status).toBe('pending');
    }finally{await holder.query('ROLLBACK');holder.release();}
  });
  it('rejects related Run set growth between discovery and fence before writing any domain row', async () => {
    if (!db.available) return;
    const root = await run(),
      f = await graph(root),
      client = await db.pool.connect();
    let injected = false;
    await client.query('BEGIN');
    const traced: Queryable = {
      async query<Row>(sql: string, args?: readonly unknown[]) {
        if (!injected && sql.includes('pg_try_advisory_xact_lock(hashtextextended') && String(args?.[0]).startsWith('proposal-run:')) {
          injected = true;
          await graph(await run());
        }
        const result = await client.query(sql, [...(args ?? [])]);
        return {
          rows: result.rows as Row[],
          rowCount: result.rowCount
        };
      }
    };
    try {
      await expect(withCheckpointDecisionOwner(traced, space, [f.proposal], async () => {
        throw new Error('must not reach domain');
      }, owner)).rejects.toMatchObject({
        code: 'operation_conflict'
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(injected).toBe(true);
    expect((await db.pool.query('SELECT status FROM workflow_executions WHERE id=$1', [f.execution])).rows[0].status).toBe('running');
  });
  it.each([false, true])('registers fresh canonical Runs even under an empty checkpoint and branded port; linked fresh terminal refuses (linked=%s)', async linked => {
    if (!db.available) return;
    const f = await graph(),
      client = await db.pool.connect();
    await client.query('BEGIN');
    let fresh = '';
    try {
      const action = withCheckpointDecisionOwner(client, space, [f.proposal], async () => {
        const port = operationTransaction(client);
        try {
          const created = await new PgRunRepository(port.db).createCoordinatorRun({
            execution_kind: 'agent',
            space_id: space,
            user_id: owner,
            agent_id: agent,
            mode: 'live',
            run_type: 'workflow',
            trigger_origin: 'manual'
          });
          fresh = created.id;
          if (linked) {
            const p = await insertProposalRow(port.db, {
              spaceId: space,
              createdByRunId: fresh,
              proposalType: 'memory_create',
              title: 'Fresh linked output',
              payload: {
                proposed_content: 'Frozen'
              },
              rationale: 'test',
              createdByUserId: owner,
              visibility: 'private'
            });
            await linkProposalOperation(port.db, identity, p.id);
          }
          return await terminal(port.db, fresh);
        } finally {
          port.close();
        }
      }, owner);
      if (linked) await expect(action).rejects.toMatchObject({
        code: 'operation_conflict'
      });else expect((await action)?.status).toBe('cancelled');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await db.pool.query('SELECT id FROM runs WHERE id=$1', [fresh])).rows).toHaveLength(0);
  });
  it('refuses an unknown existing nested Run without acquiring late keys or writing it', async () => {
    if (!db.available) return;
    const f = await graph(),
      unknown = await run(),
      client = await db.pool.connect();
    await client.query('BEGIN');
    try {
      await expect(withCheckpointDecisionOwner(client, space, [f.proposal], () => terminal(client, unknown), owner)).rejects.toMatchObject({
        code: 'operation_conflict'
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await db.pool.query('SELECT status FROM runs WHERE id=$1', [unknown])).rows[0].status).toBe('queued');
  });
});
