import {assertProjectWriterForMutation} from '../src/modules/projects/access.js';
import {assertSourceEgressAllowedForDestination} from '../src/modules/sources/sourcePromptEgress.js';
import type {SourceConnectionRow} from '../src/modules/sources/sourceRepositoryRows.js';
import {reserve,reconcile} from '../src/modules/systemActions/operations/repository.js';
import {contentDecisionFromDb} from '../src/modules/access/contentAccessQuery.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import { withPolicyAuditRecovery } from '../src/modules/policy/auditWriter.js';
import { enforce } from '../src/modules/policy/service.js';
import { loadActionRegistry } from '../src/modules/policy/actionRegistry.js';
import { withNoteWrites } from '../src/modules/knowledge/noteWriter.js';
import { dispatchRunOperation } from '../src/modules/runs/operationToolDispatch.js';
import { CliAgentToolTransport } from '../src/modules/runs/cliToolTransport.js';
import { closeDbPool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { getDbPool } from "../src/db/pool.js";
import type { RunRecord } from "../src/modules/runs/repository.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import { insertKnowledgeItem } from "./support/knowledgeFixtures.js";
import { pruneOperationRequests } from "../src/modules/systemActions/operations/retention.js";
import { insertProposalRow } from '../src/modules/proposals/reviewPackets.js';
import { ProposalApplierRegistry } from '../src/modules/proposals/applierRegistry.js';
import { operationProposalService } from '../src/modules/systemActions/operations/approvals.js';
import { ProjectOperationService } from "../src/modules/projects/projectOperationService.js";
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SYSTEM_ACTION_REGISTRY, type SystemActionDefinition } from '@rainver/protocol';
import { useTestDatabase } from './support/testDatabase.js';
import { seedSpaceOwnerProject, seedSpaceMember, seedRun } from './support/domainSeeds.js';
import { loadConfig } from '../src/config.js';
import { OperationExecutor } from '../src/modules/systemActions/operations/executor.js';
import { sessionActor, runActor } from '../src/modules/systemActions/operations/actor.js';
import { hidden,OperationBusinessError } from '../src/modules/systemActions/operations/errors.js';
import { HttpError, withQueryableTransaction } from '../src/modules/routeUtils/common.js';
import type { OperationRegistration } from '../src/modules/systemActions/operations/types.js';
import { buildModuleServer } from './support/moduleServer.js';
import { systemActionsModule } from '../src/modules/systemActions/index.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
const db = useTestDatabase(import.meta.filename);
let space: string, owner: string, project: string, operation: string;
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID();
  owner = randomUUID();
  project = randomUUID();
  await seedSpaceOwnerProject(db.pool, {
    space,
    owner,
    project
  });
  operation = String((await new ProjectOperationService(db.pool).create({
    spaceId: space,
    userId: owner
  }, project, {
    kind: "custom",
    title: "Research"
  })).id);
});
afterEach(() => __setAuthIdentityForTests(null));
function registration(execute: OperationRegistration['execute'], kind: 'command' | 'query' = 'command'): OperationRegistration {
  const base = SYSTEM_ACTION_REGISTRY.find(d => d.id === 'project.operation.create')!;
  const definition: SystemActionDefinition = {
    ...base,
    execution: {
      kind,
      tx: 'core_owned'
    },
    side_effects: kind === 'query' ? 'none' : 'durable',
    idempotency_required: kind === 'command',
    input_schema: z.object({
      name: z.string()
    }).strict(),
    output_schema: z.object({
      name: z.string(),
      version: z.number()
    }).strict()
  };
  return {
    definition,
    readKind: kind === 'query' ? 'metadata' : undefined,
    async resolve() {
      return {
        authority: `project:${project}`,
        targets: {
          project_id: project
        },
        resourceType: 'project',
        resourceId: project
      };
    },
    async authorize(tx, _input, actor) {
      const r = await tx.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 AND owner_user_id=$3', [project, actor.space_id, actor.on_behalf_of_user_id]);
      if (!r.rows[0]) throw new Error('not authorized');
    },
    execute
  };
}
function core(r: OperationRegistration) {
  return new OperationExecutor(db.pool, loadConfig({
    SERVER_DATABASE_URL: db.connectionUri
  }), [r]);
}
const actor = () => sessionActor({
  spaceId: space,
  userId: owner
});
const update: OperationRegistration['execute'] = async (tx, input) => {
  return withQueryableTransaction(tx, async joined => {
    const row = (await joined.query<{
      name: string;
      version: number;
    }>('UPDATE project_operations SET title=$2,version=version+1 WHERE id=$1 RETURNING title AS name,version', [operation, (input as {
      name: string;
    }).name])).rows[0];
    return row;
  });
};
describe('transactional operation execution', () => {
  it('commits once and replays after the business version advances; changed input conflicts', async () => {
    const r = registration(update),
      engine = core(r),
      key = randomUUID();
    const beforeVersion = (await db.pool.query('SELECT version FROM project_operations WHERE id=$1', [operation])).rows[0].version;
    const first = await engine.execute(r.definition.id, {
      name: 'new'
    }, actor(), 'first', key);
    expect(first.http_status).toBe(200);
    const replay = await engine.execute(r.definition.id, {
      name: 'new'
    }, actor(), 'replay', key);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(first.body);
    expect((await db.pool.query('SELECT version FROM project_operations WHERE id=$1', [operation])).rows[0].version).toBe(beforeVersion + 1);
    expect((await engine.execute(r.definition.id, {
      name: 'changed'
    }, actor(), 'other', key)).http_status).toBe(422);
  });
  it('rolls back invalid output, nested writes and key reservation together', async () => {
    const r = registration(async (tx, input, a) => {
      await update(tx, input, a);
      return {
        invalid: true
      };
    });
    expect((await core(r).execute(r.definition.id, {
      name: 'bad'
    }, actor(), 'bad', randomUUID())).http_status).toBe(500);
    expect((await db.pool.query('SELECT title AS name FROM project_operations WHERE id=$1', [operation])).rows[0].name).toBe('Research');
    expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1', [space])).rows).toHaveLength(0);
  });
  it('rolls back a classified business failure savepoint and replays its sanitized failure', async () => {
    const r = registration(async (tx, input, a) => {
        await update(tx, input, a);
        throw new OperationBusinessError('operation_conflict', 409, 'projects');
      }),
      engine = core(r),
      key = randomUUID();
    expect((await engine.execute(r.definition.id, {
      name: 'bad'
    }, actor(), 'one', key)).http_status).toBe(409);
    const second = await engine.execute(r.definition.id, {
      name: 'bad'
    }, actor(), 'two', key);
    expect(second.replayed).toBe(true);
    expect(second.body).toMatchObject({
      error: {
        request_id: 'two'
      }
    });
    expect((await db.pool.query('SELECT title AS name FROM project_operations WHERE id=$1', [operation])).rows[0].name).toBe('Research');
  });
  it('rejects concurrent duplicates with retryable 409 rather than waiting for the first commit', async () => {
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => entered = resolve),
      wait = new Promise<void>(resolve => release = resolve);
    const r = registration(async (tx, input, a) => {
        entered();
        await wait;
        return update(tx, input, a);
      }),
      engine = core(r),
      key = randomUUID();
    const first = engine.execute(r.definition.id, {
      name: 'once'
    }, actor(), 'one', key);
    await ready;
    try {
      expect((await engine.execute(r.definition.id, {
        name: 'once'
      }, actor(), 'two', key)).body).toMatchObject({
        error: {
          code: 'idempotency_in_progress',
          retryable: true
        }
      });
    } finally {
      release();
      await first;
    }
  });
  it('uses a PG read-only query transaction and withholds query data when required access audit fails', async () => {
    const r = registration(update, 'query');
    expect((await core(r).execute(r.definition.id, {
      name: 'bad'
    }, actor(), 'query')).http_status).toBe(500);
    const reading = registration(async () => ({
      name: 'content',
      version: 1
    }), 'query');
    reading.readAudit = async () => {
      throw new Error('audit down');
    };
    expect((await core(reading).execute(reading.definition.id, {
      name: 'x'
    }, actor(), 'audit')).body).toMatchObject({
      error: {
        code: 'operation_audit_unavailable'
      }
    });
    expect((await db.pool.query('SELECT title AS name FROM project_operations WHERE id=$1', [operation])).rows[0].name).toBe('Research');
  });
  it('rechecks membership on replay and never discloses cached data after revocation', async () => {
    const r = registration(update),
      engine = core(r),
      key = randomUUID();
    await engine.execute(r.definition.id, {
      name: 'private'
    }, actor(), 'one', key);
    await db.pool.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1 AND user_id=$2", [space, owner]);
    expect((await engine.execute(r.definition.id, {
      name: 'private'
    }, actor(), 'two', key)).body).toMatchObject({
      error: {
        code: 'operation_not_found'
      }
    });
  });
  it('rejects independent transaction control and cannot use an expired scoped port', async () => {
    let held: Parameters<OperationRegistration['execute']>[0] | undefined;
    const r = registration(async tx => {
      held = tx;
      await expect(tx.query('COMMIT')).rejects.toThrow('control refused');
      return {
        name: 'safe',
        version: 1
      };
    });
    expect((await core(r).execute(r.definition.id, {
      name: 'ok'
    }, actor(), 'x', randomUUID())).http_status).toBe(200);
    await expect(held!.query('SELECT 1')).rejects.toThrow('expired');
  });
  it('serves the real catalog through the generic authenticated query while legacy commands stay hidden', async () => {
    __setAuthIdentityForTests({
      spaceId: space,
      userId: owner
    });
    const app = buildModuleServer(loadConfig({
      SERVER_DATABASE_URL: db.connectionUri
    }), [systemActionsModule]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/queries/system.actions.list'
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toContain('private');
      expect(res.headers['cache-control']).toContain('no-store');
      expect(res.json()).toMatchObject({
        status: 'succeeded',
        data: {
          actions: [{
            id: 'system.actions.list',
            kind: 'query'
          },{id:'research.cancel_acquisition',kind:'command'}]
        }
      });
      expect((await app.inject({
        method: 'POST',
        url: '/api/v1/actions/research.start_acquisition',
        payload: {
          operation_id: randomUUID()
        }
      })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
function approvalFixture() {
  const r = registration(update);
  const base = SYSTEM_ACTION_REGISTRY.find(d => d.id === 'project.propose_definition')!;
  r.definition = {
    ...r.definition,
    id: base.id,
    policy_action: base.policy_action,
    gate_class: base.gate_class,
    proposal_type: base.proposal_type
  };
  r.approval = {
    mode: 'proposal_submission',
    proposalType: 'project_brief_publish',
    gate: {
      kind: 'hard_gate',
      gate_class: 'direction'
    },
    atomicStatusWritersVerified: true,
    async preconditions(tx) {
      return (await tx.query('SELECT version FROM project_operations WHERE id=$1', [operation])).rows[0];
    },
    async create(tx, input, a) {
      const row = await insertProposalRow(tx, {
        spaceId: space,
        projectId: project,
        proposalType: 'project_brief_publish',
        title: 'Fixture approval',
        payload: {
          proposal_type: 'project_brief_publish',
          action_id: 'project.propose_definition',
          project_id: project,
          goal: 'Fixture operation approval',
          name: (input as {
            name: string;
          }).name
        },
        rationale: 'Operation integration fixture',
        createdByUserId: a.on_behalf_of_user_id,
        ownerUserId: owner,
        requiredApproverRole: 'owner',
        visibility: 'private',
        riskLevel: 'low'
      });
      return row.id;
    }
  };
  const engine = core(r),
    registry = new ProposalApplierRegistry();
  registry.register('project_brief_publish', async ({
    db: tx,
    proposal
  }) => ({
    result_type: 'project_brief_version',
    result: (await update(tx, {
      name: proposal.payload_json?.name
    }, actor())) as Record<string, unknown>
  }));
  const service = operationProposalService(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri
  }), registry, engine.registrations);
  return {
    r,
    engine,
    service
  };
}
describe('canonical Proposal integration', () => {
  it('creates one durable pending Proposal and accepts business/result/decision in one transaction', async () => {
    const {
        r,
        engine,
        service
      } = approvalFixture(),
      key = randomUUID();
    const pending = await engine.execute(r.definition.id, {
      name: 'approved'
    }, actor(), 'pending', key);
    expect(pending.http_status).toBe(202);
    expect((await engine.execute(r.definition.id, {
      name: 'approved'
    }, actor(), 'again', key)).body).toEqual(pending.body);
    const id = (pending.body as {
      proposal_id: string;
    }).proposal_id;
    await service.accept(id, {
      spaceId: space,
      userId: owner
    });
    const replay = await engine.execute(r.definition.id, {
      name: 'approved'
    }, actor(), 'final', key);
    expect(replay.body).toMatchObject({
      status: 'succeeded',
      data: {
        name: 'approved'
      }
    });
    expect(replay.replayed).toBe(true);
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1', [id])).rows[0].state).toBe('succeeded');
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1', [id])).rows[0].status).toBe('accepted');
  });
  it('supersedes drifted approval preconditions without applying the mutation', async () => {
    const {
        r,
        engine,
        service
      } = approvalFixture(),
      key = randomUUID();
    const pending = await engine.execute(r.definition.id, {
        name: 'never'
      }, actor(), 'pending', key),
      id = (pending.body as {
        proposal_id: string;
      }).proposal_id;
    await db.pool.query('UPDATE project_operations SET version=version+1 WHERE id=$1', [operation]);
    expect(await service.accept(id, {
      spaceId: space,
      userId: owner
    })).toBeNull();
    expect((await engine.execute(r.definition.id, {
      name: 'never'
    }, actor(), 'retry', key)).body).toMatchObject({
      error: {
        code: 'operation_approval_superseded'
      }
    });
  });
  it('reconciles external supersession and refuses accepted-without-atomic-result instead of reexecuting', async () => {
    const {
        r,
        engine
      } = approvalFixture(),
      key = randomUUID();
    const pending = await engine.execute(r.definition.id, {
        name: 'never'
      }, actor(), 'pending', key),
      id = (pending.body as {
        proposal_id: string;
      }).proposal_id;
    await db.pool.query("UPDATE proposals SET status='accepted' WHERE id=$1", [id]);
    expect((await engine.execute(r.definition.id, {
      name: 'never'
    }, actor(), 'retry', key)).body).toMatchObject({
      error: {
        code: 'operation_approval_state_inconsistent'
      }
    });
    await db.pool.query("UPDATE proposals SET status='superseded' WHERE id=$1", [id]);
    expect((await engine.execute(r.definition.id, {
      name: 'never'
    }, actor(), 'retry2', key)).body).toMatchObject({
      error: {
        code: 'operation_approval_superseded'
      }
    });
  });
  it('rejects through the canonical service and never executes the pending command', async () => {
    const {
        r,
        engine,
        service
      } = approvalFixture(),
      key = randomUUID();
    const pending = await engine.execute(r.definition.id, {
        name: 'never'
      }, actor(), 'pending', key),
      id = (pending.body as {
        proposal_id: string;
      }).proposal_id;
    await service.reject(id, {
      spaceId: space,
      userId: owner
    });
    expect((await engine.execute(r.definition.id, {
      name: 'never'
    }, actor(), 'retry', key)).body).toMatchObject({
      error: {
        code: 'operation_approval_rejected'
      }
    });
  });
});
describe('request retention and mandatory audit', () => {
  it('purges only old terminal records, preserves actionable pending, and reconciles expiry without executing', async () => {
    const r = registration(update),
      engine = core(r),
      key = randomUUID();
    await engine.execute(r.definition.id, {
      name: 'once'
    }, actor(), 'terminal', key);
    await db.pool.query("UPDATE operation_idempotency SET terminal_at=now()-interval '8 days' WHERE space_id=$1", [space]);
    const fixture = approvalFixture();
    const pending = await fixture.engine.execute(fixture.r.definition.id, {
      name: 'pending'
    }, actor(), 'pending', randomUUID());
    expect((await pruneOperationRequests(db.pool)).deleted).toBe(1);
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE space_id=$1', [space])).rows[0].state).toBe('pending_approval');
    await db.pool.query("UPDATE proposals SET expires_at=now()-interval '1 second' WHERE id=$1", [(pending.body as {
      proposal_id: string;
    }).proposal_id]);
    await pruneOperationRequests(db.pool);
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE space_id=$1', [space])).rows[0].state).toBe('expired');
  });
  it('withholds command writes and success on policy audit persistence failure', async () => {
    await db.pool.query(`CREATE FUNCTION reject_operation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit refusal'; END $$`);
    await db.pool.query('CREATE TRIGGER reject_operation_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION reject_operation_audit()');
    try {
      const r = registration(update);
      expect((await core(r).execute(r.definition.id, {
        name: 'never'
      }, actor(), 'audit', randomUUID())).body).toMatchObject({
        error: {
          code: 'operation_audit_unavailable'
        }
      });
      expect((await db.pool.query('SELECT title FROM project_operations WHERE id=$1', [operation])).rows[0].title).toBe('Research');
      expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1', [space])).rows).toHaveLength(0);
    } finally {
      await db.pool.query('DROP TRIGGER reject_operation_audit ON policy_decision_records');
      await db.pool.query('DROP FUNCTION reject_operation_audit()');
    }
  });
});
describe('controlled content-access audit port', () => {
  it('records cross-person B11 reads before content release while same-owner reads add no log', async () => {
    const other = randomUUID(),
      resource = randomUUID();
    await seedSpaceMember(db.pool, {
      space,
      user: other
    });
    await insertKnowledgeItem(db.pool, {
      id: resource,
      spaceId: space,
      title: 'Shared content',
      content: 'body',
      ownerUserId: other,
      createdByUserId: other,
      projectId: project
    });
    const r = registration(async () => ({
      name: 'body',
      version: 1
    }), 'query');
    r.readAudit = async port => {
      await port.recordReads('space_object', [resource]);
    };
    expect((await core(r).execute(r.definition.id, {
      name: 'read'
    }, actor(), 'read')).http_status).toBe(200);
    const logs = (await db.pool.query('SELECT owner_user_id,viewer_user_id FROM content_access_logs WHERE resource_id=$1', [resource])).rows;
    expect(logs).toEqual([{
      owner_user_id: other,
      viewer_user_id: owner
    }]);
    const own = randomUUID();
    await insertKnowledgeItem(db.pool, {
      id: own,
      spaceId: space,
      title: 'Own',
      content: 'own',
      ownerUserId: owner,
      createdByUserId: owner,
      projectId: project
    });
    r.readAudit = async port => {
      await port.recordReads('space_object', [own]);
    };
    expect((await core(r).execute(r.definition.id, {
      name: 'read'
    }, actor(), 'own')).http_status).toBe(200);
    expect((await db.pool.query('SELECT id FROM content_access_logs WHERE resource_id=$1', [own])).rows).toHaveLength(0);
  });
});
describe('durable effects and post-commit delivery', () => {
  it('commits durable Job intent with the domain mutation and ignores failed notification without repeating writes', async () => {
    let notified = 0;
    const r = registration(async (tx, input, a) => {
      const result = await update(tx, input, a);
      await new PgJobQueueRepository(tx).enqueue({
        job_type: 'operation_fixture',
        space_id: space,
        user_id: owner,
        payload: {
          operation_id: operation
        }
      });
      return result;
    });
    r.afterCommit = async () => {
      notified++;
      throw new Error('lost notification');
    };
    const engine = core(r),
      key = randomUUID();
    expect((await engine.execute(r.definition.id, {
      name: 'queued'
    }, actor(), 'one', key)).http_status).toBe(200);
    expect((await engine.execute(r.definition.id, {
      name: 'queued'
    }, actor(), 'two', key)).replayed).toBe(true);
    expect(notified).toBe(1);
    expect((await db.pool.query("SELECT id FROM jobs WHERE space_id=$1 AND job_type='operation_fixture'", [space])).rows).toHaveLength(1);
  });
  it('rolls back status writes when required Job enqueue fails', async () => {
    await db.pool.query(`CREATE FUNCTION reject_operation_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected enqueue refusal' USING ERRCODE='08006'; END $$`);
    await db.pool.query('CREATE TRIGGER reject_operation_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_operation_job()');
    try {
      const r = registration(async (tx, input, a) => {
        await update(tx, input, a);
        await new PgJobQueueRepository(tx).enqueue({
          job_type: 'operation_fixture',
          space_id: space,
          user_id: owner,
          payload: {}
        });
        return {
          name: 'bad',
          version: 1
        };
      });
      expect((await core(r).execute(r.definition.id, {
        name: 'never'
      }, actor(), 'job', randomUUID())).http_status).toBe(503);
      expect((await db.pool.query('SELECT title FROM project_operations WHERE id=$1', [operation])).rows[0].title).toBe('Research');
      expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1', [space])).rows).toHaveLength(0);
    } finally {
      await db.pool.query('DROP TRIGGER reject_operation_job ON jobs');
      await db.pool.query('DROP FUNCTION reject_operation_job()');
    }
  });
});
describe('origin-gated canonical acceptance', () => {
  it('satisfies only its frozen unattended gate after canonical approval even when the requesting Run finished', async () => {
    const agent = randomUUID(),
      run = randomUUID();
    await seedRun(db.pool, {
      id: run,
      space,
      owner,
      agent,
      version: randomUUID()
    });
    await db.pool.query("UPDATE runs SET status='running',trigger_origin='autonomous',instructed_by_user_id=$2,permission_snapshot_json=$3::jsonb WHERE id=$1", [run, owner, JSON.stringify({
      tool_grants: [{
        action_id: 'task.create'
      }]
    })]);
    const actor = await runActor(db.pool, (await db.pool.query<RunRecord>('SELECT * FROM runs WHERE id=$1', [run])).rows[0]);
    const fixture = approvalFixture(),
      r = fixture.r;
    r.definition = {
      ...r.definition,
      id: 'task.create',
      policy_action: 'task.create',
      gate_class: null,
      allowed_actor_types: ['agent'],
      visibility: new Set(['agent_tool'])
    };
    r.approval = {
      ...r.approval!,
      mode: 'blocked_command',
      gate: {
        kind: 'unattended_origin',
        policy_rule_id: 'unattended_project_write_require_approval'
      }
    };
    const engine = core(r),
      registry = new ProposalApplierRegistry();
    registry.register('project_brief_publish', async ({
      db: tx,
      proposal
    }) => ({
      result_type: 'project_brief_version',
      result: (await update(tx, {
        name: proposal.payload_json?.name
      }, actor)) as Record<string, unknown>
    }));
    const pending = await engine.execute(r.definition.id, {
      name: 'approved once'
    }, actor, 'scheduled', randomUUID());
    expect(pending.http_status).toBe(202);
    const id = (pending.body as {
      proposal_id: string;
    }).proposal_id;
    await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1", [run]);
    await operationProposalService(loadConfig({
      SERVER_DATABASE_URL: db.connectionUri
    }), registry, engine.registrations).accept(id, {
      spaceId: space,
      userId: owner
    });
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1', [id])).rows[0].state).toBe('succeeded');
    expect((await db.pool.query('SELECT status FROM runs WHERE id=$1', [run])).rows[0].status).toBe('succeeded');
  });
  it('rolls back deterministic approved business failure and records failed plus superseded atomically', async () => {
    const {
        r,
        engine
      } = approvalFixture(),
      registry = new ProposalApplierRegistry();
    registry.register('project_brief_publish', async ({
      db: tx
    }) => {
      await update(tx, {
        name: 'never'
      }, actor());
      throw new OperationBusinessError('operation_conflict', 409, 'projects');
    });
    const key = randomUUID(),
      pending = await engine.execute(r.definition.id, {
        name: 'never'
      }, actor(), 'pending', key),
      id = (pending.body as {
        proposal_id: string;
      }).proposal_id;
    await operationProposalService(loadConfig({
      SERVER_DATABASE_URL: db.connectionUri
    }), registry, engine.registrations).accept(id, {
      spaceId: space,
      userId: owner
    });
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1', [id])).rows[0].state).toBe('failed');
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1', [id])).rows[0].status).toBe('superseded');
    expect((await db.pool.query('SELECT title FROM project_operations WHERE id=$1', [operation])).rows[0].title).toBe('Research');
    expect((await engine.execute(r.definition.id, {
      name: 'never'
    }, actor(), 'replay', key)).body).toMatchObject({
      error: {
        code: 'operation_conflict'
      }
    });
  });
});
describe('transaction ownership escape prevention', () => {
  it('refuses the canonical independent pool lookup inside migrated business execution', async () => {
    const r = registration(async (tx, input, a) => {
      await update(tx, input, a);
      await getDbPool(db.connectionUri).query("UPDATE projects SET name='escaped' WHERE id=$1", [project]);
      return {
        name: 'bad',
        version: 1
      };
    });
    expect((await core(r).execute(r.definition.id, {
      name: 'never'
    }, actor(), 'escape', randomUUID())).http_status).toBe(500);
    expect((await db.pool.query('SELECT name FROM projects WHERE id=$1', [project])).rows[0].name).toBe('Research');
    expect((await db.pool.query('SELECT title FROM project_operations WHERE id=$1', [operation])).rows[0].title).toBe('Research');
  });
});

describe('mapped applier transaction ownership',()=>{
 it('refuses applier COMMIT and keeps both request and Proposal pending without a partial write',async()=>{
  const {r,engine}=approvalFixture(),registry=new ProposalApplierRegistry();
  registry.register('project_brief_publish',async({db:tx})=>{await update(tx,{name:'never'},actor());await tx.query('COMMIT');return {result_type:'project_brief_version',result:{name:'bad',version:1}};});
  const key=randomUUID(),pending=await engine.execute(r.definition.id,{name:'never'},actor(),'pending',key),id=(pending.body as {proposal_id:string}).proposal_id;
  await expect(operationProposalService(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),registry,engine.registrations).accept(id,{spaceId:space,userId:owner})).rejects.toThrow('transaction control refused');
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].state).toBe('pending_approval');
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[id])).rows[0].status).toBe('pending');
  expect((await db.pool.query('SELECT title FROM project_operations WHERE id=$1',[operation])).rows[0].title).toBe('Research');
 });
});

