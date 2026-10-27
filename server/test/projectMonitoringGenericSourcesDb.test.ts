import { seedSpaceMember } from './support/domainSeeds.js';
import type { ProjectMonitoringConfig } from '@rainver/protocol';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { monitoringFixture } from './support/monitoringFixture.js';
import { executeMonitoringOperation } from '../src/modules/projects/monitoring/worker.js';
import { PgReaderRepository } from '../src/modules/reader/repository.js';
import { SourceExtractionWorker } from '../src/modules/sources/extractionWorker.js';
import { publicAddressGuard } from './support/outboundGuard.js';
import { RunOrchestrationService } from '../src/modules/runs/orchestrationService.js';
afterEach(() => { vi.restoreAllMocks(); });
const {
  db,
  space,
  owner,
  project,
  channel,
  connection,
  identity,
  config,
  service,
  scope,
  accept
} = monitoringFixture(import.meta.filename);
async function source(kind: 'rss' | 'web_page', overrides: Partial<ProjectMonitoringConfig> = {}) {
  await db.pool.query(`DELETE FROM source_search_specs WHERE source_channel_id=$1`, [channel]);
  await db.pool.query(`UPDATE source_connectors SET connector_key=$1`, [kind]);
  await db.pool.query(`UPDATE source_providers SET provider_key=$1`, [kind === 'rss' ? 'generic_rss' : 'generic_web_page']);
  await db.pool.query(`UPDATE source_channels SET channel_type=$2,endpoint_url='https://example.com/updates',query_fingerprint='generic-confirmed',query_json='{}',provider_query_json='{}' WHERE id=$1`, [channel, kind === 'rss' ? 'feed' : 'web_page']);
  if (kind === 'web_page') await db.pool.query(`UPDATE source_connections SET policy_json=policy_json||'{"retention_policy":"full_text"}'::jsonb WHERE id=$1`, [connection]);
  return accept({
    ...scope(),
    incremental_strategy: kind === 'rss' ? 'new_items' : 'page_changes',
    total_candidates: 10,
    batch: {
      candidates: 10,
      pages: 2,
      source_requests: 4,
      model_runs: 6
    },
    daily: {
      candidates: 100,
      pages: 20,
      source_requests: 40,
      model_runs: 20
    },
    ...overrides
  });
}
function model() {
  return vi.spyOn(RunOrchestrationService.prototype, 'executeRun').mockImplementation(async input => {
    const run = (await db.pool.query(`SELECT prompt,instruction FROM runs WHERE id=$1`, [input.run_id])).rows[0];
    const items = (await db.pool.query(`SELECT id FROM source_items WHERE space_id=$1 AND metadata_json->>'monitoring_page_baseline' IS DISTINCT FROM 'true'`, [space])).rows.filter(item=>String(run.instruction).includes(item.id));
    const result = run.prompt === 'Classify incoming source material.' ? {
      schema: 'source_annotation.result.v2',
      annotations: items.map(i => ({
        source_item_id: i.id,
        domain_key: 'artificial_intelligence',
        depth: 'overview',
        genre: 'news',
        summary: 'Captured update summary.',
        topic_candidates: ['agents'],
        stance_target: null,
        stance_polarity: 'neutral',
        stance_confidence: 80
      }))
    } : {
      schema: 'source_post_processing.result.v1',
      item_decisions: items.map(i => ({
        source_item_id: i.id,
        relevance: 'relevant',
        confidence: 0.9,
        reason: 'Matches confirmed direction.',
        matched_context_refs: []
      }))
    };
    await db.pool.query(`UPDATE runs r SET status='succeeded',output_json=$2::jsonb,runtime_profile_id=p.id,runtime_profile_selection_source='default',runtime_key=p.runtime_key,runtime_profile_snapshot_json=jsonb_build_object('id',p.id,'runtime_key',p.runtime_key,'backend_mode',p.backend_mode,'runtime_config_json',p.runtime_config_json,'runtime_policy_json',p.runtime_policy_json) FROM agent_runtime_profiles p WHERE r.id=$1 AND p.agent_id=r.agent_id AND p.is_default=true AND p.enabled=true`, [input.run_id, JSON.stringify({
      schema_version: 'run_output.v1',
      result
    })]);
    return {
      run_id: input.run_id,
      status: 'succeeded' as const
    };
  });
}
async function run(version: Awaited<ReturnType<typeof accept>>, kind: 'initial' | 'check' = 'check', allowSourceFailure = false) {
  const operation = await service().start(identity, project, {
    version_id: version.id,
    config_hash: version.config_hash,
    kind,
    idempotency_key: randomUUID()
  });
  await executeMonitoringOperation(db.pool, config(), space, operation.id, publicAddressGuard);
  const state = await service().state(identity, project);
  expect(state.latest_run?.progress.reason).not.toBe('processing_failed');
  if (!allowSourceFailure) expect(state.latest_run?.progress.reason, JSON.stringify((await db.pool.query(`SELECT error_message,error_code,metadata_json FROM extraction_jobs WHERE space_id=$1`, [space])).rows)).not.toBe('source_failed');
  return state;
}
const feed = (entries: string) => `<rss version="2.0"><channel><title>Updates</title>${entries}</channel></rss>`;
const entry = (id: number, text = 'Agent release') => `<item><guid>entry-${id}</guid><title>${text}</title><link>https://example.com/news/${id}</link><description>Reliable agents update ${id}</description><pubDate>Sun, 01 Feb 2026 12:00:00 GMT</pubDate></item>`;
const page = (body: string, chrome = 'Nav', style = 'red') => `<html><head><title>Release notes</title><style>p {color:${style}}</style></head><body><nav>${chrome}</nav><main><h1>Agent release</h1><p>${body}</p></main><footer>Copyright ${chrome}</footer></body></html>`;
describe('Generic monitoring through the existing Sources pipeline', () => {
  it.each([1, 3])('charges every redirect send with a request cap of %s and preserves the cursor on refusal', async cap => {
    const version = await source('rss',{batch:{candidates:10,pages:2,source_requests:cap,model_runs:6}});
    model();
    const http = vi.spyOn(globalThis,'fetch').mockImplementation(async input => {
      const url=String(input);
      if(url.endsWith('/updates')) return new Response(null,{status:302,headers:{location:'https://example.com/hop'}});
      if(url.endsWith('/hop')) return new Response(null,{status:302,headers:{location:'https://example.com/final'}});
      return new Response(feed(entry(1)),{headers:{'content-type':'application/rss+xml'}});
    });
    const state=await run(version,'initial');
    expect(http).toHaveBeenCalledTimes(cap);
    expect((state.latest_run?.progress.used as Record<string,number>)?.source_requests).toBe(cap);
    if(cap===1){
      expect(state.latest_run?.progress.reason).toBe('quota_paused');
      const segment=(await db.pool.query(`SELECT status,window_json,attempt_count FROM source_backfill_segments WHERE plan_id=$1`,[version.backfill_plan_id])).rows[0];
      expect(segment.status).toBe('pending');
      expect(Number(segment.window_json.consumed_items??0)).toBe(0);
      expect(segment.attempt_count).toBe(0);
    }else expect(state.candidates).toHaveLength(1);
  });
  it('retries an approved failed history range without a new approval or resetting spent budget', async()=>{
    const version=await source('rss'); model();
    const http=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:404}));
    const failed=await run(version,'initial',true);
    expect(failed.latest_run?.progress.reason).toBe('source_failed');
    http.mockImplementation(async()=>new Response(feed(entry(1)),{headers:{'content-type':'application/rss+xml'}}));
    // Run now is the explicit retry decision; the same accepted plan and cap remain.
    const recovered=await run(version,'initial');
    expect(http).toHaveBeenCalledTimes(2);
    expect(recovered.candidates).toHaveLength(1);
    expect((await db.pool.query(`SELECT status,proposal_id FROM source_backfill_plans WHERE id=$1`,[version.backfill_plan_id])).rows[0].status).toBe('completed');
    const attempts=(await db.pool.query(`SELECT attempt_count FROM source_backfill_segments WHERE plan_id=$1`,[version.backfill_plan_id])).rows[0].attempt_count;
    expect(attempts).toBe(2);
    expect((await db.pool.query(`SELECT (progress_json->'used'->>'source_requests')::int AS spent FROM project_operations WHERE space_id=$1 AND progress_json->>'purpose'='information_monitoring_budget'`,[space])).rows[0].spent).toBe(2);
  });
  it('retries a failed recent window on the same day and clears the resolved coverage gap',async()=>{
    const version=await source('rss'); model();
    const http=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(feed(entry(1)),{headers:{'content-type':'application/rss+xml'}}));
    await run(version,'initial');
    http.mockResolvedValue(new Response(null,{status:400}));
    expect((await run(version,'check',true)).latest_run?.progress.reason).toBe('source_failed');
    const failed=(await db.pool.query(`SELECT s.id,s.window_json,s.attempt_count FROM source_backfill_segments s JOIN source_backfill_plans p ON p.id=s.plan_id WHERE p.strategy_json->>'monitoring_purpose'='recent' AND p.space_id=$1`,[space])).rows[0];
    http.mockImplementation(async()=>new Response(feed(entry(2)),{headers:{'content-type':'application/rss+xml'}}));
    const recovered=await run(version);
    expect(http).toHaveBeenCalledTimes(3);
    expect(recovered.candidates).toHaveLength(2);
    expect(recovered.latest_run?.progress.coverage).toBe('current_only');
    expect((await db.pool.query(`SELECT status,attempt_count FROM source_backfill_segments WHERE id=$1`,[failed.id])).rows[0]).toMatchObject({status:'succeeded',attempt_count:failed.attempt_count+1});
  });
  it('reports an older unresolved failure as a coverage gap after a successful daily observation',async()=>{
    const version=await source('rss',{schedule:{recent_window_candidates:10,collection_time:'22:00',stop_time:'23:45',digest_time:'07:00'}}); model();
    const http=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(feed(entry(1)),{headers:{'content-type':'application/rss+xml'}}));
    await run(version,'initial');
    http.mockResolvedValue(new Response(null,{status:400}));
    await run(version,'check',true);
    http.mockImplementation(async()=>new Response(feed(entry(2)),{headers:{'content-type':'application/rss+xml'}}));
    const op=await service().start(identity,project,{version_id:version.id,config_hash:version.config_hash,kind:'check',idempotency_key:'successful-daily'},new Date().toISOString());
    await executeMonitoringOperation(db.pool,config(),space,op.id,publicAddressGuard);
    const state=await service().state(identity,project);
    expect(http).toHaveBeenCalledTimes(3);
    expect(state.latest_run?.progress.coverage).toBe('coverage_partial');
    expect(state.latest_run?.progress.reason).not.toBe('source_failed');
    expect(state.latest_run?.progress.phase).toBe('partial');
    expect(state.candidates).toHaveLength(2);
  });
  it('keeps a permission-blocked page cursor pending and detects the change after audience recovery',async()=>{
    const version=await source('web_page'); model();
    let payload=page('Version one.');
    const http=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(payload,{headers:{'content-type':'text/html'}}));
    await run(version,'initial');
    const viewer=randomUUID();
    await seedSpaceMember(db.pool,{space,user:viewer,role:'member'});
    await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())`,[randomUUID(),space,project,viewer]);
    await db.pool.query(`UPDATE source_connections SET consent_json=consent_json||jsonb_build_object('allowed_reader_user_ids',jsonb_build_array($2::text),'allow_space_admins',false) WHERE id=$1`,[connection,owner]);
    payload=page('Version two has a substantive new capability.');
    const blocked=await run(version);
    expect(blocked.latest_run?.progress.reason).toBe('admission_blocked');
    expect((await db.pool.query(`SELECT s.status FROM source_backfill_segments s JOIN source_backfill_plans p ON p.id=s.plan_id WHERE p.space_id=$1 AND p.strategy_json->>'monitoring_purpose'='recent'`,[space])).rows[0].status).toBe('pending');
    await db.pool.query(`DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`,[project,viewer]);
    const recovered=await run(version);
    expect(http).toHaveBeenCalledTimes(3);
    expect(recovered.candidates).toHaveLength(1);
    expect(recovered.candidates[0]?.change).toBeDefined();
  });
  it('bounds retained feed excerpts to the confirmed total cap and releases exhausted payloads',async()=>{
    const version=await source('rss',{total_candidates:3,batch:{candidates:2,pages:1,source_requests:4,model_runs:6}}); model();
    const http=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(feed(Array.from({length:1000},(_,i)=>entry(i)).join('')),{headers:{'content-type':'application/rss+xml'}}));
    await run(version,'initial');
    const job=(await db.pool.query(`SELECT j.id,j.metadata_json FROM extraction_jobs j WHERE j.space_id=$1 AND j.metadata_json ? 'observation_items'`,[space])).rows[0];
    expect(job.metadata_json.observation_items).toHaveLength(3);
    await run(version,'initial');
    expect(http).toHaveBeenCalledTimes(1);
    expect((await db.pool.query(`SELECT metadata_json ? 'observation_items' AS retained FROM extraction_jobs WHERE id=$1`,[job.id])).rows[0].retained).toBe(false);
    expect((await service().state(identity,project)).candidates).toHaveLength(3);
  });

  it('delivers RSS entries, retains same URL identity on updates and only adds genuinely new entries', async () => {
    const version = await source('rss',{to:'2030-01-01T00:00:00.000Z'});
    model();
    let payload = feed(entry(1));
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(payload, {
      headers: {
        'content-type': 'application/rss+xml'
      }
    }));
    let state = await run(version, 'initial');
    expect(state.candidates).toHaveLength(1);
    expect(state.latest_run?.progress.coverage).toBe('current_only');
    expect(state.candidates[0]?.recommended, JSON.stringify(state.latest_run)).toBe(true);
    const first = state.candidates[0]!.id;
    payload = feed(entry(2) + entry(1, 'Updated title'));
    state = await run(version);
    expect(state.candidates).toHaveLength(2);
    const second=state.candidates.find(c=>c.id!==first)!;
    expect((await db.pool.query(`SELECT relevance FROM source_post_processing_item_decisions WHERE source_item_id=$1`,[second.id])).rows).toEqual([{relevance:'relevant'}]);
    expect(state.candidates.some(c => c.id === first)).toBe(true);
    payload = feed(entry(1, 'Updated title') + entry(2));
    await run(version);
    expect((await db.pool.query(`SELECT id FROM source_items WHERE space_id=$1`, [space])).rows).toHaveLength(2);
    expect(http).toHaveBeenCalledTimes(3);
    expect(state.available_sources[0]?.history_supported).toBe(false);
    expect((await db.pool.query(`SELECT strategy_json FROM source_backfill_plans WHERE id=$1`, [version.backfill_plan_id])).rows[0].strategy_json.history_mode).toBe('current_snapshot');
  });
  it('captures a baseline, ignores unchanged/style/chrome noise, and links immutable before/after evidence for a substantive change', async () => {
    const version = await source('web_page');
    model();
    let payload = page('Version one supports agents.');
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(payload, {
      headers: {
        'content-type': 'text/html'
      }
    }));
    expect((await run(version, 'initial')).candidates).toHaveLength(0);
    expect((await run(version)).candidates).toHaveLength(0);
    await db.pool.query(`UPDATE source_items SET content_hash='ordinary-scan-hash' WHERE space_id=$1 AND canonical_uri='https://example.com/updates'`,[space]);
    payload = page('Version one supports agents.', 'New navigation', 'blue');
    expect((await run(version)).candidates).toHaveLength(0);
    expect((await db.pool.query(`SELECT id FROM source_snapshots WHERE snapshot_type='extracted' AND space_id=$1`, [space])).rows).toHaveLength(1);
    payload = page('Version two removes unsafe autonomous execution.');
    const state = await run(version);
    expect(state.candidates).toHaveLength(1);
    const change = state.candidates[0]!;
    expect(change.change).toBeDefined();
    expect(change.source_uri).toBe('https://example.com/updates');
    const versions = await db.pool.query(`SELECT s.id,a.content FROM source_snapshots s JOIN artifacts a ON a.id=s.artifact_id WHERE s.id=ANY($1::varchar[])`, [[change.change!.before_snapshot_id, change.change!.after_snapshot_id]]);
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows.map(r => JSON.parse(r.content).plain_text).join('\n')).toContain('Version two');
    const document = await db.pool.query(`SELECT a.content,i.item_type,i.canonical_uri,i.source_uri FROM source_items i JOIN artifacts a ON a.id=i.extracted_artifact_id WHERE i.id=$1`, [change.id]);
    expect(document.rows[0]).toMatchObject({
      item_type: 'document',
      canonical_uri: null,
      source_uri: null
    });
    expect(JSON.parse(document.rows[0].content).plain_text).toContain('Version one');
    expect(JSON.parse(document.rows[0].content).plain_text).toContain('Version two');
    const reader = await new PgReaderRepository(db.pool, config()).getDocument(identity, 'source_item', change.id);
    expect(reader?.plain_text).toContain('Version one');
    expect(reader?.plain_text).toContain('Version two');
    for (const id of [change.change!.before_snapshot_id, change.change!.after_snapshot_id]) expect(await new PgReaderRepository(db.pool, config()).getDocument(identity, 'source_snapshot', id)).toBeTruthy();
    await run(version);
    expect((await service().state(identity, project)).candidates).toHaveLength(1);
    expect(http).toHaveBeenCalledTimes(5);
    // Returning to an already observed content revision must not rewrite its old Reader evidence.
    const frozenDocument = document.rows[0].content;
    payload = page('Version one supports agents.');
    await run(version);
    payload = page('Version two removes unsafe autonomous execution.');
    await run(version);
    expect((await db.pool.query(`SELECT a.content FROM source_items i JOIN artifacts a ON a.id=i.extracted_artifact_id WHERE i.id=$1`, [change.id])).rows[0].content).toBe(frozenDocument);
    expect((await db.pool.query(`SELECT id FROM source_items WHERE space_id=$1 AND metadata_json->>'after_hash'=$2`, [space, (await db.pool.query(`SELECT metadata_json->>'after_hash' AS hash FROM source_items WHERE id=$1`, [change.id])).rows[0].hash])).rows).toHaveLength(1);
    await db.pool.query(`UPDATE source_connections SET consent_json=consent_json||'{"allowed_reader_user_ids":[],"allow_space_admins":false}'::jsonb,status='archived' WHERE id=$1`, [connection]);
    expect((await service().state(identity, project)).candidates).toHaveLength(0);
    await expect(new PgReaderRepository(db.pool, config()).getDocument(identity, 'source_item', change.id)).rejects.toThrow();
  });
  it('prepares generic Sources as paused owner proposals and rejects page retention or fingerprint drift before HTTP', async () => {
    const version = await source('web_page');
    const http = vi.spyOn(globalThis, 'fetch');
    const setup = await service().setup(identity, project, {
      provider_key: 'web_page',
      query: 'https://example.com/second',
      idempotency_key: 'page-setup'
    });
    expect(setup.source_proposal!.status).toBe('pending');
    expect(setup.binding_proposal!.status).toBe('pending');
    const draft = (await db.pool.query(`SELECT ch.fetch_frequency,ch.status,sc.status AS connection_status,sc.policy_json,sc.config_json FROM source_channels ch JOIN source_connections sc ON sc.id=ch.source_connection_id AND sc.space_id=ch.space_id WHERE ch.id=$1 AND ch.space_id=$2`, [setup.channel_draft.id, space])).rows[0];
    expect(draft).toMatchObject({
      fetch_frequency: 'manual',
      status: 'paused',
      connection_status: 'paused'
    });
    expect(draft.policy_json.retention_policy).toBe('full_text');
    expect(draft.config_json.daily_inbox_briefing).toBe(false);
    await db.pool.query(`UPDATE source_connections SET policy_json=policy_json||'{"retention_policy":"summary_only"}'::jsonb WHERE id=$1`, [connection]);
    await expect(service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'denied-policy'
    })).rejects.toThrow(/retention/);
    await db.pool.query(`UPDATE source_connections SET policy_json=policy_json||'{"retention_policy":"full_text"}'::jsonb WHERE id=$1`, [connection]);
    await db.pool.query(`UPDATE source_channels SET query_fingerprint='changed-url' WHERE id=$1`, [channel]);
    await expect(service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'denied-url'
    })).rejects.toThrow(/query changed/);
    expect(http).not.toHaveBeenCalled();
  });
  it('retains a frozen feed cursor across quota pause and restart, checks new entries before the old remainder, and never refetches an expired feed for continuation', async () => {
    const version = await source('rss', {
      total_candidates: 3,
      batch: {
        candidates: 2,
        pages: 1,
        source_requests: 4,
        model_runs: 6
      },
      daily: {
        candidates: 4,
        pages: 10,
        source_requests: 20,
        model_runs: 20
      },
      schedule: {
        recent_window_candidates: 1,
        collection_time: '22:00',
        stop_time: '23:45',
        digest_time: '07:00'
      }
    });
    model();
    let payload = feed(entry(1) + entry(2) + entry(3));
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(payload, {
      headers: {
        'content-type': 'application/rss+xml'
      }
    }));
    await run(version, 'initial');
    let segment = (await db.pool.query(`SELECT window_json,status FROM source_backfill_segments WHERE plan_id=$1`, [version.backfill_plan_id])).rows[0];
    expect(segment.status).toBe('pending');
    expect(segment.window_json.consumed_items).toBe(2);
    expect(segment.window_json.observation_job_id).toBeTruthy();
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    await db.pool.query(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('period_start',$3::text,'period_end',$4::text) WHERE space_id=$1 AND project_id=$2 AND progress_json->>'purpose'='information_monitoring_budget'`, [space, project, new Date(start.getTime() - 86400000).toISOString(), start.toISOString()]);
    payload = feed(entry(99)); // upstream no longer contains the old remaining entry
    await run(version); // one page: current feed wins; no old backfill page is dispatched
    expect((await service().state(identity, project)).candidates.map(c => c.title)).toContain('Agent release');
    expect((await db.pool.query(`SELECT source_uri FROM source_items WHERE source_uri='https://example.com/news/99'`)).rows).toHaveLength(1);
    segment = (await db.pool.query(`SELECT window_json,status FROM source_backfill_segments WHERE plan_id=$1`, [version.backfill_plan_id])).rows[0];
    expect(segment.window_json.consumed_items).toBe(2);
    // A subsequent run replays the persisted old page at offset 2 after a completed recent window.
    const recent = (await db.pool.query(`SELECT id FROM source_backfill_plans WHERE space_id=$1 AND strategy_json->>'monitoring_purpose'='recent'`, [space])).rows[0].id;
    const {
      SourceBackfillExecutionService
    } = await import('../src/modules/sources/sourceBackfillExecutionService.js');
    const op = await service().start(identity, project, {
      version_id: version.id,
      config_hash: version.config_hash,
      kind: 'initial',
      idempotency_key: 'resume-frozen'
    });
    const dispatch = (await new SourceBackfillExecutionService(db.pool, op.id).executeNext(space, version.backfill_plan_id!)) as {
      job_id: string;
    };
    expect(dispatch.job_id).toBeTruthy();
    await new SourceExtractionWorker(db.pool, config(), publicAddressGuard, op.id).runPendingJob(dispatch.job_id, space);
    await new SourceBackfillExecutionService(db.pool, op.id).reconcile(space, version.backfill_plan_id!);
    expect((await db.pool.query(`SELECT id FROM source_items WHERE source_uri='https://example.com/news/3'`)).rows).toHaveLength(1);
    expect(http).toHaveBeenCalledTimes(2);
    expect((await db.pool.query(`SELECT status FROM source_backfill_plans WHERE id=$1`, [recent])).rows[0].status).toBe('completed');
  });
  it.each(['doi', 'arxiv', 'canonical'])('serializes ordinary scan and managed capture for the same %s identity and retains both source hits', async identityKind => {
    await accept();
    const other = randomUUID();
    await db.pool.query(`INSERT INTO source_channels(id,space_id,source_connection_id,created_by_user_id,name,channel_type,query_json,provider_query_json,query_fingerprint,status,fetch_frequency,created_at,updated_at) VALUES($1,$2,$3,$4,'Other','search','{}','{}','other','active','manual',now(),now())`, [other, space, connection, owner]);
    const worker = new SourceExtractionWorker(db.pool, config(), publicAddressGuard) as unknown as {
      upsertScannedItem(input: unknown): Promise<{
        itemId: string;
      }>;
    };
    const conn = (await db.pool.query(`SELECT * FROM source_connections WHERE id=$1`, [connection])).rows[0];
    const item = (ch: string, index: number) => ({
      job: {
        id: randomUUID(),
        space_id: space,
        metadata_json: index === 1 ? {
          monitoring_operation_id: randomUUID()
        } : {}
      },
      connection: {
        ...conn,
        channel_id: ch,
        connector_key: 'arxiv_api'
      },
      itemType: 'feed_entry',
      title: 'Same content',
      sourceUri: identityKind === 'canonical' ? 'https://example.com/same' : `https://example.com/${index}`,
      canonicalUri: identityKind === 'canonical' ? 'https://example.com/same' : `https://example.com/${index}`,
      sourceExternalId: `${index}`,
      author: null,
      occurredAt: null,
      contentHash: `hash-${index}`,
      excerpt: 'Source abstract',
      metadata: identityKind === 'doi' ? {
        doi: index === 1 ? 'https://doi.org/10.1234/TEST' : '10.1234/test'
      } : identityKind === 'arxiv' ? {
        arxiv_id: '2601.12345'
      } : {},
      capturedAt: new Date().toISOString()
    });
    const result = await Promise.all([worker.upsertScannedItem(item(channel, 1)), worker.upsertScannedItem(item(other, 2))]);
    expect(new Set(result.map(r => r.itemId)).size).toBe(1);
    expect((await db.pool.query(`SELECT source_channel_id FROM source_channel_item_links WHERE source_item_id=$1`, [result[0]!.itemId])).rows).toHaveLength(2);
    expect((await db.pool.query(`SELECT id FROM source_items WHERE space_id=$1`, [space])).rows).toHaveLength(1);
  });
});
