import { randomUUID } from 'node:crypto';
import { beforeEach } from 'vitest';
import { useTestDatabase } from './testDatabase.js';
import { resetTables } from './resetTables.js';
import { seedSpaceOwnerProject, seedAgentWithVersion } from './domainSeeds.js';
import { seedArxivSourceChain } from './researchSeeds.js';
import { ProjectMonitoringService } from '../../src/modules/projects/monitoring/service.js';
import { ProjectSourceBindingService } from '../../src/modules/projects/projectSourceBindingService.js';
import { PgProposalApplyService } from '../../src/modules/proposals/applyService.js';
import { loadConfig } from '../../src/config.js';
import { ProjectMonitoringConfigSchema } from '@rainver/protocol';
export function monitoringFixture(filename: string) {
  const db = useTestDatabase(filename);
  const space = randomUUID(),
    owner = randomUUID(),
    project = randomUUID(),
    agent = randomUUID(),
    channel = randomUUID(),
    connection = randomUUID();
  const identity = {
    spaceId: space,
    userId: owner
  };
  const limits = {
    candidates: 2,
    pages: 2,
    source_requests: 4,
    model_runs: 4
  };
  function config() {
    return loadConfig({
      SERVER_DATABASE_URL: db.connectionUri,
      ARTIFACT_STORAGE_ROOT: '/tmp/rainver-p3-artifacts'
    });
  }
  function service() {
    return new ProjectMonitoringService(db.pool, config());
  }
  function scope() {
    return ProjectMonitoringConfigSchema.parse({
      objective: 'Research on reliable agents',
      include: ['agents'],
      exclude: ['advertising'],
      source_channel_id: channel,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-10-24T23:59:59.000Z',
      total_candidates: 3,
      batch: limits,
      daily: limits,
      recommendation_count: 1,
      language: 'English',
      timezone: 'UTC',
      evidence_depth: 'abstract',
      agent_id: agent
    });
  }
  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(db.pool, ['spaces', 'users', 'source_connectors', 'source_providers', 'source_provider_connectors'], {
      cascade: true
    });
    const {
      now
    } = await seedSpaceOwnerProject(db.pool, {
      space,
      owner,
      project,
      spaceType: 'team'
    });
    await seedAgentWithVersion(db.pool, {
      agent,
      version: randomUUID(),
      space,
      owner
    });
    await seedArxivSourceChain(db.pool, {
      connector: randomUUID(),
      connection,
      channel,
      space,
      owner,
      now
    });
    await db.pool.query(`UPDATE source_connections SET project_id=$2,visibility='space_shared' WHERE id=$1`, [connection, project]);
    await db.pool.query(`UPDATE source_channels SET fetch_frequency='manual' WHERE id=$1`, [channel]);
    await db.pool.query(`INSERT INTO source_search_specs(id,space_id,source_channel_id,provider_key,compiled_provider_query_json,query_fingerprint,active_version,activated_at,created_at,updated_at) VALUES($1,$2,$3,'arxiv',$4::jsonb,'monitoring-query',1,now(),now(),now())`, [randomUUID(), space, channel, JSON.stringify({
      search_query: 'all:agents',
      max_results: 2,
      sort_by: 'submittedDate',
      sort_order: 'descending'
    })]);
    await new ProjectSourceBindingService(db.pool).createBinding(identity, {
      project_id: project,
      source_channel_id: channel,
      standing_comparison_enabled: false
    });
  });

  async function propose(scopeConfig = scope()) {
    return service().propose(identity, project, {
      config: scopeConfig,
      expected_active_version_id: null,
      idempotency_key: 'scope-v1'
    });
  }
  async function accept(scopeConfig = scope()) {
    const result = await propose(scopeConfig);
    const draft = (await service().state(identity, project)).draft!;
    const apply = new PgProposalApplyService(config());
    for (const dep of result.dependencies ?? []) await apply.accept(String(dep.id), identity);
    await apply.accept(String(result.proposal.id), identity);
    await service().setPaused(identity, project, draft.id, false);
    return (await service().state(identity, project)).active!;
  }
  return {
    db,
    space,
    owner,
    project,
    agent,
    channel,
    connection,
    identity,
    limits,
    config,
    service,
    scope,
    propose,
    accept
  };
}