describe('recovered operation contract boundaries',()=>{
 it('rejects ABORT without losing the core transaction',async()=>{
  const r=registration(async(tx,input,a)=>{await expect(tx.query('ABORT')).rejects.toThrow('transaction control refused');return update(tx,input,a);});
  expect((await core(r).execute(r.definition.id,{name:'still atomic'},actor(),'abort',randomUUID())).http_status).toBe(200);
 });
 it('supersedes a changed approval mapping instead of interpreting the old pending request with it',async()=>{
  const {r,engine}=approvalFixture(),key=randomUUID();
  const pending=await engine.execute(r.definition.id,{name:'never'},actor(),'pending',key),id=(pending.body as {proposal_id:string}).proposal_id;
  const changed={...r,approval:{...r.approval!,requiresLiveRun:true,mode:'blocked_command' as const,gate:{kind:'hard_gate' as const,gate_class:'direction' as const,policy_rule_id:'registry_default'}}};
  const registry=new ProposalApplierRegistry();
  registry.register('project_brief_publish',async()=>{throw new Error('must not apply');});
  const service=operationProposalService(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),registry,new Map([[r.definition.id,changed]]));
  expect(await service.accept(id,{spaceId:space,userId:owner})).toBeNull();
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].state).toBe('superseded');
 });
});

