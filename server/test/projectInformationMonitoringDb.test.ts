import { PgSchedulerTaskStore } from '../src/modules/scheduler/taskStore.js';
import { monitoringFixture } from './support/monitoringFixture.js';
import { buildSourceSchedulerTasks } from '../src/modules/scheduler/sourceTasks.js';
import { SchedulerRegistry } from '../src/modules/scheduler/registry.js';
import { seedMainlineRoomsForAllProjects } from './support/domainSeeds.js';
import { monitoringRecentCoverage } from '../src/modules/sources/monitoring/coverage.js';
import { enqueueDueMonitoring } from '../src/modules/sources/monitoring/heartbeat.js';
import { InformationDigestService } from '../src/modules/informationDigest/service.js';
import { digestPeriod } from '../src/modules/informationDigest/digestPeriod.js';
import { monitoringAcquisitionPlans } from '../src/modules/sources/monitoring/recent.js';
import { JobWorker } from '../src/modules/jobs/worker.js';
import { JobHandlerRegistry } from '../src/modules/jobs/handlerRegistry.js';
import { PgJobQueueRepository } from '../src/modules/jobs/repository.js';
import { seedRun } from './support/domainSeeds.js';
import { PgFrontendSupportService } from '../src/modules/frontendSupport/service.js';
import { registerProjectsSystemActionExecutors } from '../src/modules/projects/projectsSystemActionExecutors.js';
import type { SystemActionExecutor } from '../src/modules/systemActions/gateway.js';
import type { SystemActionId } from '@rainver/protocol';
import type { RunRecord } from '../src/modules/runs/repository.js';
import { updateSpaceRetrievalSettings } from '../src/modules/retrieval/settings.js';
import { tryWithDedicatedSessionAdvisoryLock } from '../src/db/advisoryLock.js';
import { listRunningProjectOperations } from '../src/modules/projects/runningOperations.js';
import { SourceAnnotationService } from '../src/modules/sourceAnnotation/service.js';
import { RunOrchestrationService } from '../src/modules/runs/orchestrationService.js';
import { SourceChannelService } from '../src/modules/sources/channels/sourceChannelService.js';
import { SourceExtractionWorker } from '../src/modules/sources/extractionWorker.js';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ProjectMonitoringService } from '../src/modules/projects/monitoring/service.js';
import { ProjectSourceBindingService } from '../src/modules/projects/projectSourceBindingService.js';
import { PgProposalApplyService } from '../src/modules/proposals/applyService.js';
import { buildModuleServer } from './support/moduleServer.js';
import { projectsModule } from '../src/modules/projects/index.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { MonitoringDetailsSchema, MonitoringRunRequestSchema } from '@rainver/protocol';
import { monitoringChannel, consumeMonitoringBudget } from '../src/modules/projects/monitoring/budget.js';
import { PgSourceAnnotationRepository } from '../src/modules/sourceAnnotation/repository.js';
import { SourceBackfillExecutionService } from '../src/modules/sources/sourceBackfillExecutionService.js';
import { registerMonitoringJob, executeMonitoringOperation } from '../src/modules/projects/monitoring/worker.js';
import { SourcePostProcessingService } from '../src/modules/sources/postProcessing/service.js';
import { seedSpaceMember } from './support/domainSeeds.js';
import { publicAddressGuard } from './support/outboundGuard.js';
import { __setArxivThrottleForTests } from '../src/modules/sources/connectors/arxivThrottle.js';
const {db,space,owner,project,agent,channel,connection,identity,limits,config,service,scope,propose,accept} = monitoringFixture(import.meta.filename);
afterEach(() => {
  __setAuthIdentityForTests(null);
  vi.restoreAllMocks();
  __setArxivThrottleForTests(null);
});
describe('Project bounded manual information monitoring', () => {
  it('rejects a future arXiv history endpoint before recording proposals',async()=>{
    await expect(propose({...scope(),to:new Date(Date.now()+86400000).toISOString()})).rejects.toThrow(/future/);
    expect((await db.pool.query(`SELECT id FROM proposals WHERE space_id=$1`,[space])).rows).toHaveLength(0);
  });
  it('checks recent arXiv material manually after the confirmed history is exhausted without enabling a schedule',async()=>{
    const version=await accept();
    __setArxivThrottleForTests({minIntervalMs:0});
    await db.pool.query(`UPDATE source_backfill_segments SET status='succeeded',window_json=window_json||'{"exhausted":true,"partial":false}'::jsonb WHERE plan_id=$1`,[version.backfill_plan_id]);
    await db.pool.query(`UPDATE source_backfill_plans SET status='completed' WHERE id=$1`,[version.backfill_plan_id]);
    const http=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>',{headers:{'content-type':'application/atom+xml'}}));
    const op=await service().start(identity,project,{version_id:version.id,config_hash:version.config_hash,kind:'check',idempotency_key:'manual-recent'});
    await executeMonitoringOperation(db.pool,config(),space,op.id,publicAddressGuard);
    expect(http).toHaveBeenCalledTimes(1);
    const state=await service().state(identity,project);
    expect(state.latest_run?.progress.coverage).toBe('no_new');
    expect(state.active?.config.schedule).toBeUndefined();
    const plan=(await db.pool.query(`SELECT strategy_json FROM source_backfill_plans WHERE space_id=$1 AND strategy_json->>'monitoring_purpose'='recent'`,[space])).rows[0];
    expect(plan.strategy_json.from).toBe(version.config.to);
    expect(plan.strategy_json.max_items).toBe(version.config.total_candidates);
  });

  it('reports exhausted daily quota when a new recent window cannot dispatch after history completed',async()=>{
    const version=await accept();__setArxivThrottleForTests({minIntervalMs:0});
    const http=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>',{headers:{'content-type':'application/atom+xml'}}));
    for(const kind of ['initial','check'] as const){
      const op=await service().start(identity,project,{version_id:version.id,config_hash:version.config_hash,kind,idempotency_key:kind});
      await executeMonitoringOperation(db.pool,config(),space,op.id,publicAddressGuard);
    }
    expect(http).toHaveBeenCalledTimes(1);
    expect((await service().state(identity,project)).latest_run?.progress.reason).toBe('quota_paused');
  });
  it('requires owner history approval and leaves all work manual until an explicit run', async () => {
    const result = await propose();
    expect(await monitoringChannel(db.pool, space, channel)).toBe(false);
    const reused = await propose();
    expect(reused.proposal.id).toBe(result.proposal.id);
    const apply = new PgProposalApplyService(config());
    await expect(apply.accept(String(result.proposal.id), identity)).rejects.toThrow(/Backfill approval/);
    const plan = (await service().state(identity, project)).draft!.backfill_plan_id!;
    expect(await new SourceBackfillExecutionService(db.pool).executeNext(space, plan)).toBeNull();
    for (const dep of result.dependencies ?? []) await apply.accept(String(dep.id), identity);
    await apply.accept(String(result.proposal.id), identity);
    const state = await service().state(identity, project);
    expect(state.paused).toBe(true);
    expect((await db.pool.query(`SELECT id FROM extraction_jobs WHERE space_id=$1`, [space])).rows).toHaveLength(0);
    expect((await db.pool.query(`SELECT object_id FROM project_research_workflows WHERE space_id=$1`, [space])).rows).toHaveLength(0);
    expect((await db.pool.query(`SELECT fetch_frequency FROM source_channels WHERE id=$1`, [channel])).rows[0].fetch_frequency).toBe('manual');
  });
  it('rejects detail smuggling, raised execution limits and stale starts without side effects', async () => {
    const version = await accept();
    expect(MonitoringDetailsSchema.safeParse({
      expected_version_id: version.id,
      evidence_depth: 'full'
    }).success).toBe(false);
    expect(MonitoringDetailsSchema.safeParse({
      expected_version_id: version.id,
      objective: 'different'
    }).success).toBe(false);
    await expect(service().details(identity, project, {
      expected_version_id: version.id,
      batch: {
        ...limits,
        candidates: 3
      }
    })).rejects.toThrow(/increase/);
    const next = await service().details(identity, project, {
      expected_version_id: version.id,
      language: '中文',
      recommendation_count: 2
    });
    await expect(service().start(identity, project, MonitoringRunRequestSchema.parse({
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'old'
    }))).rejects.toThrow(/not confirmed/);
    expect(next.backfill_plan_id).toBe(version.backfill_plan_id);
  });
  it('shares atomic daily admission across runs and does not reset it after a detail change', async () => {
    const version = await accept();
    const body = {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'initial'
    };
    const first = await service().start(identity, project, body);
    expect((await service().start(identity, project, body)).id).toBe(first.id);
    const attempts = await Promise.allSettled([consumeMonitoringBudget(db.pool, space, first.id, 'source_requests', 3), consumeMonitoringBudget(db.pool, space, first.id, 'source_requests', 3)]);
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await service().details(identity, project, {
      expected_version_id: version.id,
      language: '中文'
    });
    await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`, [first.id]);
    const active = (await service().state(identity, project)).active!;
    const next = await service().start(identity, project, {
      ...body,
      version_id: active.id,
      config_hash: active.config_hash,
      idempotency_key: 'next'
    });
    await expect(consumeMonitoringBudget(db.pool, space, next.id, 'source_requests', 2)).rejects.toThrow(/budget_exhausted/);
  });
  it('enqueues an old newly associated item for annotation and excludes it from automatic annotation', async () => {
    const version = await accept();
    const item = randomUUID();
    await db.pool.query(`INSERT INTO source_items(id,space_id,project_id,connection_id,owner_user_id,visibility,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'space_shared','feed_entry','Old agents paper','2026-02-01','2026-02-01','metadata_only','metadata_only',now(),now())`, [item, space, project, connection, owner]);
    await db.pool.query(`INSERT INTO source_channel_item_links(id,space_id,source_channel_id,source_item_id,status,matched_at,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now(),now())`, [randomUUID(), space, channel, item]);
    const annotations = new PgSourceAnnotationRepository(db.pool);
    await annotations.enqueueMonitoringItems(space, channel, [item]);
    expect(await annotations.loadPendingBatch(space, 10)).toEqual([]);
    expect((await annotations.loadPendingBatch(space, 10, [item])).map(r => r.id)).toEqual([item]);
    expect(version.rule_id).toBeTruthy();
    const operation = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'annotation-quota'
    });
    await consumeMonitoringBudget(db.pool, space, operation.id, 'model_runs', 4);
    await expect(new SourceAnnotationService(db.pool, config()).annotatePendingBatch(space, {
      itemIds: [item],
      agentId: agent,
      operationId: operation.id,
      projectId: project,
      userId: owner
    })).rejects.toThrow(/monitoring_budget_exhausted/);
    expect((await db.pool.query(`SELECT attempt_count FROM source_item_annotations WHERE source_item_id=$1`, [item])).rows[0].attempt_count).toBe(0);
  });
  it('keeps ordinary research-linked or daily channels out of monitoring reuse', async () => {
    await db.pool.query(`UPDATE source_channels SET fetch_frequency='daily' WHERE id=$1`, [channel]);
    await expect(propose()).rejects.toThrow(/manual supported/);
    expect((await db.pool.query(`SELECT id FROM project_information_monitoring_versions WHERE space_id=$1`, [space])).rows).toEqual([]);
  });
  it('keeps initial delivery distinct from immutable daily Digests, with candidates, sources and private feedback', async () => {
    const version = await accept();
    __setArxivThrottleForTests({
      minIntervalMs: 0
    });
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2601.00001v1</id><title>Reliable agents</title><summary>Agents improve reliability.</summary><published>2026-02-01T00:00:00Z</published><updated>2026-02-01T00:00:00Z</updated><author><name>A</name></author></entry><entry><id>http://arxiv.org/abs/2601.00002v1</id><title>Advertising</title><summary>Advertising platforms.</summary><published>2026-02-02T00:00:00Z</published><updated>2026-02-02T00:00:00Z</updated><author><name>B</name></author></entry></feed>`;
    const http = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(atom, {
      status: 200,
      headers: {
        'content-type': 'application/atom+xml'
      }
    }));
    let annotationCalls = 0,
      relevanceCalls = 0;
    vi.spyOn(RunOrchestrationService.prototype, 'executeRun').mockImplementation(async input => {
      const run = await db.pool.query<{
        prompt: string;
        contract_snapshot_json: Record<string, unknown>;
      }>(`SELECT prompt,contract_snapshot_json FROM runs WHERE id=$1 AND space_id=$2`, [input.run_id, space]);
      const items = await db.pool.query<{
        id: string;
        title: string;
      }>(`SELECT id,title FROM source_items WHERE space_id=$1 ORDER BY id`, [space]);
      const annotation = run.rows[0]!.prompt === 'Classify incoming source material.';
      if (annotation) annotationCalls++;else relevanceCalls++;
      const output = annotation ? {
        schema: 'source_annotation.result.v2',
        annotations: items.rows.map(i => ({
          source_item_id: i.id,
          domain_key: 'artificial_intelligence',
          depth: 'overview',
          genre: 'research',
          summary: 'Objective abstract summary.',
          topic_candidates: ['agents'],
          stance_target: null,
          stance_polarity: 'neutral',
          stance_confidence: 80
        }))
      } : {
        schema: 'source_post_processing.result.v1',
        item_decisions: items.rows.map(i => ({
          source_item_id: i.id,
          relevance: i.title === 'Reliable agents' ? 'relevant' : 'not_relevant',
          confidence: 0.9,
          reason: i.title === 'Reliable agents' ? 'Matches reliable agents.' : 'Excluded advertising.',
          matched_context_refs: []
        }))
      };
      expect(JSON.stringify(run.rows[0]!.contract_snapshot_json)).toContain('max_attempts');
      await db.pool.query(`UPDATE runs r SET status='succeeded',output_json=$2::jsonb,runtime_profile_id=profile.id,runtime_profile_selection_source='default',runtime_key=profile.runtime_key,runtime_profile_snapshot_json=jsonb_build_object('id',profile.id,'runtime_key',profile.runtime_key,'backend_mode',profile.backend_mode,'runtime_config_json',profile.runtime_config_json,'runtime_policy_json',profile.runtime_policy_json) FROM agent_runtime_profiles profile WHERE r.id=$1 AND profile.agent_id=r.agent_id AND profile.space_id=r.space_id AND profile.is_default=true AND profile.enabled=true`, [input.run_id, JSON.stringify({
        schema_version: 'run_output.v1',
        result: output
      })]);
      return {
        run_id: input.run_id,
        status: 'succeeded' as const
      };
    });
    const run = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'first'
    });
    await service().details(identity, project, {
      expected_version_id: version.id,
      language: '中文'
    });
    await executeMonitoringOperation(db.pool, config(), space, run.id, publicAddressGuard);
    const state = await service().state(identity, project);
    expect(state.latest_run?.progress.reason).not.toBe('processing_failed');
    expect(state.active?.config.language).toBe('中文');
    expect(state.candidates).toHaveLength(2);
    expect(state.candidates.filter(c => c.recommended).map(c => c.title)).toEqual(['Reliable agents']);
    expect(state.candidates.find(c => !c.recommended)?.reason).toContain('Excluded');
    expect(annotationCalls).toBe(1);
    expect(relevanceCalls).toBe(1);
    expect(http).toHaveBeenCalledTimes(1);
    // Full HTTP/model-boundary execution must not bootstrap the deep-research
    // state machine, even after annotation, relevance and first delivery.
    for (const table of ['project_research_workflows', 'project_research_context_versions',
      'inquiry_threads', 'project_research_reports', 'research_evidence_cards', 'research_checklist_items']) {
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`, [space])).rows[0].n, table).toBe(0);
    }
    expect((await db.pool.query(`SELECT capability_id FROM runs WHERE space_id=$1 AND capability_id LIKE 'research.%'`, [space])).rows).toHaveLength(0);
    expect((await db.pool.query(`SELECT id FROM agents WHERE space_id=$1 AND agent_kind='system_research'`, [space])).rows).toHaveLength(0);
    const bypass = randomUUID();
    await db.pool.query(`INSERT INTO extraction_jobs(id,space_id,connection_id,job_type,status,metadata_json,created_at) VALUES($1,$2,$3,'connection_scan','pending',$4::jsonb,now())`, [bypass, space, connection, JSON.stringify({
      source_channel_id: channel
    })]);
    expect((await new SourceExtractionWorker(db.pool, config(), publicAddressGuard).runPendingJob(bypass, space)).status).toBe('failed');
    await expect(new SourcePostProcessingService(db.pool, config()).runRuleForItems({
      spaceId: space,
      ruleId: version.rule_id!,
      itemIds: state.candidates.map(c => c.id)
    })).rejects.toThrow(/bounded Project/);
    expect(http).toHaveBeenCalledTimes(1);
    expect(relevanceCalls).toBe(1);
    expect((await db.pool.query(`SELECT id FROM information_digests WHERE space_id=$1`, [space])).rows).toHaveLength(0);
    const agentRun = (await db.pool.query<RunRecord>(`SELECT * FROM runs WHERE space_id=$1 LIMIT 1`, [space])).rows[0]!;
    const tools = new Map<SystemActionId, SystemActionExecutor>();
    registerProjectsSystemActionExecutors(tools, config(), {
      ...agentRun,
      project_id: project,
      instructed_by_user_id: owner
    });
    for (const block of ['source', 'space']) {
      if (block === 'source') await db.pool.query(`UPDATE source_connections SET consent_json=consent_json||'{"allow_external_model_egress":false}' WHERE id=$1`, [connection]);else {
        await db.pool.query(`UPDATE source_connections SET consent_json=consent_json||'{"allow_external_model_egress":true}' WHERE id=$1`, [connection]);
        await updateSpaceRetrievalSettings(db.pool, space, {
          external_egress_enabled: false
        });
      }
      const reply = (await tools.get('project.monitoring.read')!({}, {} as never)) as {
        modelResult: unknown;
      };
      expect(reply.modelResult).not.toHaveProperty('candidates');
      expect(reply.modelResult).not.toHaveProperty('available_sources');
      expect(JSON.stringify(reply.modelResult)).not.toContain('Objective abstract summary.');
    }
    const selected = state.candidates.find(c => c.recommended)!;
    await db.pool.query(`UPDATE source_item_annotations SET summary='Changed later' WHERE source_item_id=$1`, [selected.id]);
    expect((await service().state(identity, project)).candidates.find(c => c.id === selected.id)?.summary).toBe(selected.summary);
    await db.pool.query(`UPDATE source_items SET excerpt=NULL WHERE id=$1 AND space_id=$2`, [selected.id, space]);
    expect((await service().state(identity, project)).candidates.find(c => c.id === selected.id)?.evidence_depth).toBe(selected.evidence_depth);
    const item = state.candidates[0]!.id;
    await service().feedback(identity, project, item, 'not_relevant');
    expect((await service().state(identity, project)).candidates.find(c => c.id === item)?.feedback).toBe('not_relevant');
    await service().feedback(identity, project, item, 'read');
    const feedback = (await service().state(identity, project)).candidates.find(c => c.id === item)!;
    expect(feedback.feedback).toBe('not_relevant');
    expect(feedback.read_status).toBe('read');
    // P2: first delivery and complete-day delivery share membership, cutoff and lock semantics.
    const unselected = state.candidates.find(c => !c.recommended)!;
    await db.pool.query(`UPDATE source_post_processing_item_decisions SET review_status='pending',relevance='relevant',reason='Daily reason',updated_at='2026-02-02T18:00:00Z' WHERE source_item_id=$1`, [unselected.id]);
    await db.pool.query(`UPDATE project_corpus_items SET triage_status='new' WHERE source_item_id=$1`, [unselected.id]);
    await db.pool.query(`UPDATE source_item_annotations SET annotated_at='2026-02-03T00:01:00Z',summary='Frozen daily summary' WHERE source_item_id=$1`, [unselected.id]);
    await db.pool.query(`UPDATE project_source_item_links SET created_at='2026-02-02T10:00:00Z' WHERE space_id=$1`, [space]);
    const digests = new InformationDigestService(db.pool);
    const firstDay = await digests.scheduledProject(space, project, owner, digestPeriod('2026-02-02', 'UTC'), null);
    expect(firstDay.digest.items).toHaveLength(0); // Late annotation cannot change this sealed day.
    const raced = await Promise.all([digests.scheduledProject(space, project, owner, digestPeriod('2026-02-03', 'UTC'), null), digests.backfillProject(space, project, owner, '2026-02-03')]);
    expect(new Set(raced.map(r => r.digest.id)).size).toBe(1);
    expect(raced.filter(r => r.created)).toHaveLength(1);
    expect(raced[0]!.digest.items.map(i => i.source_item_id)).toEqual([unselected.id]);
    expect(raced[0]!.digest.items[0]!.summary).toBe('Frozen daily summary');
    await db.pool.query(`UPDATE source_item_annotations SET summary='Later live summary' WHERE source_item_id=$1`, [unselected.id]);
    const stored = await digests.lookup(space, {
      type: 'project',
      projectId: project,
      readerUserId: owner
    }, '2026-02-03');
    expect(stored.status === 'available' && stored.digest.items[0]!.summary).toBe('Frozen daily summary');
    const current = (await service().state(identity, project)).active!;
    const afterDaily = await service().start(identity, project, {
      version_id: current.id,
      config_hash: current.config_hash,
      kind: 'initial',
      idempotency_key: 'initial-after-daily'
    });
    await executeMonitoringOperation(db.pool, config(), space, afterDaily.id, publicAddressGuard);
    expect((await service().state(identity, project)).candidates.some(c => c.recommended)).toBe(false);
    expect(http).toHaveBeenCalledTimes(1);
    const nextDays = await Promise.allSettled(['2026-02-04', '2026-02-05'].map(date => digests.scheduledProject(space, project, owner, digestPeriod(date, 'UTC'), null)));
    expect(nextDays.some(r => r.status === 'fulfilled')).toBe(true);
    for (const result of nextDays) {
      if (result.status === 'fulfilled') expect(result.value.digest.items).toHaveLength(0);else expect(result.reason).toMatchObject({
        statusCode: 422,
        responseBody: {
          code: 'monitoring_history_before_latest'
        }
      });
    }
    expect(await digests.lookup(space, {
      type: 'project',
      projectId: project,
      readerUserId: owner
    }, '2026-02-05')).toMatchObject({
      status: 'available'
    });
    await expect(digests.backfillProject(space, project, owner, '2026-02-01')).rejects.toMatchObject({
      statusCode: 422
    });
    const missing = await digests.lookup(space, {
      type: 'project',
      projectId: project,
      readerUserId: owner
    }, '2026-02-01');
    expect(missing).toMatchObject({
      status: 'missing',
      backfill_available: false,
      reason: 'monitoring_history_before_latest'
    });
    const member = randomUUID();
    await seedSpaceMember(db.pool, {
      space,
      user: member,
      role: 'member'
    });
    await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())`, [randomUUID(), space, project, member]);
    await db.pool.query(`UPDATE source_connections SET consent_json=jsonb_set(consent_json,'{allowed_reader_user_ids}',$2::jsonb) WHERE id=$1`, [connection, JSON.stringify([owner, member])]);
    const other = await service().state({
      spaceId: space,
      userId: member
    }, project);
    expect(other.candidates.every(c => c.feedback === null)).toBe(true);
    await expect(service().details({
      spaceId: space,
      userId: member
    }, project, {
      expected_version_id: version.id,
      language: 'zh'
    })).rejects.toMatchObject({
      statusCode: 403
    });
    await db.pool.query(`UPDATE source_connections SET consent_json=jsonb_set(consent_json,'{allowed_reader_user_ids}',$2::jsonb) WHERE id=$1`, [connection, JSON.stringify([owner])]);
    const revoked = await digests.lookup(space, {
      type: 'project',
      projectId: project,
      readerUserId: owner
    }, '2026-02-03');
    expect(revoked.status === 'available' && revoked.digest.items).toEqual([]); // All-reader intersection on hydration.
    await db.pool.query(`UPDATE source_connections SET consent_json=jsonb_set(consent_json,'{allowed_reader_user_ids}','[]') WHERE id=$1`, [connection]);
    expect((await service().state(identity, project)).candidates).toHaveLength(0);
  });
  it('creates independent paused manual Source drafts and preserves activation and binding approval gates', async () => {
    const setup = await service().setup(identity, project, {
      query: 'reliable agents',
      idempotency_key: 'new-manual-source'
    });
    const draft = setup.channel_draft as {
      id: string;
    };
    expect(new Set((await service().state(identity, project)).dependencies.map(p => p.id))).toEqual(new Set([String(setup.source_proposal!.id), String(setup.binding_proposal!.id)]));
    const viewer = randomUUID();
    await seedSpaceMember(db.pool, {
      space,
      user: viewer,
      role: 'member'
    });
    await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())`, [randomUUID(), space, project, viewer]);
    await db.pool.query(`UPDATE proposals SET visibility='private',owner_user_id=$2 WHERE id=$1`, [setup.binding_proposal!.id, owner]);
    expect((await service().state({
      spaceId: space,
      userId: viewer
    }, project)).dependencies.some(p => p.id === setup.binding_proposal!.id)).toBe(false);
    expect(draft.id).not.toBe(channel);
    const raw = await db.pool.query(`SELECT ch.status,ch.fetch_frequency,sc.status AS connection_status FROM source_channels ch JOIN source_connections sc ON sc.id=ch.source_connection_id WHERE ch.id=$1`, [draft.id]);
    expect(raw.rows[0]).toMatchObject({
      status: 'paused',
      fetch_frequency: 'manual',
      connection_status: 'paused'
    });
    const apply = new PgProposalApplyService(config());
    await expect(apply.accept(String(setup.binding_proposal!.id), identity)).rejects.toThrow(/activation/);
    await apply.accept(String(setup.source_proposal!.id), identity);
    await apply.accept(String(setup.binding_proposal!.id), identity);
    expect((await db.pool.query(`SELECT id FROM extraction_jobs WHERE space_id=$1`, [space])).rows).toHaveLength(0);
    const existing = await db.pool.query(`SELECT fetch_frequency FROM source_channels WHERE id=$1`, [channel]);
    expect(existing.rows[0].fetch_frequency).toBe('manual');
  });
  it('rejects HTTP detail field smuggling and exposes no work to a cross-Space reader', async () => {
    const active = await accept();
    __setAuthIdentityForTests(identity);
    const app = await buildModuleServer(config(), [projectsModule]);
    try {
      const base = `/api/v1/projects/${project}/information-monitoring`;
      for (const field of [{
        source_channel_id: randomUUID()
      }, {
        evidence_depth: 'full'
      }, {
        daily: {
          ...limits,
          candidates: 200
        }
      }, {
        objective: 'New scope'
      }]) {
        const result = await app.inject({
          method: 'PATCH',
          url: base + '/details',
          payload: {
            expected_version_id: active.id,
            ...field
          }
        });
        expect(result.statusCode).toBe(422);
      }
      expect((await service().state(identity, project)).active?.id).toBe(active.id);
      __setAuthIdentityForTests({
        spaceId: randomUUID(),
        userId: owner
      });
      expect((await app.inject({
        method: 'GET',
        url: base
      })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
  it('rejects query drift and unexpected legacy processing rules before spending', async () => {
    const active = await accept();
    await db.pool.query(`UPDATE source_search_specs SET query_fingerprint='changed' WHERE source_channel_id=$1`, [channel]);
    await expect(service().start(identity, project, {
      version_id: active.id,
      config_hash: active.config_hash,
      idempotency_key: 'drift',
      kind: 'initial'
    })).rejects.toThrow(/query changed/);
    expect((await db.pool.query(`SELECT id FROM project_operations WHERE progress_json->>'purpose'='information_monitoring' AND space_id=$1`, [space])).rows).toHaveLength(0);
  });
  it('classifies Agent detail changes on the server and preserves private drafts and real reviewer permissions', async () => {
    const active = await accept();
    const viewer = randomUUID();
    await seedSpaceMember(db.pool, {
      space,
      user: viewer,
      role: 'member'
    });
    await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())`, [randomUUID(), space, project, viewer]);
    const draft = await service().propose(identity, project, {
      config: {
        ...active.config,
        language: '中文'
      },
      expected_active_version_id: active.id,
      idempotency_key: 'private-detail'
    }, {
      proposalKind: 'details',
      visibility: 'private'
    });
    expect(draft.dependencies).toHaveLength(0);
    const row = await db.pool.query(`SELECT proposal_type,risk_level,required_approver_role,visibility FROM proposals WHERE id=$1`, [draft.proposal.id]);
    expect(row.rows[0]).toMatchObject({
      proposal_type: 'project_information_monitoring_details',
      risk_level: 'low',
      required_approver_role: 'reviewer',
      visibility: 'private'
    });
    expect((await service().state({
      spaceId: space,
      userId: viewer
    }, project)).draft).toBeNull();
    await expect(service().propose(identity, project, {
      config: {
        ...active.config,
        evidence_depth: 'full'
      },
      expected_active_version_id: active.id,
      idempotency_key: 'bad-depth'
    }, {
      proposalKind: 'details'
    })).rejects.toThrow();
    await expect(service().propose(identity, project, {
      config: {
        ...active.config,
        objective: 'Wider topic'
      },
      expected_active_version_id: active.id,
      idempotency_key: 'bad-scope'
    }, {
      proposalKind: 'details'
    })).rejects.toThrow(/scope/);
    await new PgProposalApplyService(config()).accept(String(draft.proposal.id), identity);
    expect((await service().state(identity, project)).active?.config.language).toBe('中文');
    expect((await db.pool.query(`SELECT id FROM source_backfill_plans WHERE space_id=$1`, [space])).rows).toHaveLength(1);
  });
  it('serializes concurrent same-paper materialization across Source channels and preserves both hits', async () => {
    const version = await accept();
    __setArxivThrottleForTests({
      minIntervalMs: 0
    });
    const run = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'concurrent-items'
    });
    const other = await new SourceChannelService(db.pool, config()).create(identity, {
      provider_key: 'arxiv',
      name: 'Independent manual source',
      source_name: 'Independent manual source',
      query: {
        search_query: 'all:agents'
      },
      project_id: project,
      fetch_frequency: 'manual',
      status: 'active',
      capture_policy: 'reference_only',
      _force_create: true
    });
    await new ProjectSourceBindingService(db.pool).createBinding(identity, {
      project_id: project,
      source_channel_id: other.id,
      standing_comparison_enabled: false
    });
    const dispatch = (await new SourceBackfillExecutionService(db.pool, run.id).executeNext(space, version.backfill_plan_id!)) as {
      job_id: string;
    };
    const original = await db.pool.query(`SELECT metadata_json FROM extraction_jobs WHERE id=$1`, [dispatch.job_id]);
    const metadata = {
      ...original.rows[0].metadata_json,
      window: {
        ...original.rows[0].metadata_json.window,
        page_size: 1,
        max_items: 1,
        remaining_items: 1
      }
    };
    await db.pool.query(`UPDATE extraction_jobs SET metadata_json=$2::jsonb WHERE id=$1`, [dispatch.job_id, JSON.stringify(metadata)]);
    const second = randomUUID();
    await db.pool.query(`INSERT INTO extraction_jobs(id,space_id,connection_id,job_type,status,metadata_json,created_at) VALUES($1,$2,$3,'connection_scan','pending',$4::jsonb,now())`, [second, space, other.source_connection_id, JSON.stringify({
      ...metadata,
      source_channel_id: other.id
    })]);
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2601.12345v1</id><title>Same paper</title><summary>Reliable agents.</summary><published>2026-02-01T00:00:00Z</published><updated>2026-02-01T00:00:00Z</updated></entry></feed>`, {
      headers: {
        'content-type': 'application/atom+xml'
      }
    }));
    const jobs = await Promise.all([dispatch.job_id, second].map(id => new SourceExtractionWorker(db.pool, config(), publicAddressGuard, run.id).runPendingJob(id, space)));
    expect(jobs.map(j => j.status)).toEqual(['succeeded', 'succeeded']);
    expect(http).toHaveBeenCalledTimes(2);
    const items = await db.pool.query(`SELECT id FROM source_items WHERE space_id=$1`, [space]);
    expect(items.rows).toHaveLength(1);
    const hits = await db.pool.query(`SELECT source_channel_id FROM source_channel_item_links WHERE source_item_id=$1`, [items.rows[0].id]);
    expect(new Set(hits.rows.map(h => h.source_channel_id))).toEqual(new Set([channel, other.id]));
  });
  it('retains approved history on direction-only changes and denies a Project writer proposal self-approval', async () => {
    const active = await accept();
    const writer = randomUUID();
    await seedSpaceMember(db.pool, {
      space,
      user: writer,
      role: 'member'
    });
    await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, writer]);
    const member = {
      spaceId: space,
      userId: writer
    };
    const detail = await service().propose(member, project, {
      config: {
        ...active.config,
        language: '中文'
      },
      expected_active_version_id: active.id,
      idempotency_key: 'writer-detail'
    }, {
      proposalKind: 'details'
    });
    await expect(new PgProposalApplyService(config()).accept(String(detail.proposal.id), member)).rejects.toMatchObject({
      statusCode: 403
    });
    await service().details(member, project, {
      expected_version_id: active.id,
      language: '中文'
    });
    const current = (await service().state(identity, project)).active!;
    const revised = await service().propose(identity, project, {
      config: {
        ...current.config,
        objective: 'Reliable multi-agent systems'
      },
      expected_active_version_id: current.id,
      idempotency_key: 'new-direction'
    }, {
      proposalKind: 'scope'
    });
    expect(revised.dependencies).toHaveLength(0);
    expect(revised.version?.backfill_plan_id).toBe(active.backfill_plan_id);
    await new PgProposalApplyService(config()).accept(String(revised.proposal.id), identity);
    expect((await service().state(identity, project)).active?.config.objective).toBe('Reliable multi-agent systems');
    expect((await db.pool.query(`SELECT id FROM source_backfill_plans WHERE space_id=$1`, [space])).rows).toHaveLength(1);
  });
  it('pauses quota exhaustion during HTTP retries and resumes the exact offset after the daily window expires', async () => {
    const version = await accept();
    __setArxivThrottleForTests({
      minIntervalMs: 0
    });
    const body = {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'retry-quota'
    };
    const first = await service().start(identity, project, body);
    await consumeMonitoringBudget(db.pool, space, first.id, 'source_requests', 3);
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('busy', {
      status: 503
    }));
    await executeMonitoringOperation(db.pool, config(), space, first.id, publicAddressGuard);
    expect(http).toHaveBeenCalledTimes(1);
    const segment = (await db.pool.query(`SELECT status,attempt_count,window_json FROM source_backfill_segments WHERE plan_id=$1`, [version.backfill_plan_id])).rows[0];
    expect(segment.status).toBe('pending');
    expect(segment.attempt_count).toBe(0);
    const offset = segment.window_json.offset ?? 0;
    const second = await service().start(identity, project, {
      ...body,
      idempotency_key: 'same-day'
    });
    await executeMonitoringOperation(db.pool, config(), space, second.id, publicAddressGuard);
    const secondRow = (await db.pool.query(`SELECT progress_json FROM project_operations WHERE id=$1`, [second.id])).rows[0];
    expect(secondRow.progress_json.used).toEqual({});
    expect(http).toHaveBeenCalledTimes(1);
    expect(secondRow.progress_json.reason).toBe('quota_paused');
    // Expire the retained calendar window, as on the next day, without changing global/PG clocks.
    await db.pool.query(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('date','2000-01-01','period_start','2000-01-01T00:00:00Z','period_end','2000-01-02T00:00:00Z') WHERE space_id=$1 AND progress_json->>'purpose'='information_monitoring_budget'`, [space]);
    http.mockImplementation(async () => new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>', {
      headers: {
        'content-type': 'application/atom+xml'
      }
    }));
    const next = await service().start(identity, project, {
      ...body,
      idempotency_key: 'next-day'
    });
    await executeMonitoringOperation(db.pool, config(), space, next.id, publicAddressGuard);
    expect(http).toHaveBeenCalledTimes(2);
    const request = String(http.mock.calls[1]![0]);
    expect(new URL(request).searchParams.get('start')).toBe(String(offset));
    expect((await db.pool.query(`SELECT status FROM source_backfill_segments WHERE plan_id=$1`, [version.backfill_plan_id])).rows[0].status).toBe('succeeded');
  });
  it('keeps daily accounting rows out of running operations while retaining shared admission', async () => {
    const version = await accept();
    const run = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'budget-ledger'
    });
    await consumeMonitoringBudget(db.pool, space, run.id, 'source_requests', 1);
    const running = await listRunningProjectOperations(db.pool, space, project);
    expect(running.some(r => r.progress_json.purpose === 'information_monitoring_budget')).toBe(false);
    expect((await new PgFrontendSupportService(db.pool).homeSummary(identity, {})).operations_in_progress.some(r => r.progress_json.purpose === 'information_monitoring_budget')).toBe(false);
    await consumeMonitoringBudget(db.pool, space, run.id, 'source_requests', 3);
    await expect(consumeMonitoringBudget(db.pool, space, run.id, 'source_requests', 1)).rejects.toThrow(/budget_exhausted/);
  });
  it.each(['failed', 'cancelled', 'missing', 'completed'])('recovers a stopped %s coordinator before another explicit run without refunding admissions', async status => {
    const version = await accept();
    const body = {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'stopped'
    };
    const first = await service().start(identity, project, body);
    await consumeMonitoringBudget(db.pool, space, first.id, 'source_requests', 1);
    if (status === 'missing') await db.pool.query(`DELETE FROM jobs WHERE payload_json->>'operation_id'=$1`, [first.id]);else await db.pool.query(`UPDATE jobs SET status=$2 WHERE payload_json->>'operation_id'=$1`, [first.id, status]);
    expect((await service().state(identity, project)).can_reconcile).toBe(true);
    const next = await service().start(identity, project, {
      ...body,
      idempotency_key: 'recover'
    });
    expect(next.id).not.toBe(first.id);
    const old = (await db.pool.query(`SELECT status,progress_json FROM project_operations WHERE id=$1`, [first.id])).rows[0];
    expect(old.status).toBe('completed');
    expect(old.progress_json.reason).toBe('processing_failed');
    expect(old.progress_json.used.source_requests).toBe(1);
    await expect(consumeMonitoringBudget(db.pool, space, next.id, 'source_requests', 4)).rejects.toThrow(/budget_exhausted/);
  });
  it('does not recover a live coordinator or start work beside its session lock', async () => {
    const version = await accept();
    const body = {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'live'
    };
    const first = await service().start(identity, project, body);
    await expect(service().start(identity, project, {
      ...body,
      idempotency_key: 'still-live'
    })).rejects.toThrow(/already active/);
    await db.pool.query(`UPDATE jobs SET status='failed' WHERE payload_json->>'operation_id'=$1`, [first.id]);
    const locked = await tryWithDedicatedSessionAdvisoryLock(db.pool, `monitoring-run:${space}:${project}`, async () => {
      await expect(service().start(identity, project, {
        ...body,
        idempotency_key: 'locked'
      })).rejects.toThrow(/already active/);
    });
    expect(locked.acquired).toBe(true);
    expect((await db.pool.query(`SELECT status FROM project_operations WHERE id=$1`, [first.id])).rows[0].status).toBe('active');
  });
  it.each(['consent_missing', 'egress_denied', 'retry_scheduled', 'budget_exhausted'])('reports analysis_pending for parked %s annotation even after history is exhausted', async wait => {
    const version = await accept();
    const run = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'parked'
    });
    __setArxivThrottleForTests({
      minIntervalMs: 0
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2601.55555v1</id><title>Pending paper</title><summary>Pending summary.</summary><published>2026-02-01T00:00:00Z</published><updated>2026-02-01T00:00:00Z</updated></entry></feed>', {
      headers: {
        'content-type': 'application/atom+xml'
      }
    }));
    const backfill = new SourceBackfillExecutionService(db.pool, run.id);
    const page = (await backfill.executeNext(space, version.backfill_plan_id!)) as {
      job_id: string;
    };
    await new SourceExtractionWorker(db.pool, config(), publicAddressGuard, run.id).runPendingJob(page.job_id, space);
    await backfill.reconcile(space, version.backfill_plan_id!);
    const items = (await db.pool.query<{
      id: string;
    }>(`SELECT id FROM source_items WHERE space_id=$1`, [space])).rows.map(i => i.id);
    await new PgSourceAnnotationRepository(db.pool).enqueueMonitoringItems(space, channel, items);
    await db.pool.query(`UPDATE source_item_annotations SET status=CASE WHEN $2::varchar='budget_exhausted' THEN 'failed' ELSE 'pending' END,attempt_count=CASE WHEN $2::varchar='budget_exhausted' THEN 6 ELSE 0 END,wait_reason=$2::varchar,next_retry_at=CASE WHEN $2::varchar='retry_scheduled' THEN now()+interval '1 hour' ELSE NULL END WHERE space_id=$1`, [space, wait]);
    if (wait === 'budget_exhausted') await db.pool.query(`UPDATE source_item_annotations SET status='failed',attempt_count=6,wait_reason='budget_exhausted',next_retry_at=NULL WHERE space_id=$1`, [space]);
    const model = vi.spyOn(RunOrchestrationService.prototype, 'executeRun').mockImplementation(async input => {
      await db.pool.query(`UPDATE runs SET status='failed' WHERE id=$1`, [input.run_id]);
      return {
        run_id: input.run_id,
        status: 'failed' as const
      };
    });
    await executeMonitoringOperation(db.pool, config(), space, run.id, publicAddressGuard);
    if (wait === 'budget_exhausted') {
      expect(model).toHaveBeenCalledTimes(1);
      expect((await db.pool.query(`SELECT attempt_count FROM source_item_annotations WHERE space_id=$1`, [space])).rows[0].attempt_count).toBe(1);
    } else expect(model).not.toHaveBeenCalled();
    const state = await service().state(identity, project);
    expect(state.latest_run?.progress.reason).toBe('analysis_pending');
    expect(state.latest_run?.progress.phase).toBe('partial');
    expect(state.candidates[0]?.summary).toBeNull();
  });
  it('retains an interrupted page for explicit recovery and refuses background extraction ownership', async () => {
    const version = await accept();
    const body = {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'interrupted-page'
    };
    const first = await service().start(identity, project, body);
    const dispatch = (await new SourceBackfillExecutionService(db.pool, first.id).executeNext(space, version.backfill_plan_id!)) as {
      job_id: string;
    };
    await expect(new SourceExtractionWorker(db.pool, config(), publicAddressGuard).runPendingJob(dispatch.job_id, space)).rejects.toMatchObject({
      statusCode: 409
    });
    expect((await db.pool.query(`SELECT status FROM extraction_jobs WHERE id=$1`, [dispatch.job_id])).rows[0].status).toBe('pending');
    await db.pool.query(`UPDATE extraction_jobs SET status='running' WHERE id=$1`, [dispatch.job_id]);
    await db.pool.query(`UPDATE jobs SET status='failed' WHERE payload_json->>'operation_id'=$1`, [first.id]);
    const next = await service().start(identity, project, {
      ...body,
      idempotency_key: 'recover-page'
    });
    const segment = (await db.pool.query(`SELECT status,window_json FROM source_backfill_segments WHERE plan_id=$1`, [version.backfill_plan_id])).rows[0];
    expect(segment.status).toBe('pending');
    const resumed = (await new SourceBackfillExecutionService(db.pool, next.id).executeNext(space, version.backfill_plan_id!)) as {
      job_id: string;
    };
    expect(resumed.job_id).not.toBe(dispatch.job_id);
    const window = (await db.pool.query(`SELECT metadata_json->'window' AS window FROM extraction_jobs WHERE id=$1`, [resumed.job_id])).rows[0].window;
    expect(window.offset ?? 0).toBe(segment.window_json.offset ?? 0);
  });
  it('will not replace a stopped coordinator while a child model Run remains live', async () => {
    const version = await accept();
    const body = {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'live-child'
    };
    const first = await service().start(identity, project, body);
    const child = randomUUID();
    await seedRun(db.pool, {
      id: child,
      space,
      owner,
      agent: randomUUID(),
      version: randomUUID()
    });
    await db.pool.query(`UPDATE runs SET status='running',contract_snapshot_json=jsonb_build_object('source',jsonb_build_object('kind','direct','id',$2::text)) WHERE id=$1`, [child, first.id]);
    await db.pool.query(`UPDATE jobs SET status='failed' WHERE payload_json->>'operation_id'=$1`, [first.id]);
    await expect(service().start(identity, project, {
      ...body,
      idempotency_key: 'not-yet'
    })).rejects.toThrow(/already active/);
    await db.pool.query(`UPDATE runs SET status='cancelled' WHERE id=$1`, [child]);
    await expect(service().start(identity, project, {
      ...body,
      idempotency_key: 'now-stopped'
    })).resolves.toHaveProperty('id');
  });
  it('atomically refuses all page slots when request quota disappears after dispatch but before send', async () => {
    const version = await accept();
    const run = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'admission-race'
    });
    const backfill = new SourceBackfillExecutionService(db.pool, run.id);
    const page = (await backfill.executeNext(space, version.backfill_plan_id!)) as {
      job_id: string;
    };
    await consumeMonitoringBudget(db.pool, space, run.id, 'source_requests', 4);
    const http = vi.spyOn(globalThis, 'fetch');
    await new SourceExtractionWorker(db.pool, config(), publicAddressGuard, run.id).runPendingJob(page.job_id, space);
    await backfill.reconcile(space, version.backfill_plan_id!);
    expect(http).not.toHaveBeenCalled();
    expect((await db.pool.query(`SELECT progress_json->'used' AS used FROM project_operations WHERE id=$1`, [run.id])).rows[0].used).toEqual({
      source_requests: 4
    });
    expect((await db.pool.query(`SELECT status,attempt_count FROM source_backfill_segments WHERE plan_id=$1`, [version.backfill_plan_id])).rows[0]).toMatchObject({
      status: 'pending',
      attempt_count: 0
    });
  });
  it('defers an actual coordinator Job on session contention without completion or a retry spin', async () => {
    const version = await accept();
    const operation = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'job-lock'
    });
    const registry = new JobHandlerRegistry();
    registerMonitoringJob(registry, config());
    const worker = new JobWorker(new PgJobQueueRepository(db.pool), registry, 'monitoring-test', ['project_information_monitoring']);
    const before = Date.now();
    const locked = await tryWithDedicatedSessionAdvisoryLock(db.pool, `monitoring-run:${space}:${project}`, async () => {
      expect((await worker.processOne()).status).toBe('deferred');
      const job = (await db.pool.query(`SELECT status,scheduled_at,attempts FROM jobs WHERE payload_json->>'operation_id'=$1`, [operation.id])).rows[0];
      expect(job.status).toBe('pending');
      expect(job.attempts).toBe(0);
      expect(new Date(job.scheduled_at).getTime()).toBeGreaterThanOrEqual(before + 1000);
      expect((await worker.processOne()).status).toBe('idle');
    });
    expect(locked.acquired).toBe(true);
    expect((await service().state(identity, project)).latest_run?.status).toBe('active');
  });
  it.each(['paused', 'source_changed', 'permission_changed', 'operation_inactive'])('retains the original offset when %s denies the next HTTP send', async denial => {
    const version = await accept({
      ...scope(),
      daily: {
        ...limits,
        candidates: 4
      }
    });
    const first = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'admission-change'
    });
    const other = randomUUID();
    await seedSpaceMember(db.pool, {
      space,
      user: other,
      role: 'member'
    });
    __setArxivThrottleForTests({
      minIntervalMs: 0
    });
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (denial === 'paused') await service().setPaused(identity, project, version.id, true);
      if (denial === 'source_changed') await db.pool.query(`UPDATE source_search_specs SET query_fingerprint='drift' WHERE source_channel_id=$1`, [channel]);
      if (denial === 'permission_changed') {
        await db.pool.query(`UPDATE space_memberships SET role='member' WHERE user_id=$1 AND space_id=$2`, [owner, space]);
        await db.pool.query(`UPDATE source_connections SET owner_user_id=$2 WHERE id=$1`, [connection, other]);
      }
      if (denial === 'operation_inactive') await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`, [first.id]);
      return new Response('busy', {
        status: 503
      });
    });
    await executeMonitoringOperation(db.pool, config(), space, first.id, publicAddressGuard);
    expect(http).toHaveBeenCalledTimes(1);
    const segment = (await db.pool.query(`SELECT status,attempt_count,window_json,error_json FROM source_backfill_segments WHERE plan_id=$1`, [version.backfill_plan_id])).rows[0];
    expect(segment.status).toBe('pending');
    expect(segment.attempt_count).toBe(0);
    expect(segment.error_json.code).toBe('monitoring_admission_denied');
    expect(segment.error_json.paused_reason).toBe(denial);
    if (denial !== 'operation_inactive') expect((await service().state(identity, project)).latest_run?.progress.reason).toBe(denial === 'paused' ? 'paused' : 'admission_blocked');
    expect((await db.pool.query(`SELECT progress_json->'used' AS used FROM project_operations WHERE id=$1`, [first.id])).rows[0].used.source_requests).toBe(1);
    await db.pool.query(`UPDATE space_memberships SET role='owner' WHERE user_id=$1 AND space_id=$2`, [owner, space]);
    await db.pool.query(`UPDATE source_connections SET owner_user_id=$2 WHERE id=$1`, [connection, owner]);
    await db.pool.query(`UPDATE source_search_specs SET query_fingerprint='monitoring-query' WHERE source_channel_id=$1`, [channel]);
    await service().setPaused(identity, project, version.id, false);
    http.mockImplementation(async () => new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>', {
      headers: {
        'content-type': 'application/atom+xml'
      }
    }));
    const resumed = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'admission-resumed'
    });
    await executeMonitoringOperation(db.pool, config(), space, resumed.id, publicAddressGuard);
    expect(http).toHaveBeenCalledTimes(2);
    expect(new URL(String(http.mock.calls[1]![0])).searchParams.get('start')).toBe(String(segment.window_json.offset ?? 0));
    expect((await db.pool.query(`SELECT status FROM source_backfill_segments WHERE plan_id=$1`, [version.backfill_plan_id])).rows[0].status).toBe('succeeded');
  });
  it('keeps a real nonretryable upstream error failed rather than treating it as admission pause', async () => {
    const version = await accept();
    const operation = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'upstream-failed'
    });
    __setArxivThrottleForTests({
      minIntervalMs: 0
    });
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('monitoring_budget_exhausted', {
      status: 400
    }));
    await executeMonitoringOperation(db.pool, config(), space, operation.id, publicAddressGuard);
    expect(http).toHaveBeenCalledTimes(1);
    const segment = (await db.pool.query(`SELECT status,attempt_count,error_json FROM source_backfill_segments WHERE plan_id=$1`, [version.backfill_plan_id])).rows[0];
    expect(segment.status).toBe('failed');
    expect(segment.attempt_count).toBe(1);
    expect(segment.error_json.code).not.toBe('monitoring_admission_denied');
    expect((await service().state(identity, project)).latest_run?.progress.reason).toBe('source_failed');
  });
});
describe('Project confirmed daily monitoring', () => {
  const dailyScope = () => ({
    ...scope(),
    to: '2026-01-02T00:00:00.000Z',
    schedule: {
      collection_time: '22:00',
      stop_time: '23:45',
      digest_time: '07:00',
      recent_window_candidates: 100
    }
  });
  it.each(['quota_paused',null])('freezes not_run on a blank day despite older %s and future Source runs',async(reason)=>{
    const version=await accept(dailyScope());
    __setArxivThrottleForTests({minIntervalMs:0});
    vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>',{status:200}));
    const old=await service().start(identity,project,{version_id:version.id,config_hash:version.config_hash,kind:'check',idempotency_key:'old-coverage'});
    await executeMonitoringOperation(db.pool,config(),space,old.id,publicAddressGuard);
    await db.pool.query(`UPDATE project_operations SET created_at='2026-02-01T22:00:00Z',progress_json=progress_json||jsonb_build_object('reason',$3::text,'coverage','no_new','as_of','2026-02-01T23:00:00Z') WHERE id=$1 AND space_id=$2`,[old.id,space,reason]);
    const future=await service().start(identity,project,{version_id:version.id,config_hash:version.config_hash,kind:'check',idempotency_key:'future-coverage'});
    await db.pool.query(`UPDATE project_operations SET status='completed',created_at='2026-02-11T22:00:00Z',progress_json=progress_json||'{"reason":"source_failed","as_of":"2026-02-11T23:00:00Z"}'::jsonb WHERE id=$1 AND space_id=$2`,[future.id,space]);
    const digestService=new InformationDigestService(db.pool);
    const snapshot=await digestService.scheduledProject(space,project,owner,digestPeriod('2026-02-10','UTC'),null);
    expect(snapshot.digest.settings).toMatchObject({coverage:'not_run',acquisition_cutoff:null,dispatch_until:null});
    expect(snapshot.digest.items).toEqual([]);
    await db.pool.query(`UPDATE project_operations SET created_at='2026-02-10T22:00:00Z' WHERE id=$1`,[old.id]);
    const reread=await digestService.backfillProject(space,project,owner,'2026-02-10');
    expect(reread.created).toBe(false);expect(reread.digest.id).toBe(snapshot.digest.id);
    expect(reread.digest.settings.coverage).toBe('not_run');
  });
  it('uses the target local daily window and its frozen version before a later manual run',async()=>{
    const version=await accept({...dailyScope(),timezone:'Asia/Shanghai'});
    const daily=await service().start(identity,project,{version_id:version.id,config_hash:version.config_hash,kind:'check',idempotency_key:'daily-window'},'2026-02-10T14:00:00.000Z');
    await db.pool.query(`UPDATE project_operations SET status='completed',created_at='2026-02-10T14:00:00Z',progress_json=progress_json||'{"reason":null,"coverage":"no_new","as_of":"2026-02-10T15:00:00Z"}'::jsonb WHERE id=$1`,[daily.id]);
    await service().details(identity,project,{expected_version_id:version.id,recommendation_count:9});
    const active=(await service().state(identity,project)).active!;
    const manual=await service().start(identity,project,{version_id:active.id,config_hash:active.config_hash,kind:'check',idempotency_key:'later-manual'});
    await db.pool.query(`UPDATE project_operations SET status='completed',created_at='2026-02-10T15:30:00Z',progress_json=progress_json||'{"reason":"quota_paused","as_of":"2026-02-10T15:40:00Z"}'::jsonb WHERE id=$1`,[manual.id]);
    const snapshot=await new InformationDigestService(db.pool).scheduledProject(space,project,owner,digestPeriod('2026-02-10','Asia/Shanghai'),null);
    expect(snapshot.digest.settings).toMatchObject({coverage:'no_new',interest_slots:1,monitoring_version_id:version.id,acquisition_cutoff:'2026-02-10T14:00:00.000Z'});
    await db.pool.query(`UPDATE project_operations SET progress_json=progress_json||'{"reason":"source_failed"}'::jsonb WHERE id=$1`,[daily.id]);
    const existing=await new InformationDigestService(db.pool).backfillProject(space,project,owner,'2026-02-10');
    expect(existing.digest.settings.coverage).toBe('no_new');
  });
  it('does not use a settlement after the day cutoff as that day completed coverage',async()=>{
    const version=await accept(dailyScope());
    const run=await service().start(identity,project,{version_id:version.id,config_hash:version.config_hash,kind:'check',idempotency_key:'late-settlement'});
    await db.pool.query(`UPDATE project_operations SET status='completed',created_at='2026-02-10T22:00:00Z',progress_json=progress_json||'{"reason":null,"coverage":"no_new","as_of":"2026-02-11T00:01:00Z"}'::jsonb WHERE id=$1`,[run.id]);
    const snapshot=await new InformationDigestService(db.pool).scheduledProject(space,project,owner,digestPeriod('2026-02-10','UTC'),null);
    expect(snapshot.digest.settings.coverage).toBe('analysis_pending');
  });
  it.each(['parse','dispatch-deadlock','recovery-deadlock'])('isolates a %s monitoring failure from other Projects and ordinary extraction',async(failure)=>{
    const version=await accept(dailyScope());
    const second=randomUUID();
    await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Other monitor','active',now(),now())`,[second,space,owner]);
    await seedMainlineRoomsForAllProjects(db.pool);
    const secondSource=await new SourceChannelService(db.pool,config()).create(identity,{provider_key:'arxiv',name:'Other monitor',source_name:'Other monitor',query:{search_query:'all:other'},project_id:second,visibility:'space_shared',fetch_frequency:'manual',status:'active',capture_policy:'reference_only',config:{daily_inbox_briefing:false},_force_create:true});
    await new ProjectSourceBindingService(db.pool).createBinding(identity,{project_id:second,source_channel_id:secondSource.id,standing_comparison_enabled:false});
    const proposed=await service().propose(identity,second,{config:{...dailyScope(),source_channel_id:secondSource.id},expected_active_version_id:null,idempotency_key:'second-monitor'});
    const apply=new PgProposalApplyService(config());
    for(const dep of proposed.dependencies??[])await apply.accept(String(dep.id),identity);
    await apply.accept(String(proposed.proposal.id),identity);
    const ordinary=await new SourceChannelService(db.pool,config()).create(identity,{provider_key:'arxiv',name:'Ordinary source',source_name:'Ordinary source',query:{search_query:'all:ordinary'},fetch_frequency:'daily',status:'active',capture_policy:'reference_only',config:{daily_inbox_briefing:false},_force_create:true});
    await db.pool.query(`UPDATE scheduler_tasks SET next_run_at=now()-interval '1 minute' WHERE task_key=ANY($1::varchar[])`,[[project,second,ordinary.id]]);
    if(failure==='parse')await db.pool.query(`UPDATE project_information_monitoring_versions SET config_json=config_json||'{"objective":""}'::jsonb WHERE id=$1`,[version.id]);
    else {
      if(failure==='recovery-deadlock'){
        const old=await service().start(identity,project,{version_id:version.id,config_hash:version.config_hash,kind:'check',idempotency_key:'failed-coordinator'},new Date(Date.now()-60000).toISOString());
        await db.pool.query(`UPDATE jobs SET status='failed' WHERE payload_json->>'operation_id'=$1`,[old.id]);
      }
      const original=ProjectMonitoringService.prototype.start;
      vi.spyOn(ProjectMonitoringService.prototype,'start').mockImplementation(async function(this:ProjectMonitoringService,...args:Parameters<typeof original>){
        if(args[1]===project)throw Object.assign(new Error('simulated PostgreSQL deadlock'),{code:'40P01'});
        return original.apply(this,args);
      });
    }
    __setArxivThrottleForTests({minIntervalMs:0});
    vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>',{status:200}));
    const tasks=buildSourceSchedulerTasks(config());
    const monitor=tasks.find(t=>t.name==='project_information_monitoring_scheduler');
    expect(monitor).toBeTruthy();
    const extraction=tasks.find(t=>t.name==='source_extraction_scheduler')!;
    const alerts=vi.fn();
    const registry=new SchedulerRegistry({warn:vi.fn(),error:vi.fn()},alerts);
    registry.register({...monitor!,awaitRunOnStart:true});
    registry.register({...extraction,awaitRunOnStart:true});
    try {
      await registry.start();
      expect(registry.statuses().find(t=>t.name===monitor!.name)).toMatchObject({health:'failing',consecutive_failures:1});
      expect(registry.statuses().find(t=>t.name===extraction.name)).toMatchObject({health:'ok'});
      expect(alerts).toHaveBeenCalledWith(expect.objectContaining({task_name:monitor!.name,kind:'exception'}));
      expect((await db.pool.query(`SELECT id FROM project_operations WHERE project_id=$1 AND progress_json->>'purpose'='information_monitoring'`,[second])).rows).toHaveLength(1);
      expect((await db.pool.query(`SELECT id FROM extraction_jobs WHERE metadata_json->>'source_channel_id'=$1 AND status='succeeded'`,[ordinary.id])).rows.length).toBeGreaterThan(0);
    }finally{await registry.stop();}
  });
  it.each([30,60,3600])('backs off blocked slots without changing their day identity or starving later Projects at %s-second cadence',async(cadence)=>{
    const version=await accept(dailyScope());
    const slot=new Date(Date.now()-1000).toISOString();
    const blocked=Array.from({length:25},()=>randomUUID());
    for(const id of blocked){
      await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,$1,'active',now(),now())`,[id,space,owner]);
      await db.pool.query(`INSERT INTO scheduler_tasks(id,task_type,task_key,scope_type,scope_id,space_id,user_id,status,next_run_at,metadata_json,created_at,updated_at) VALUES($1,'project_information_monitoring',$2,'space',$3,$3,$4,'active',$5,'{}',now(),now())`,[randomUUID(),id,space,owner,new Date(Date.parse(slot)-1000).toISOString()]);
    }
    await seedMainlineRoomsForAllProjects(db.pool);
    await db.pool.query(`UPDATE scheduler_tasks SET next_run_at=$2 WHERE task_key=$1 AND task_type='project_information_monitoring'`,[project,slot]);
    const now=new Date();
    await expect(enqueueDueMonitoring(db.pool,config(),now)).rejects.toThrow();
    expect((await db.pool.query(`SELECT id FROM project_operations WHERE progress_json->>'purpose'='information_monitoring'`)).rows).toHaveLength(0);
    const next=enqueueDueMonitoring(db.pool,config(),new Date(now.getTime()+cadence*1000));
    if(cadence>=60)await expect(next).rejects.toThrow();else await next;
    const ops=(await db.pool.query(`SELECT progress_json FROM project_operations WHERE progress_json->>'purpose'='information_monitoring'`)).rows;
    expect(ops).toHaveLength(1);
    expect(ops[0].progress_json.slot).toBe(slot);
    expect((await db.pool.query(`SELECT next_run_at,metadata_json FROM scheduler_tasks WHERE task_key=$1`,[blocked[0]])).rows[0]).toMatchObject({next_run_at:new Date(Date.parse(slot)-1000),metadata_json:expect.objectContaining({retry_after:expect.any(String)})});
    expect(version.config.schedule).toBeTruthy();
  });
  it('makes a backed-off task eligible exactly at expiry without shifting its scheduled slot',async()=>{
    await accept(dailyScope());
    const store=new PgSchedulerTaskStore(db.pool);
    const slot='2026-10-25T10:00:00.000Z',retry='2026-10-25T11:59:00.000Z';
    await db.pool.query(`UPDATE scheduler_tasks SET next_run_at=$2,metadata_json=metadata_json||jsonb_build_object('retry_after',$3::text) WHERE task_key=$1 AND task_type='project_information_monitoring'`,[project,slot,retry]);
    const list=(now:string)=>store.listDue('project_information_monitoring',now,25,{respectRetryAfter:true});
    expect(await list('2026-10-25T11:58:59.999Z')).toHaveLength(0);
    expect(await list(retry)).toHaveLength(1);
    expect(await list('2026-10-25T12:00:00.000Z')).toHaveLength(1);
    expect(new Date(String((await list(retry))[0]!.next_run_at)).toISOString()).toBe(slot);
  });
  it.each(['permission','unexpected'])('retries a %s block after expiry and restored authority on the original daily slot',async(kind)=>{
    const version=await accept(dailyScope());
    const now=new Date(),slot=new Date(now.getTime()-1000).toISOString();
    await db.pool.query(`UPDATE scheduler_tasks SET next_run_at=$2 WHERE task_key=$1 AND task_type='project_information_monitoring'`,[project,slot]);
    const spy=kind==='unexpected'?vi.spyOn(ProjectMonitoringService.prototype,'start').mockRejectedValueOnce(new Error('Injected infrastructure failure')):null;
    if(kind==='permission')await db.pool.query(`UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2`,[space,owner]);
    if(kind==='unexpected')await expect(enqueueDueMonitoring(db.pool,config(),now)).rejects.toThrow();
    else await enqueueDueMonitoring(db.pool,config(),now);
    spy?.mockRestore();
    if(kind==='permission')await db.pool.query(`UPDATE space_memberships SET status='active' WHERE space_id=$1 AND user_id=$2`,[space,owner]);
    expect((await db.pool.query(`SELECT id FROM project_operations WHERE progress_json->>'purpose'='information_monitoring'`)).rows).toHaveLength(0);
    await enqueueDueMonitoring(db.pool,config(),new Date(now.getTime()+59999));
    expect((await db.pool.query(`SELECT id FROM project_operations WHERE progress_json->>'purpose'='information_monitoring'`)).rows).toHaveLength(0);
    await enqueueDueMonitoring(db.pool,config(),new Date(now.getTime()+60000));
    const ops=(await db.pool.query(`SELECT progress_json FROM project_operations WHERE progress_json->>'purpose'='information_monitoring'`)).rows;
    expect(ops).toHaveLength(1);expect(ops[0].progress_json.slot).toBe(slot);
    expect(ops[0].progress_json.version_id).toBe(version.id);
  });
  it('confirmation alone installs one owned schedule and one existing Digest without sending requests', async () => {
    const draft = await propose(dailyScope());
    expect((await db.pool.query(`SELECT id FROM scheduler_tasks WHERE task_type='project_information_monitoring'`)).rows).toHaveLength(0);
    const apply = new PgProposalApplyService(config());
    for (const dep of draft.dependencies ?? []) await apply.accept(String(dep.id), identity);
    await apply.accept(String(draft.proposal.id), identity);
    const state = await service().state(identity, project);
    expect(state.paused).toBe(false);
    expect(state.schedule).toMatchObject({
      confirmed: true,
      blocked_reason: null
    });
    expect(state.schedule?.next_run_at).toBeTruthy();
    expect((await db.pool.query(`SELECT config_json FROM automations WHERE project_id=$1 AND config_json->>'target_type'='information_digest'`, [project])).rows).toEqual([{
      config_json: expect.objectContaining({
        cron: '0 7 * * *',
        timezone: 'UTC'
      })
    }]);
    expect((await db.pool.query(`SELECT id FROM extraction_jobs WHERE space_id=$1`, [space])).rows).toHaveLength(0);
  });
  it('explicit daily confirmation resumes its own paused Digest instead of silently collecting without delivery', async () => {
    const {
      PgAutomationRepository
    } = await import('../src/modules/automations/repository.js');
    const repo = new PgAutomationRepository(db.pool);
    const existing = await repo.create({
      spaceId: space,
      ownerUserId: owner,
      agentId: agent,
      projectId: project,
      name: 'Own paused digest',
      triggerType: 'schedule',
      configJson: {
        target_type: 'information_digest',
        scope: 'project',
        operation: 'daily',
        cron: '30 6 * * *',
        timezone: 'UTC'
      },
      preflightSnapshot: {
        executable: true
      }
    });
    await repo.update(space, existing.id, {
      status: 'paused'
    });
    await accept(dailyScope());
    const rows = await db.pool.query(`SELECT id,status,config_json->>'cron' AS cron FROM automations WHERE space_id=$1 AND project_id=$2`, [space, project]);
    expect(rows.rows).toEqual([{
      id: existing.id,
      status: 'active',
      cron: '0 7 * * *'
    }]);
  });
  it('does not change another owner Digest and rolls back failed schedule activation', async () => {
    const active = await accept();
    const other = randomUUID();
    await seedSpaceMember(db.pool, {
      space,
      user: other,
      role: 'member'
    });
    const {
      PgAutomationRepository
    } = await import('../src/modules/automations/repository.js');
    await new PgAutomationRepository(db.pool).create({
      spaceId: space,
      ownerUserId: other,
      agentId: agent,
      projectId: project,
      name: 'Existing digest',
      triggerType: 'schedule',
      configJson: {
        target_type: 'information_digest',
        scope: 'project',
        operation: 'daily',
        cron: '30 6 * * *',
        timezone: 'Europe/London'
      },
      preflightSnapshot: {
        executable: true
      }
    });
    const draft = await service().propose(identity, project, {
      expected_active_version_id: active.id,
      idempotency_key: 'daily-conflict',
      config: dailyScope()
    });
    for (const dep of draft.dependencies ?? []) await new PgProposalApplyService(config()).accept(String(dep.id), identity);
    await expect(new PgProposalApplyService(config()).accept(String(draft.proposal.id), identity)).rejects.toThrow('monitoring_digest_owner_conflict');
    expect((await service().state(identity, project)).active?.id).toBe(active.id);
    expect((await db.pool.query(`SELECT config_json->>'cron' AS cron FROM automations WHERE owner_user_id=$1`, [other])).rows[0].cron).toBe('30 6 * * *');
  });
  it('serializes due sweeps and retains the original slot while paused; restart recovers stopped work without new allowance', async () => {
    const version = await accept({
      ...dailyScope(),
      timezone: new Date().getUTCHours() >= 12 ? 'Etc/GMT+12' : 'UTC'
    });
    const slot = new Date(Date.now() - 1000).toISOString();
    await db.pool.query(`UPDATE scheduler_tasks SET next_run_at=$2 WHERE task_key=$1 AND task_type='project_information_monitoring'`, [project, slot]);
    await service().setPaused(identity, project, version.id, true);
    await enqueueDueMonitoring(db.pool, config());
    expect((await db.pool.query(`SELECT id FROM project_operations WHERE progress_json->>'purpose'='information_monitoring'`)).rows).toHaveLength(0);
    await service().setPaused(identity, project, version.id, false);
    await Promise.all([enqueueDueMonitoring(db.pool, config()), enqueueDueMonitoring(db.pool, config())]);
    const ops = await db.pool.query<{
      id: string;
    }>(`SELECT id FROM project_operations WHERE progress_json->>'purpose'='information_monitoring'`);
    expect(ops.rows).toHaveLength(1);
    expect((await db.pool.query(`SELECT id FROM jobs WHERE job_type='project_information_monitoring'`)).rows).toHaveLength(1);
    const plans = await monitoringAcquisitionPlans(db.pool, space, channel, version.backfill_plan_id!);
    expect(plans).toHaveLength(2);
    expect(plans[1]).toBe(version.backfill_plan_id);
    await consumeMonitoringBudget(db.pool, space, ops.rows[0]!.id, 'source_requests', 1);
    await db.pool.query(`UPDATE jobs SET status='failed' WHERE job_type='project_information_monitoring'`);
    // The next scheduled day is still in the future: the heartbeat must recover now.
    await enqueueDueMonitoring(db.pool, config());
    expect((await db.pool.query(`SELECT progress_json->'used' AS used FROM project_operations WHERE progress_json->>'purpose'='information_monitoring_budget'`)).rows).toEqual([{
      used: {
        source_requests: 1
      }
    }]);
    expect((await db.pool.query(`SELECT id FROM project_operations WHERE status='active' AND progress_json->>'purpose'='information_monitoring'`)).rows).toHaveLength(1);
  });
  it.each([['2026-03-28T22:00:00.000Z', '2026-03-29T21:00:00.000Z', 23], ['2026-10-24T21:00:00.000Z', '2026-10-25T22:00:00.000Z', 25]])('persists the Europe/London due slot across a %s DST day', async (slot, next, hours) => {
    await accept({
      ...dailyScope(),
      timezone: 'Europe/London'
    });
    await db.pool.query(`UPDATE scheduler_tasks SET next_run_at=$2 WHERE task_key=$1 AND task_type='project_information_monitoring'`, [project, slot]);
    await enqueueDueMonitoring(db.pool, config(), new Date(slot));
    const task = await db.pool.query<{
      next_run_at: Date;
    }>(`SELECT next_run_at FROM scheduler_tasks WHERE task_key=$1 AND task_type='project_information_monitoring'`, [project]);
    expect(task.rows[0]!.next_run_at.toISOString()).toBe(next);
    expect((Date.parse(next) - Date.parse(slot)) / 3600000).toBe(hours);
    const op = await db.pool.query(`SELECT progress_json->>'slot' AS slot,progress_json->>'local_date' AS day FROM project_operations WHERE progress_json->>'purpose'='information_monitoring'`);
    expect(op.rows).toEqual([{
      slot,
      day: slot.slice(0, 10)
    }]);
  });
  it('keeps one daily allowance across manual retries, approved versions and timezone changes', async () => {
    const version = await accept();
    const first = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'before-zone'
    });
    await consumeMonitoringBudget(db.pool, space, first.id, 'source_requests', 3);
    await db.pool.query(`UPDATE jobs SET status='failed' WHERE job_type='project_information_monitoring'`);
    const proposed = await service().propose(identity, project, {
      expected_active_version_id: version.id,
      idempotency_key: 'change-zone',
      config: {
        ...scope(),
        timezone: 'Pacific/Kiritimati'
      }
    });
    for (const dep of proposed.dependencies ?? []) await new PgProposalApplyService(config()).accept(String(dep.id), identity);
    await new PgProposalApplyService(config()).accept(String(proposed.proposal.id), identity);
    const next = (await service().state(identity, project)).active!;
    await service().setPaused(identity, project, next.id, false);
    const second = await service().start(identity, project, {
      version_id: next.id,
      config_hash: next.config_hash,
      kind: 'check',
      idempotency_key: 'after-zone'
    });
    await expect(consumeMonitoringBudget(db.pool, space, second.id, 'source_requests', 2)).rejects.toMatchObject({
      reason: 'budget'
    });
    const gates = await db.pool.query(`SELECT progress_json->'used' AS used,status FROM project_operations WHERE progress_json->>'purpose'='information_monitoring_budget'`);
    expect(gates.rows).toEqual([{
      used: {
        source_requests: 3
      },
      status: 'completed'
    }]);
  });
  it('reports no_new only after a recent window actually exhausts, and does not raise history caps', async () => {
    const version = await accept({
      ...dailyScope(),
      schedule: {
        ...dailyScope().schedule,
        recent_window_candidates: 1
      },
      batch: {
        ...limits,
        candidates: 4
      },
      daily: {
        ...limits,
        candidates: 4
      }
    });
    __setArxivThrottleForTests({
      minIntervalMs: 0
    });
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>', {
      status: 200
    }));
    const before = await service().state(identity, project);
    expect(before.latest_run).toBeNull();
    const run = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'check',
      idempotency_key: 'empty-recent'
    });
    await executeMonitoringOperation(db.pool, config(), space, run.id, publicAddressGuard);
    expect(http).toHaveBeenCalledTimes(2);
    expect((await service().state(identity, project)).latest_run?.progress).toMatchObject({
      coverage: 'no_new',
      phase: 'completed'
    });
    const plan = await db.pool.query(`SELECT strategy_json->>'max_items' AS cap FROM source_backfill_plans WHERE id=$1`, [version.backfill_plan_id]);
    expect(Number(plan.rows[0].cap)).toBe(dailyScope().total_candidates);
  });
  it('allows history only after a recent window is exhausted or has a real terminal Source failure', async () => {
    const version = await accept({
      ...dailyScope(),
      schedule: {
        ...dailyScope().schedule,
        recent_window_candidates: 1
      },
      batch: {
        ...limits,
        candidates: 4
      },
      daily: {
        ...limits,
        candidates: 4
      }
    });
    __setArxivThrottleForTests({
      minIntervalMs: 0
    });
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(calls++ === 0 ? 'upstream invalid query' : '<feed xmlns="http://www.w3.org/2005/Atom"></feed>', {
      status: calls === 1 ? 400 : 200
    }));
    const run = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'check',
      idempotency_key: 'source-failed-history'
    });
    await executeMonitoringOperation(db.pool, config(), space, run.id, publicAddressGuard);
    expect(calls).toBe(2);
    expect((await service().state(identity, project)).latest_run?.progress).toMatchObject({
      reason: 'source_failed',
      coverage: 'source_failed'
    });
    expect((await db.pool.query(`SELECT attempt_count,status FROM source_backfill_segments WHERE plan_id=$1`, [version.backfill_plan_id])).rows[0]).toMatchObject({
      attempt_count: 1,
      status: 'succeeded'
    });
  });
  it('recent pagination blocks history, persists offsets and resumes after the next budget window', async () => {
    const cfg = {
      ...dailyScope(),
      batch: {
        ...limits,
        candidates: 1,
        pages: 1
      },
      daily: {
        ...limits,
        candidates: 1,
        pages: 1
      }
    };
    const version = await accept(cfg);
    __setArxivThrottleForTests({
      minIntervalMs: 0
    });
    const starts: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const request = new URL(String(url));
      starts.push(request.searchParams.get('start')!);
      return new Response(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2610.00001v1</id><title>New agents</title><summary>New agents.</summary><published>2026-10-24T00:00:00Z</published><updated>2026-10-24T00:00:00Z</updated></entry></feed>`, {
        status: 200
      });
    });
    const run = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'check',
      idempotency_key: 'recent-1'
    });
    await executeMonitoringOperation(db.pool, config(), space, run.id, publicAddressGuard);
    const recent = await db.pool.query<{
      id: string;
      window_json: Record<string, unknown>;
      status: string;
    }>(`SELECT s.id,s.window_json,s.status FROM source_backfill_segments s JOIN source_backfill_plans p ON p.id=s.plan_id WHERE p.strategy_json->>'monitoring_purpose'='recent'`);
    expect(recent.rows[0]?.status).toBe('pending');
    expect(recent.rows[0]?.window_json).toMatchObject({
      offset: 1
    });
    expect((await db.pool.query(`SELECT attempt_count FROM source_backfill_segments WHERE plan_id=$1`, [version.backfill_plan_id])).rows[0].attempt_count).toBe(0);
    await db.pool.query(`UPDATE project_operations SET progress_json=jsonb_set(jsonb_set(progress_json,'{period_start}',to_jsonb((now()-interval '2 days')::text)),'{period_end}',to_jsonb((now()-interval '1 day')::text)) WHERE progress_json->>'purpose'='information_monitoring_budget'`);
    const resumed = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'check',
      idempotency_key: 'recent-2'
    });
    await executeMonitoringOperation(db.pool, config(), space, resumed.id, publicAddressGuard);
    expect(starts).toEqual(['0', '1']); // Same recent window resumes its persisted offset.
    const older = await db.pool.query(`SELECT window_json->>'offset' AS offset FROM source_backfill_segments WHERE id=$1`, [recent.rows[0]!.id]);
    expect(older.rows[0].offset).toBe('2');
    const nextSlot = new Date(Date.now() + 1000).toISOString();
    await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'check',
      idempotency_key: 'daily-after-manual'
    }, nextSlot);
    const ordered = await monitoringAcquisitionPlans(db.pool, space, channel, version.backfill_plan_id!);
    expect(ordered).toHaveLength(3);
    const latest = await db.pool.query(`SELECT strategy_json->>'to' AS cutoff FROM source_backfill_plans WHERE id=$1`, [ordered[0]]);
    expect(latest.rows[0].cutoff).toBe(nextSlot);
    expect(ordered.at(-1)).toBe(version.backfill_plan_id);
    await db.pool.query(`UPDATE source_backfill_segments SET status='succeeded',window_json=window_json||'{"exhausted":true,"partial":false}'::jsonb WHERE plan_id=$1`, [ordered[0]]);
    await db.pool.query(`UPDATE source_backfill_plans SET status='completed',items_ingested=0 WHERE id=$1`, [ordered[0]]);
    // A newer empty window cannot erase the older exact-offset backlog.
    expect(await monitoringRecentCoverage(db.pool, space, channel)).toBe('coverage_partial');
  });
});
