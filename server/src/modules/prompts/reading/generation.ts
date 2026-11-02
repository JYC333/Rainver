import { readingMethodContext } from './methodContext.js';
import { startProviderGeneration } from './providerGeneration.js';
import { resolveRevisionMethod } from './revisionMethod.js';
import { ReadingMethodGenerationSchema, type ReadingMethodGenerationView } from '@rainver/protocol';
import { HttpError, withDbTransaction, withQueryableTransaction, type Pool, type Queryable, type SpaceUserIdentity } from '../../routeUtils/common.js';
import type { ServerConfig } from '../../../config.js';
import { PgRunRepository } from '../../runs/repository.js';
import { PgJobQueueRepository } from '../../jobs/repository.js';
import { PgConversationBackendRepository } from '../../sessions/conversationBackendRepository.js';
import { runFinalizationReconcilerRegistry } from '../../runs/finalizationReconcilerRegistry.js';
import { createManagedExecutionPolicy } from '../../policy/managedExecutionPolicy.js';
import { resolveSessionConfig, sessionConfigRunOverride } from '../../sessions/sessionConfig.js';
import { nativeProfileFingerprint } from '../../sources/goals/nativeRoute.js';
import { assertSafeGoalMessage } from '../../sources/goals/messageSafety.js';
import { lockEvolutionAssets } from '../../evolution/assetLocks.js';
import { normalizeVersionScopeForWrite, canViewVersionScope } from '../../evolution/assetAccess.js';
import { readingAsset } from './access.js';
import { freezeReadingMethod, READING_METHOD_KEY, readingStrategy } from './runtime.js';
import { closeReadingContext } from './closedContext.js';
import { sha256Json } from '../hash.js';
import { PromptRepository } from '../repository.js';
import { assertGenerationDispatch, assertGenerationReadable } from './generationAuthority.js';
import { GENERATION_KIND, GENERATION_SCHEMA, generationOf, generationTerminal, generatedOutput, type GenerationRef } from './generationContract.js';
async function ownedRun(db: Queryable, identity: SpaceUserIdentity, id: string) {
  const run = await new PgRunRepository(db).getRun(identity.spaceId, id);
  if (!run || run.instructed_by_user_id !== identity.userId || !generationOf(run)) throw new HttpError(404, 'Generation not found');
  return run;
}
const generationSql = `contract_snapshot_json->'workflow_input_json'->'reading_method_generation'`;
export async function startReadingGeneration(db: Pool, identity: SpaceUserIdentity, raw: unknown) {
  const parsed = ReadingMethodGenerationSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(422, parsed.error.message);
  const input = parsed.data;
  assertSafeGoalMessage(input.description);
  if (!input.agent_id && !input.runtime_profile_id) return startProviderGeneration(db, identity, input);
  if (!input.agent_id || !input.runtime_profile_id) throw new HttpError(422, 'Legacy execution requires both Agent and Profile');
  return withDbTransaction(db, async tx => {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`prompt-generation:${identity.spaceId}:${identity.userId}`]);
    const asset = await readingAsset(tx, identity,true,input.target_key);
    await lockEvolutionAssets(tx, [asset.id]);
    const ctx = await readingMethodContext(tx, identity, input.item_id, input.project_id);
    await normalizeVersionScopeForWrite(tx, identity, ctx.projectId ? 'project' : 'space', ctx.projectId ?? identity.spaceId);
    const effective = await freezeReadingMethod(tx, {
      ...identity,
      projectId: ctx.projectId
    }, null,input.target_key);
    if (effective.frozen.version_id !== input.parent_version_id || effective.frozen.content_hash !== input.parent_content_hash) throw new HttpError(409, 'Effective method changed; refresh before generating');
    const parent = (await tx.query(`SELECT * FROM evolvable_asset_versions WHERE id=$1 AND asset_id=$2`, [input.parent_version_id, asset.id])).rows[0];
    if (!parent || !(await canViewVersionScope(tx, identity, parent))) throw new HttpError(404, 'Parent method not found');
    await tx.query(`SELECT id FROM agents WHERE id=$1 AND space_id=$2 FOR SHARE`, [input.agent_id, identity.spaceId]);
    await tx.query(`SELECT id FROM agent_runtime_profiles WHERE id=$1 AND space_id=$2 AND agent_id=$3 FOR SHARE`, [input.runtime_profile_id, identity.spaceId, input.agent_id]);
    const option = (await new PgConversationBackendRepository(tx).listOptions(identity.spaceId, identity.userId, input.agent_id!)).find(p => p.runtime_profile_id === input.runtime_profile_id && p.usable !== false);
    if (!option) throw new HttpError(409, 'Choose a usable owned Agent runtime');
    if (!(await tx.query(`SELECT id FROM agents WHERE id=$1 AND space_id=$2 AND owner_user_id=$3 AND status='active'`, [input.agent_id, identity.spaceId, identity.userId])).rows.length) throw new HttpError(403, 'Use your own active Agent');
    const session = await resolveSessionConfig([], async () => [], option.session_config_options ?? []);
    const profileHash = await nativeProfileFingerprint(tx, input.runtime_profile_id!);
    if (input.retry_of) {
      const retry = await ownedRun(tx, identity, input.retry_of);
      if ((generationOf(retry)!.target_key??READING_METHOD_KEY)!==(input.target_key??READING_METHOD_KEY) || generationOf(retry)!.item_id !== (input.item_id ?? null) || generationOf(retry)!.project_id !== ctx.projectId || !generationTerminal.has(retry.status)) throw new HttpError(409, 'Retry must name a finished generation for this result');
      const view = await readReadingGeneration(tx, identity, retry.id);
      if (!['failed', 'degraded', 'cancelled', 'blocked', 'orphaned'].includes(view.status)) throw new HttpError(409, 'Only unsuccessful terminal generations may be retried');
    }
    const revisionMethod = await resolveRevisionMethod(tx, identity, ctx.projectId);
    const inputKey = sha256Json([revisionMethod.version_id, revisionMethod.content_hash, identity.userId, {...input,retry_of:undefined}, ctx.projectId, ctx.authority, profileHash, session.selections]);
    const key = sha256Json([inputKey,input.retry_of??null]);
    const old = (await tx.query<{
      id: string;
    }>(`SELECT id FROM runs WHERE space_id=$1 AND instructed_by_user_id=$2 AND ${generationSql}->>${input.retry_of?"'request_key'":"'input_key'"}=$3 ORDER BY created_at DESC,id DESC LIMIT 1`, [identity.spaceId, identity.userId, input.retry_of?key:inputKey])).rows[0];
    if (old) return readReadingGeneration(tx, identity, old.id);
    const counts = (await tx.query<{
      active: number;
      daily: number;
    }>(`SELECT count(*) FILTER (WHERE status IN ('queued','running','waiting_review','waiting_user'))::int active,count(*) FILTER (WHERE created_at>now()-interval '1 day')::int daily FROM runs WHERE space_id=$1 AND instructed_by_user_id=$2 AND ${generationSql} IS NOT NULL`, [identity.spaceId, identity.userId])).rows[0]!;
    if (counts.active) throw new HttpError(409, 'A reading-method generation is already running');
    if (counts.daily >= 3) throw new HttpError(429, 'At most three reading-method generations per day');
    const prompt = `${revisionMethod.text}
Return ONLY JSON with schema "${GENERATION_SCHEMA}", method (40..12000 characters), summary (1..1600 characters), and changes (1..8 strings, each 1..400 characters). The schema is code-owned.
<revision_input>${JSON.stringify({ baseline_method: effective.text, description: input.description })}</revision_input>`;
    const ref: GenerationRef = {
      kind: GENERATION_KIND,
      target_key: input.target_key,
      revision_method: revisionMethod,
      source_kind: 'description',
      item_id: ctx.item?.id ?? null,
      ...(!ctx.item ? {scope_only:true as const} : {}),
      project_id: ctx.projectId,
      authority: ctx.authority,
      parent_version_id: parent.id,
      parent_hash: parent.content_hash,
      description: input.description,
      prompt_hash: sha256Json(prompt),
      profile_hash: profileHash,
      session_config: session.selections,
      execution_name: `${option.runtime_key} · ${option.host_name??option.host_id} · ${option.name}`,
      request_key: key,
      input_key: inputKey
    };
    const run = await new PgRunRepository(tx).createQueuedRunWithBudgetAdmission({
      execution_kind: 'agent',
      space_id: identity.spaceId,
      user_id: identity.userId,
      agent_id: input.agent_id!,
      runtime_profile_id: input.runtime_profile_id,
      project_id: null,
      mode: 'live',
      run_type: 'agent',
      trigger_origin: 'manual',
      visibility: 'private',
      capabilities_json: [],
      scenario_tool_allowance: [],
      model_override_json: sessionConfigRunOverride(session),
      prompt,
      instruction: 'Revise only the strategy from supplied data. No tools, retrieval, browsing, file access, Source writes or deployment. Return the declared JSON object.',
      contract_snapshot: {
        source: {
          kind: 'direct',
          id: ctx.item?.id ?? asset.id
        },
        workflow_input_json: {
          reading_method_executor_only: true,
          reading_method_generation: ref
        },
        structured_output_json: {
          schema: GENERATION_SCHEMA
        },
        policy_context_json: createManagedExecutionPolicy('reading_method_generation', false),
        max_attempts: 1,
        max_duration_seconds: 180,
        risk_level: 'low'
      }
    });
    await closeReadingContext(tx, identity, run.id, input.agent_id!, input.runtime_profile_id!, null);
    await assertGenerationDispatch(tx, run);
    await new PgJobQueueRepository(tx).enqueue({
      job_type: 'agent_run',
      space_id: identity.spaceId,
      user_id: identity.userId,
      agent_id: input.agent_id!,
      payload: {
        run_id: run.id
      },
      max_attempts: 1
    });
    return readReadingGeneration(tx, identity, run.id);
  });
}
export async function readReadingGeneration(db: Queryable, identity: SpaceUserIdentity, id: string): Promise<ReadingMethodGenerationView> {
  const run = await ownedRun(db, identity, id),
    ref = generationOf(run)!;
  const base: ReadingMethodGenerationView = {
    id,
    status: run.status,
    visibility: 'visible',
    stale: false,
    description: null,
    parent_version_id: ref.parent_version_id,
    candidate_version_id: null,
    candidate_version: null,
    method: null,
    baseline_method: null,
    summary: null,
    changes: [],
    execution_name: null,
    seconds: null,
    cost_usd: null
  };
  try {
    await assertGenerationReadable(db, identity, run);
  } catch (e) {
    if (!(e instanceof HttpError) || ![403, 404, 409].includes(e.statusCode)) throw e;
    return {
      ...base,
      visibility: 'withheld'
    };
  }
  const candidate = (await db.query<{
    id: string;
    version: number;
    content_json: Record<string, unknown>;
  }>(`SELECT id,version,content_json FROM evolvable_asset_versions WHERE space_id=$1 AND content_json->'reading_generation'->>'origin_run_id'=$2 ORDER BY version LIMIT 1`, [identity.spaceId, id])).rows[0];
  const parent = (await db.query(`SELECT content_json FROM evolvable_asset_versions WHERE id=$1`, [ref.parent_version_id])).rows[0];
  let stale = false;
  try {
    await assertGenerationDispatch(db, run);
  } catch (e) {
    if (!(e instanceof HttpError) || ![403, 404, 409].includes(e.statusCode)) throw e;
    stale = true;
  }
  const output = generatedOutput(run);
  const status = candidate ? 'ready' : run.status === 'succeeded' ? !output ? 'failed' : stale ? 'blocked' : 'settling' : run.status;
  const cost = (await db.query<{
    cost: number | null;
  }>(`SELECT CASE WHEN count(*)=0 OR count(*) FILTER (WHERE estimated_cost_usd IS NULL)>0 THEN NULL ELSE sum(estimated_cost_usd)::float END cost FROM token_usage_events WHERE run_id=$1 AND space_id=$2`, [id, identity.spaceId])).rows[0]?.cost ?? null;
  return {
    ...base,
    status,
    stale,
    description: ref.description,
    execution_name: ref.execution_name,
    seconds: run.started_at && run.ended_at ? (Date.parse(run.ended_at) - Date.parse(run.started_at)) / 1000 : null,
    cost_usd: cost,
    baseline_method: parent ? readingStrategy(parent.content_json) : null,
    candidate_version_id: candidate?.id ?? null,
    candidate_version: candidate ? Number(candidate.version) : null,
    method: candidate ? readingStrategy(candidate.content_json) : null,
    summary: candidate ? output?.summary??null : null,
    changes: candidate ? output?.changes??[] : []
  };
}
export async function listReadingGenerations(db: Queryable, identity: SpaceUserIdentity, itemId: string | null, projectId: string | null, targetKey=READING_METHOD_KEY) {
  const ids = (await db.query<{
    id: string;
  }>(`SELECT id FROM runs WHERE space_id=$1 AND instructed_by_user_id=$2 AND ${generationSql} IS NOT NULL AND (${generationSql}->>'item_id' IS NULL OR ${generationSql}->>'item_id'=$3) AND ${generationSql}->>'project_id' IS NOT DISTINCT FROM $4 AND COALESCE(${generationSql}->>'target_key','reading.project_investigation')=$5 ORDER BY created_at DESC,id DESC LIMIT 10`, [identity.spaceId, identity.userId, itemId, projectId,targetKey])).rows;
  return Promise.all(ids.map(r => readReadingGeneration(db, identity, r.id)));
}
export async function cancelReadingGeneration(db: Pool, config: ServerConfig, identity: SpaceUserIdentity, id: string) {
  const run = await ownedRun(db, identity, id);
  if(run.execution_kind==='provider_task'){if(!generationTerminal.has(run.status))await new PgRunRepository(db).markRunTerminal({run_id:id,space_id:identity.spaceId,status:'cancelled',completed_at:new Date().toISOString()});return readReadingGeneration(db,identity,id);}
  if (!generationTerminal.has(run.status)) await (await import('../../runs/orchestrationFactory.js')).buildRunOrchestration(config).orchestration.cancelRun({
    space_id: identity.spaceId,
    run_id: id,
    requested_by_user_id: identity.userId
  });
  return readReadingGeneration(db, identity, id);
}
export function registerReadingGenerationSettlement() {
  runFinalizationReconcilerRegistry.register('reading_method_generation', {
    async reconcile(pool, snapshot) {
      if (!generationOf(snapshot)) return;
      await withQueryableTransaction(pool, async tx => {
        const identity = {
          spaceId: snapshot.space_id,
          userId: snapshot.instructed_by_user_id!
        };
        // Canonical asset → audience/Source → Run lock order. Read the current terminal attempt, not the callback snapshot.
        let asset:Awaited<ReturnType<typeof readingAsset>>;
        try{asset=await readingAsset(tx,identity,false,generationOf(snapshot)?.target_key);}catch(e){if(e instanceof HttpError&&[403,404,409].includes(e.statusCode))return;throw e;}
        await lockEvolutionAssets(tx, [asset.id]);
        try {
          await (await import('../../runtimeContext/index.js')).lockReadingRunAuthority(tx, snapshot);
        } catch (e) {
          if (e instanceof HttpError && [403, 404, 409].includes(e.statusCode)) return;
          throw e;
        }
        await tx.query(`SELECT id FROM runs WHERE id=$1 AND space_id=$2 FOR SHARE`, [snapshot.id, snapshot.space_id]);
        const run = await new PgRunRepository(tx).getRun(snapshot.space_id, snapshot.id);
        if (!run || run.status !== 'succeeded' || JSON.stringify(run.output_json) !== JSON.stringify(snapshot.output_json)) return;
        const attempt = await new PgRunRepository(tx).getLatestRunAttempt(run.space_id, run.id);
        if (attempt && attempt.attempt_number !== 1) return;
        const ref = generationOf(run)!;
        if ((await tx.query(`SELECT id FROM evolvable_asset_versions WHERE space_id=$1 AND content_json->'reading_generation'->>'origin_run_id'=$2`, [identity.spaceId, run.id])).rows.length) return;
        const output = generatedOutput(run);
        if (!output) return;
        try {
          await assertGenerationDispatch(tx, run);
        } catch (e) {
          if (e instanceof HttpError && [403, 404, 409].includes(e.statusCode)) return;
          throw e;
        }
        const parent = (await tx.query(`SELECT content_json FROM evolvable_asset_versions WHERE id=$1 AND asset_id=$2`, [ref.parent_version_id, asset.id])).rows[0];
        if (!parent) return;
        const content = {
          ...(parent.content_json as Record<string, unknown>),
          template: output.method,
          messages: undefined,
          reading_reason: undefined,
          reading_change_summary: undefined,
          reading_changes: undefined,
          reading_generation: {
            origin_run_id: run.id
          }
        };
        try {
          readingStrategy(content);
        } catch (e) {
          if (e instanceof HttpError) return;
          throw e;
        }
        await new PromptRepository(tx).createVersion(identity, ref.target_key??READING_METHOD_KEY, {
          parent_version_id: ref.parent_version_id,
          scope_type: ref.project_id ? 'project' : 'space',
          scope_id: ref.project_id ?? identity.spaceId,
          source: 'generated',
          content_json: content
        }, {
          trustedReadingGeneration: true
        });
      });
    }
  }, 'prompts');
}