describe('approval requester binding',()=>{
 it('refuses a frozen requester that no longer matches the reserved identity namespace',async()=>{
  const {r,engine}=approvalFixture(),key=randomUUID(),other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});
  r.authorize=async()=>{};
  const pending=await engine.execute(r.definition.id,{name:'never'},actor(),'pending',key),id=(pending.body as {proposal_id:string}).proposal_id;
  const stored=(await db.pool.query('SELECT frozen_json FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].frozen_json;
  stored.actor.principal.id=other;stored.actor.on_behalf_of_user_id=other;
  await db.pool.query('UPDATE operation_idempotency SET frozen_json=$2::jsonb WHERE proposal_id=$1',[id,JSON.stringify(stored)]);
  const registry=new ProposalApplierRegistry();registry.register('project_brief_publish',async()=>{throw new Error('must not apply');});
  await expect(operationProposalService(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),registry,engine.registrations).accept(id,{spaceId:space,userId:owner})).rejects.toMatchObject({code:'operation_approval_state_inconsistent'});
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].state).toBe('pending_approval');
 });
});


describe('review regressions: independent audits and compatibility', () => {
  it('preserves operation-policy denial and proposal.apply failure audits after acceptance rolls back', async () => {
    const {r, engine, service} = approvalFixture();
    r.definition = {...r.definition, policy_action: 'runtime.execute'};
    let active = true;
    r.policyContext = () => ({agent_status: active ? 'active' : 'paused'});
    const pending = await engine.execute(r.definition.id, {name: 'never'}, actor(), 'pending', randomUUID());
    expect(pending.http_status).toBe(202);
    const id = (pending.body as {proposal_id:string}).proposal_id;
    active = false;
    await expect(service.accept(id, {spaceId:space, userId:owner})).rejects.toMatchObject({statusCode:404});
    const audits = (await db.pool.query('SELECT action,decision,metadata_json FROM policy_decision_records WHERE proposal_id=$1 ORDER BY action', [id])).rows;
    expect(audits).toHaveLength(2);
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({action:'proposal.apply', metadata_json:expect.objectContaining({operation_outcome:'failed'})}),
      expect.objectContaining({action:'runtime.execute', decision:'deny', metadata_json:expect.objectContaining({operation_outcome:'failed'})}),
    ]));
    expect(JSON.stringify(audits)).not.toContain('never');
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1', [id])).rows[0].state).toBe('pending_approval');
    expect((await db.pool.query('SELECT title FROM project_operations WHERE id=$1',[operation])).rows[0].title).toBe('Research');
  });

  it('preserves canonical proposal.apply denial independently of the rejected transaction', async () => {
    const {r,engine,service} = approvalFixture();
    const pending = await engine.execute(r.definition.id,{name:'never'},actor(),'pending',randomUUID());
    const id = (pending.body as {proposal_id:string}).proposal_id;
    await db.pool.query(`UPDATE proposals SET payload_json=payload_json||'{"is_approved":true}'::jsonb WHERE id=$1`,[id]);
    let denied: unknown;
    try { await service.accept(id,{spaceId:space,userId:owner}); } catch(error) { denied=error; }
    expect(denied).toMatchObject({statusCode:403});
    const audits=(await db.pool.query("SELECT decision,metadata_json FROM policy_decision_records WHERE proposal_id=$1 AND action='proposal.apply'",[id])).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({decision:'deny',metadata_json:{operation_outcome:'failed'}});
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[id])).rows[0].status).toBe('pending');
  });

  it('completes concurrent content queries with every small data-pool slot held', async () => {
    await closeDbPool(db.connectionUri);
    const data = getDbPool(db.connectionUri);
    data.options.max = 2;
    const other=randomUUID(), resource=randomUUID();
    await seedSpaceMember(db.pool,{space,user:other});
    await insertKnowledgeItem(db.pool,{id:resource,spaceId:space,title:'Shared',content:'body',ownerUserId:other,createdByUserId:other,projectId:project});
    let arrived=0, release!:()=>void;
    const both=new Promise<void>(resolve=>{release=resolve;});
    const r=registration(async()=>({name:'body',version:1}),'query'), resolve=r.resolve;
    r.resolve=async(...args)=>{if(++arrived===2)release();await both;return resolve(...args);};
    r.readKind='content';
    r.readAudit=async audit=>{await audit.recordReads('space_object',[resource]);};
    const engine=new OperationExecutor(data,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[r]);
    const results=await Promise.all([1,2].map(n=>engine.execute(r.definition.id,{name:'read'},actor(),String(n))));
    expect(results.map(r=>r.http_status)).toEqual([200,200]);
    expect((await db.pool.query('SELECT id FROM content_access_logs WHERE resource_id=$1',[resource])).rows).toHaveLength(2);
    expect(data.waitingCount).toBe(0);
  });

  it('reports missing-Proposal pending requests as inconsistent without discarding evidence', async () => {
    const {r,engine}=approvalFixture();
    const pending=await engine.execute(r.definition.id,{name:'keep'},actor(),'pending',randomUUID());
    const id=(pending.body as {proposal_id:string}).proposal_id;
    // Simulate legacy corruption only in the shared fixture database; restore trigger mode on commit.
    await withTransaction(db.pool,async tx=>{
      await tx.query('SET LOCAL session_replication_role=replica');
      await tx.query('DELETE FROM proposals WHERE id=$1',[id]);
    });
    expect(await pruneOperationRequests(db.pool)).toMatchObject({inconsistent:1});
    expect((await db.pool.query('SELECT state,frozen_json FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0]).toMatchObject({state:'pending_approval',frozen_json:expect.any(Object)});
  });

  it('joins the real note writer and its retrieval savepoint, while refusing outer rollback and multi-statements', async () => {
    let note='';
    const r=registration(async tx=>{
      await expect(tx.query('ROLLBACK TO SAVEPOINT operation_work')).rejects.toThrow('not owned');
      await expect(tx.query('SELECT 1; COMMIT')).rejects.toThrow('control refused');
      const literal=await tx.query<{value:string}>(`SELECT ';COMMIT' AS value /* ; ignored */`);
      expect(literal.rows[0].value).toBe(';COMMIT');
      expect((await tx.query<{value:string}>(`SELECT $$;ROLLBACK$$ AS value`)).rows[0].value).toBe(';ROLLBACK');
      const created=await withNoteWrites(tx,scope=>scope.create({spaceId:space,actor:{userId:owner},title:'Savepoint note',doc:{type:'doc',content:[]},primaryProjectId:project}));
      note=created.id;
      return {name:note,version:created.version};
    });
    expect((await core(r).execute(r.definition.id,{name:'note'},actor(),'note',randomUUID())).http_status).toBe(200);
    expect((await db.pool.query("SELECT object_id FROM retrieval_objects WHERE space_id=$1 AND object_type='note' AND object_id=$2",[space,note])).rows).toHaveLength(1);
  });

  it.each([409,422] as const)('keeps explicitly classified domain %s safe, atomic and replayable', async status=>{
    let calls=0;
    const r=registration(async(tx,input,a)=>{calls++;await update(tx,input,a);throw new HttpError(status,'PRIVATE exception',{code:'fixture_rejected',secret:'PRIVATE body'});});
    r.classifyError=error=>error instanceof HttpError && error.statusCode===status && (error.responseBody as {code?:string})?.code==='fixture_rejected'
      ? new OperationBusinessError(status===409?'operation_conflict':'operation_invalid_input',status,'project_operations') : undefined;
    const engine=core(r),key=randomUUID();
    for(const request of ['first','retry']) {
      const result=await engine.execute(r.definition.id,{name:'never'},actor(),request,key);
      expect(result.http_status).toBe(status);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
    expect(calls).toBe(1);
    expect((await db.pool.query('SELECT title FROM project_operations WHERE id=$1',[operation])).rows[0].title).toBe('Research');
    const unknown=registration(async()=>{throw new HttpError(422,'PRIVATE unknown');});
    unknown.classifyError=r.classifyError;
    const result=await core(unknown).execute(unknown.definition.id,{name:'bad'},actor(),'unknown',randomUUID());
    expect(result.http_status).toBe(500);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect((await db.pool.query('SELECT id FROM policy_decision_records WHERE id=$1',[result.policy_decision_record_id])).rows).toHaveLength(1);
  });

  it('keeps Agent lifecycle, replay and refusal RunEvents across the core/legacy boundary', async()=>{
    const agent=randomUUID(),runId=randomUUID();
    await seedRun(db.pool,{id:runId,space,owner,agent,version:randomUUID()});
    const r=registration(update),config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
    r.definition={...r.definition,allowed_actor_types:['agent'],visibility:new Set(['agent_tool'])};
    await db.pool.query("UPDATE runs SET status='running',instructed_by_user_id=$2,permission_snapshot_json=$3::jsonb WHERE id=$1",[runId,owner,JSON.stringify({tool_grants:[{action_id:r.definition.id}]})]);
    const run=(await db.pool.query<RunRecord>('SELECT * FROM runs WHERE id=$1',[runId])).rows[0] as import('../src/modules/runs/repository.js').AgentRunRecord;
    const engine=core(r),call={id:randomUUID(),name:r.definition.id,arguments:{name:'Agent'}};
    const invoke=(a:Parameters<OperationExecutor['execute']>[2])=>engine.execute(call.name,call.arguments,a,call.id,call.id);
    expect((await dispatchRunOperation(config,run,call,r.definition,invoke)).httpStatus).toBe(200);
    expect((await dispatchRunOperation(config,run,call,r.definition,invoke)).body).toMatchObject({replayed:true});
    const invalid={...call,id:randomUUID(),arguments:{name:42}};
    expect((await dispatchRunOperation(config,run,invalid,r.definition,invoke)).httpStatus).toBe(422);
    await db.pool.query("UPDATE runs SET permission_snapshot_json='{}'::jsonb WHERE id=$1",[runId]);
    expect((await dispatchRunOperation(config,run,{...call,id:randomUUID()},r.definition,invoke)).httpStatus).toBe(404);
    // The actual transport's opt-in branch must also record a refusal for the user-only catalog.
    await new CliAgentToolTransport(config).call(run,{id:randomUUID(),name:'system.actions.list',arguments:{}});
    const events=(await db.pool.query('SELECT event_type,error_code,metadata_json FROM run_events WHERE run_id=$1 ORDER BY created_at,id',[runId])).rows;
    expect(events.filter(e=>e.event_type==='action_invoked')).toHaveLength(2);
    expect(events.filter(e=>e.event_type==='action_completed')).toHaveLength(5);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({error_code:'operation_invalid_input'}),expect.objectContaining({error_code:'operation_not_found'})]));
    expect((await db.pool.query('SELECT version FROM project_operations WHERE id=$1',[operation])).rows[0].version).toBe(3);
  });
});


describe('audit recovery transaction ownership',()=>{
  it('does not duplicate a committed audit when the transaction owner loses its success response',async()=>{
    const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}), marker=randomUUID();
    await expect(withPolicyAuditRecovery(db.connectionUri,async()=>{
      await withTransaction(db.pool,async tx=>{
        const policy=await enforce({...config,auditTransaction:tx},await loadActionRegistry(),{
          action:'runtime.execute',actor_type:'user',actor_id:owner,space_id:space,resource_space_id:space,
          resource_type:'project',resource_id:project,force_record:true,metadata_json:{operation_request_id:marker}
        });
        expect(policy.status).toBe('allow');
      });
      throw new Error('simulated lost commit response');
    })).rejects.toThrow('simulated');
    const audits=(await db.pool.query("SELECT metadata_json FROM policy_decision_records WHERE metadata_json->>'operation_request_id'=$1",[marker])).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata_json.operation_outcome).toBeUndefined();
  });

  it('refuses mapped external-transaction acceptance without a recovery owner',async()=>{
    const {r,engine,service}=approvalFixture();
    const pending=await engine.execute(r.definition.id,{name:'never'},actor(),'pending',randomUUID());
    const id=(pending.body as {proposal_id:string}).proposal_id;
    await expect(withTransaction(db.pool,tx=>service.acceptInTransaction(tx,id,{spaceId:space,userId:owner}))).rejects.toMatchObject({statusCode:503});
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].state).toBe('pending_approval');
  });
});


describe('joined service failure compatibility',()=>{
  it('contains a real note retrieval SQL failure without poisoning the core transaction',async()=>{
    await db.pool.query(`CREATE FUNCTION reject_note_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected projection failure'; END $$`);
    await db.pool.query('CREATE TRIGGER reject_note_projection BEFORE INSERT ON retrieval_objects FOR EACH ROW EXECUTE FUNCTION reject_note_projection()');
    let note='';
    try {
      const r=registration(async(tx,input,a)=>{
        note=(await withNoteWrites(tx,scope=>scope.create({spaceId:space,actor:{userId:owner},title:'Resilient',doc:{type:'doc',content:[]},primaryProjectId:project}))).id;
        return update(tx,input,a);
      });
      expect((await core(r).execute(r.definition.id,{name:'Committed'},actor(),'note-failure',randomUUID())).http_status).toBe(200);
      expect((await db.pool.query('SELECT title FROM space_objects WHERE id=$1',[note])).rows[0].title).toBe('Resilient');
      expect((await db.pool.query('SELECT title FROM project_operations WHERE id=$1',[operation])).rows[0].title).toBe('Committed');
      expect((await db.pool.query('SELECT object_id FROM retrieval_objects WHERE object_id=$1',[note])).rows).toHaveLength(0);
    } finally {
      await db.pool.query('DROP TRIGGER reject_note_projection ON retrieval_objects');
      await db.pool.query('DROP FUNCTION reject_note_projection()');
    }
  });
  it.each([409,422] as const)('classifies approved domain HttpError %s through the same safe registration',async status=>{
    const {r,engine}=approvalFixture(),registry=new ProposalApplierRegistry();
    r.classifyError=error=>error instanceof HttpError && error.statusCode===status && (error.responseBody as {code?:string})?.code==='fixture_domain_failure'
      ? new OperationBusinessError(status===409?'operation_conflict':'operation_invalid_input',status,'project_operations') : undefined;
    registry.register('project_brief_publish',async({db:tx})=>{await update(tx,{name:'Never'},actor());throw new HttpError(status,'PRIVATE exception',{code:'fixture_domain_failure',secret:'PRIVATE'});});
    const pending=await engine.execute(r.definition.id,{name:'Never'},actor(),'pending',randomUUID());
    const id=(pending.body as {proposal_id:string}).proposal_id;
    const result=await operationProposalService(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),registry,engine.registrations).accept(id,{spaceId:space,userId:owner});
    expect(result).toMatchObject({result_type:'operation_failure'});
    const stored=(await db.pool.query('SELECT state,http_status,result_json FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0];
    expect(stored).toMatchObject({state:'failed',http_status:status});
    expect(JSON.stringify(stored)).not.toContain('PRIVATE');
    expect((await db.pool.query('SELECT title FROM project_operations WHERE id=$1',[operation])).rows[0].title).toBe('Research');
  });
});


it('recovers an aborted policy denial under its original known decision id',async()=>{
  let denialId: string | null | undefined;
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  await expect(withPolicyAuditRecovery(db.connectionUri,()=>withTransaction(db.pool,async tx=>{
    const result=await enforce({...config,auditTransaction:tx},await loadActionRegistry(),{
      action:'runtime.execute',actor_type:'user',actor_id:owner,space_id:space,resource_space_id:space,
      force_record:true,context:{agent_status:'paused'}
    });
    expect(result.status).toBe('blocked');
    denialId=result.policy_decision_record_id;
    throw new Error('denial rollback');
  }))).rejects.toThrow('denial rollback');
  expect(denialId).toBeTruthy();
  expect((await db.pool.query('SELECT decision,metadata_json FROM policy_decision_records WHERE id=$1',[denialId])).rows[0]).toMatchObject({decision:'deny',metadata_json:{operation_outcome:'failed'}});
});


it('keeps terminal cleanup independent of corrupt pending reconciliation budget',async()=>{
  const fixture=approvalFixture();
  const pending=await fixture.engine.execute(fixture.r.definition.id,{name:'pending'},actor(),'pending',randomUUID());
  await db.pool.query("UPDATE proposals SET status='accepted' WHERE id=$1",[(pending.body as {proposal_id:string}).proposal_id]);
  const r=registration(update);
  await core(r).execute(r.definition.id,{name:'terminal'},actor(),'terminal',randomUUID());
  await db.pool.query("UPDATE operation_idempotency SET terminal_at=now()-interval '8 days' WHERE space_id=$1 AND state='succeeded'",[space]);
  expect(await pruneOperationRequests(db.pool,1)).toMatchObject({deleted:1,inconsistent:1});
});
it('refuses leaking default transaction session settings through a pooled operation port',async()=>{
  const r=registration(async tx=>{
    for(const sql of ["SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY","SET default_transaction_read_only=on","SET SESSION default_transaction_isolation='serializable'","RESET default_transaction_read_only","RESET ALL","SELECT set_config('default_transaction_read_only','on',false)"])
      await expect(tx.query(sql)).rejects.toThrow('session settings refused');
    await expect(tx.query(String.raw`SELECT pg_catalog.U&"set\005fconfig"('application_name','leak',false)`)).rejects.toThrow('identifiers refused');
    for (const sql of [
      `UPDATE pg_settings SET setting='on' WHERE name='default_transaction_read_only'`,
      `UPDATE pg_catalog."pg_settings" SET setting='public' WHERE name='search_path'`,
      `WITH settings AS (UPDATE pg_settings SET setting='leak' WHERE name='application_name') SELECT 1`,
      'SELECT setseed(0.5)',
      'SELECT pg_catalog."setseed"(0.5)',
    ]) await expect(tx.query(sql)).rejects.toThrow('session settings refused');
    return {name:'safe',version:1};
  });
  expect((await core(r).execute(r.definition.id,{name:'safe'},actor(),'session',randomUUID())).http_status).toBe(200);
});

it('recovers core failure audit with its original transactional decision id',async()=>{
  let original='';
  const r=registration(async tx=>{
    original=(await tx.query<{id:string}>('SELECT id FROM policy_decision_records WHERE space_id=$1 ORDER BY created_at DESC LIMIT 1',[space])).rows[0].id;
    throw new Error('private failure');
  });
  const response=await core(r).execute(r.definition.id,{name:'bad'},actor(),'failure',randomUUID());
  expect(response.http_status).toBe(500);expect(response.policy_decision_record_id).toBe(original);
  expect((await db.pool.query('SELECT id FROM policy_decision_records WHERE space_id=$1',[space])).rows).toHaveLength(1);
});


describe('final acceptance: canonical approval races and compatibility',()=>{
  it('serializes concurrent accept/reject and replays an accepted result without a second applier call',async()=>{
    const {r,engine}=approvalFixture(),registry=new ProposalApplierRegistry();
    let enter!:()=>void,release!:()=>void,calls=0;
    const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    registry.register('project_brief_publish',async({db:tx,proposal})=>{calls++;enter();await gate;return {result_type:'project_brief_version',result:await update(tx,{name:proposal.payload_json?.name},actor()) as Record<string,unknown>};});
    const service=operationProposalService(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),registry,engine.registrations),key=randomUUID();
    const pending=await engine.execute(r.definition.id,{name:'approved once'},actor(),'pending',key),id=(pending.body as {proposal_id:string}).proposal_id;
    const accepting=service.accept(id,{spaceId:space,userId:owner});await entered;
    try {
      await expect(service.accept(id,{spaceId:space,userId:owner})).rejects.toMatchObject({code:'idempotency_in_progress',httpStatus:409,retryable:true});
      await expect(service.reject(id,{spaceId:space,userId:owner})).rejects.toMatchObject({code:'idempotency_in_progress',httpStatus:409,retryable:true});
    } finally {release();}
    await accepting;
    expect(await service.accept(id,{spaceId:space,userId:owner})).toBeNull();
    expect((await engine.execute(r.definition.id,{name:'approved once'},actor(),'lost-response-retry',key)).body).toMatchObject({data:{name:'approved once'}});
    expect(calls).toBe(1);
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[id])).rows[0].status).toBe('accepted');
  });
  it('approval output failure rolls back domain, decision and request together, then a valid retry applies once',async()=>{
    const {r,engine}=approvalFixture(),registry=new ProposalApplierRegistry(),key=randomUUID();
    const pending=await engine.execute(r.definition.id,{name:'atomic'},actor(),'pending',key),id=(pending.body as {proposal_id:string}).proposal_id;
    registry.register('project_brief_publish',async({db:tx})=>{await update(tx,{name:'must rollback'},actor());return {result_type:'project_brief_version',result:{private:'invalid'}};});
    const service=operationProposalService(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),registry,engine.registrations);
    await expect(service.accept(id,{spaceId:space,userId:owner})).rejects.toMatchObject({code:'operation_invalid_output'});
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].state).toBe('pending_approval');
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[id])).rows[0].status).toBe('pending');
    expect((await db.pool.query('SELECT title FROM project_operations WHERE id=$1',[operation])).rows[0].title).toBe('Research');
    const valid=new ProposalApplierRegistry();valid.register('project_brief_publish',async({db:tx})=>({result_type:'project_brief_version',result:await update(tx,{name:'atomic'},actor()) as Record<string,unknown>}));
    await operationProposalService(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),valid,engine.registrations).accept(id,{spaceId:space,userId:owner});
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].state).toBe('succeeded');
  });
  it('missing mapping or revoked requester cannot consume pending approval; a version drift supersedes atomically',async()=>{
    const {r,engine,service}=approvalFixture(),key=randomUUID();
    const pending=await engine.execute(r.definition.id,{name:'never'},actor(),'pending',key),id=(pending.body as {proposal_id:string}).proposal_id;
    const missingRegistry=new ProposalApplierRegistry();missingRegistry.register('project_brief_publish',async()=>{throw new Error('missing mapping must not apply');});
    const empty=operationProposalService(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),missingRegistry,new Map());
    await expect(empty.accept(id,{spaceId:space,userId:owner})).rejects.toMatchObject({code:'operation_approval_mapping_unavailable'});
    await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,owner]);
    await expect(service.accept(id,{spaceId:space,userId:owner})).rejects.toMatchObject({code:'operation_not_found'});
    await db.pool.query("UPDATE space_memberships SET status='active' WHERE space_id=$1 AND user_id=$2",[space,owner]);
    r.definition={...r.definition,version:r.definition.version+1};
    await service.accept(id,{spaceId:space,userId:owner});
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].state).toBe('superseded');
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[id])).rows[0].status).toBe('superseded');
    expect((await db.pool.query('SELECT title FROM project_operations WHERE id=$1',[operation])).rows[0].title).toBe('Research');
  });
  it('incompatible operation versions and redacted receipts never reexecute business work',async()=>{
    let calls=0;const r=registration(async(...args)=>{calls++;return update(...args);}),key=randomUUID();
    const engine=core(r);await engine.execute(r.definition.id,{name:'once'},actor(),'first',key);
    expect((await engine.execute(r.definition.id,{name:'once'},actor(),'wrong-version',key,99)).http_status).toBe(422);
    const newer={...r,definition:{...r.definition,version:2}};
    expect((await core(newer).execute(r.definition.id,{name:'once'},actor(),'unsupported',key)).body).toMatchObject({error:{code:'operation_version_unsupported'}});
    await db.pool.query('UPDATE operation_idempotency SET result_json=NULL WHERE space_id=$1',[space]);
    expect((await engine.execute(r.definition.id,{name:'once'},actor(),'redacted',key)).http_status).toBe(410);expect(calls).toBe(1);
  });
});


it('expiry cleanup and canonical decision use the same non-waiting key order',async()=>{
  const {r,engine,service}=approvalFixture(),key=randomUUID();
  const pending=await engine.execute(r.definition.id,{name:'expire'},actor(),'pending',key),id=(pending.body as {proposal_id:string}).proposal_id;
  await db.pool.query("UPDATE proposals SET expires_at=now()-interval '1 second' WHERE id=$1",[id]);
  const row=(await db.pool.query('SELECT * FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0];
  const scope=[row.space_id,row.principal_kind,row.principal_id,row.on_behalf,row.authority_scope_id,row.operation_id,row.idempotency_key] as string[];
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const holder=withTransaction(db.pool,async tx=>{await reserve(tx,scope);enter();await gate;});await entered;
  try {
    await pruneOperationRequests(db.pool);
    await expect(service.accept(id,{spaceId:space,userId:owner})).rejects.toMatchObject({code:'idempotency_in_progress'});
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].state).toBe('pending_approval');
  } finally {release();await holder;}
  await pruneOperationRequests(db.pool);expect(await service.accept(id,{spaceId:space,userId:owner})).toBeNull();
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].state).toBe('expired');
  expect((await db.pool.query('SELECT title FROM project_operations WHERE id=$1',[operation])).rows[0].title).toBe('Research');
});
it('a mapped supersession transition and its request reconcile commit or roll back together',async()=>{
  const {r,engine}=approvalFixture();
  const pending=await engine.execute(r.definition.id,{name:'never'},actor(),'pending',randomUUID()),id=(pending.body as {proposal_id:string}).proposal_id;
  const row=(await db.pool.query('SELECT * FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0];
  const scope=[row.space_id,row.principal_kind,row.principal_id,row.on_behalf,row.authority_scope_id,row.operation_id,row.idempotency_key] as string[];
  const transition=async(tx:Parameters<OperationRegistration['execute']>[0])=>{const locked=await reserve(tx,scope);await tx.query("UPDATE proposals SET status='superseded' WHERE id=$1",[id]);await reconcile(tx,locked!);};
  await expect(withTransaction(db.pool,async tx=>{await transition(tx);throw new Error('rollback');})).rejects.toThrow('rollback');
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[id])).rows[0].status).toBe('pending');
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].state).toBe('pending_approval');
  await withTransaction(db.pool,transition);
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].state).toBe('superseded');
});
it('content query withdraws a previously allowed Source and records B11 only for released content',async()=>{
  const other=randomUUID(),connection=randomUUID();await seedSpaceMember(db.pool,{space,user:other});
  await seedArxivSourceChain(db.pool,{space,owner:other,connector:randomUUID(),connection,channel:randomUUID(),now:new Date().toISOString()});
  await db.pool.query("UPDATE source_connections SET visibility='space_shared',policy_json=policy_json||jsonb_build_object('source_egress_configured',true),consent_json=consent_json||jsonb_build_object('allowed_reader_user_ids',jsonb_build_array($2::text),'allow_space_admins',false) WHERE id=$1",[connection,owner]);
  const r=registration(async tx=>({name:(await tx.query<{name:string}>('SELECT name FROM source_connections WHERE id=$1',[connection])).rows[0].name,version:1}),'query');
  r.readKind='content';
  r.authorize=async tx=>{if(await contentDecisionFromDb(tx,{spaceId:space,userId:owner},'source_connection',connection,{includeOversight:false})!=='full')throw hidden();await assertSourceEgressAllowedForDestination(tx,(await tx.query<SourceConnectionRow>('SELECT * FROM source_connections WHERE id=$1',[connection])).rows[0],'local_provider');};
  r.readAudit=async audit=>{await audit.recordReads('source_connection',[connection]);};
  const engine=core(r);expect((await engine.execute(r.definition.id,{name:'read'},actor(),'before')).http_status).toBe(200);
  await db.pool.query("UPDATE source_connections SET consent_json=consent_json||jsonb_build_object('allow_local_provider_egress',false,'allow_external_model_egress',false) WHERE id=$1",[connection]);
  const blocked=await engine.execute(r.definition.id,{name:'read'},actor(),'after');expect(blocked.http_status).toBe(404);expect(blocked.body).not.toHaveProperty('data');
  await db.pool.query("UPDATE source_connections SET visibility='private',consent_json=consent_json||jsonb_build_object('allow_local_provider_egress',true) WHERE id=$1",[connection]);
  expect((await engine.execute(r.definition.id,{name:'read'},actor(),'audience-narrowed')).http_status).toBe(404);
  expect((await db.pool.query('SELECT id FROM content_access_logs WHERE resource_id=$1',[connection])).rows).toHaveLength(1);
});
it('production composition enables no approval mapping and legacy metadata cannot open generic writes',async()=>{
  __setAuthIdentityForTests({spaceId:space,userId:owner});
  const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[systemActionsModule]);
  try {
    for(const definition of SYSTEM_ACTION_REGISTRY.filter(d=>d.proposal_type && !d.execution)) {
      const response=await app.inject({method:'POST',url:`/api/v1/actions/${definition.id}`,headers:{'idempotency-key':randomUUID()},payload:{}});
      expect(response.statusCode,definition.id).toBe(404);
    }
    const catalog=(await app.inject({method:'GET',url:'/api/v1/queries/system.actions.list'})).json();
    expect(catalog.data.actions.map((a:{id:string})=>a.id).sort()).toEqual(['research.cancel_acquisition','system.actions.list']);
  } finally {await app.close();}
});


it('query policy denial persists independently and never executes its reader',async()=>{
  let called=false;const r=registration(async()=>{called=true;return {name:'secret',version:1};},'query');
  r.definition={...r.definition,policy_action:'runtime.execute'};r.policyContext=()=>({agent_status:'paused'});
  const denied=await core(r).execute(r.definition.id,{name:'read'},actor(),'query-denied');
  expect(denied.http_status).toBe(404);expect(called).toBe(false);expect(denied.body).not.toHaveProperty('data');
  expect((await db.pool.query("SELECT decision FROM policy_decision_records WHERE space_id=$1",[space])).rows).toEqual([{decision:'deny'}]);
});
it('mandatory approval audit failure leaves both pending and retries through canonical apply once',async()=>{
  const {r,engine,service}=approvalFixture();const pending=await engine.execute(r.definition.id,{name:'after audit restored'},actor(),'pending',randomUUID()),id=(pending.body as {proposal_id:string}).proposal_id;
  await db.pool.query("CREATE FUNCTION refuse_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test approval audit unavailable'; END $$");
  await db.pool.query('CREATE TRIGGER refuse_approval_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION refuse_approval_audit()');
  try {
    await expect(service.accept(id,{spaceId:space,userId:owner})).rejects.toMatchObject({statusCode:500});
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].state).toBe('pending_approval');
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[id])).rows[0].status).toBe('pending');
    expect((await db.pool.query('SELECT title FROM project_operations WHERE id=$1',[operation])).rows[0].title).toBe('Research');
  } finally {await db.pool.query('DROP TRIGGER refuse_approval_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_approval_audit()');}
  await service.accept(id,{spaceId:space,userId:owner});
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1',[id])).rows[0].state).toBe('succeeded');
});


it('isolates the same Agent/key by instructing person and reauthorizes a revoked replay',async()=>{
  const other=randomUUID(),agent=randomUUID(),firstRun=randomUUID(),secondRun=randomUUID(),version=randomUUID(),key=randomUUID();
  await seedSpaceMember(db.pool,{space,user:other});
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,other]);
  await seedRun(db.pool,{id:firstRun,space,owner,agent,version});await seedRun(db.pool,{id:secondRun,space,owner:other,agent,version,existingAgent:true});
  const r=registration(update);r.definition={...r.definition,allowed_actor_types:['agent'],visibility:new Set(['agent_tool'])};
  for(const [id,user] of [[firstRun,owner],[secondRun,other]])await db.pool.query("UPDATE runs SET status='running',project_id=$2,instructed_by_user_id=$3,permission_snapshot_json=$4::jsonb WHERE id=$1",[id,project,user,JSON.stringify({tool_grants:[{action_id:r.definition.id}]})]);
  r.authorize=async(tx,_input,a)=>assertProjectWriterForMutation(tx,a.space_id,project,a.on_behalf_of_user_id!);
  const first=await runActor(db.pool,(await db.pool.query<RunRecord>('SELECT * FROM runs WHERE id=$1',[firstRun])).rows[0]);
  const second=await runActor(db.pool,(await db.pool.query<RunRecord>('SELECT * FROM runs WHERE id=$1',[secondRun])).rows[0]);
  const engine=core(r);
  expect((await engine.execute(r.definition.id,{name:'first-person'},first,'first',key)).http_status).toBe(200);
  expect((await engine.execute(r.definition.id,{name:'second-person'},second,'second',key)).http_status).toBe(200);
  expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1 AND idempotency_key=$2',[space,key])).rows).toHaveLength(2);
  expect((await engine.execute(r.definition.id,{name:'first-person'},first,'first-retry',key)).body).toMatchObject({data:{name:'first-person'}});
  await db.pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[project,other]);
  expect((await engine.execute(r.definition.id,{name:'second-person'},second,'revoked',key)).http_status).toBe(404);
});
