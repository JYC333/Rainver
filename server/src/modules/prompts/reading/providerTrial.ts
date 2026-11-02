import {comparisonPrompt,assertRevisionSample} from './comparisonPrompt.js';
import { ReadingMethodTrialSchema, PROMPT_REVISION_FIXTURE, ReadingMethodGeneratedOutputSchema } from '@rainver/protocol';
import type { z } from 'zod';
import { HttpError, withDbTransaction, withQueryableTransaction, type Pool, type SpaceUserIdentity } from '../../routeUtils/common.js';
import type { ServerConfig } from '../../../config.js';
import { readingItemContext } from '../../sources/index.js';
import { readingAsset, readingCandidate } from './access.js';
import { lockEvolutionAssets } from '../../evolution/assetLocks.js';
import { freezeReadingMethod, readingStrategy } from './runtime.js';
import { assertSampleAuthority } from './sampleAuthority.js';
import { sha256Json } from '../hash.js';
import { revisionProvider, assertRevisionProvider, type RevisionProvider } from './revisionProvider.js';
import { PgRunRepository } from '../../runs/repository.js';
import { EvolvableAssetRepository } from '../../evolution/assetRepository.js';
import { EvolvableAssetEvaluationRepository } from '../../evolution/assetEvaluationRepository.js';
import { enqueueProviderTaskRunJob, providerTaskRunPreparers } from '../../runs/providerTaskRunHandler.js';
import { PAIR_EVALUATOR, readReadingTrial, assertReadingTrialRun, registerReadingTrialSettlement, type PairRef, authorizedPair, trialContext } from './trials.js';
import { runFinalizationReconcilerRegistry } from '../../runs/finalizationReconcilerRegistry.js';
import { canonicalRunOutput } from '../../runs/orchestrationResults.js';
const CAPABILITY = 'prompt_method_comparison';
export async function startProviderTrial(db: Pool, _config: ServerConfig, identity: SpaceUserIdentity, input: z.infer<typeof ReadingMethodTrialSchema>) {
  return withDbTransaction(db, async tx => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`prompt-comparison:${identity.spaceId}:${identity.userId}`]);
    const asset = await readingAsset(tx, identity, true, input.target_key);
    await lockEvolutionAssets(tx, [asset.id]);
    const ctx = await readingItemContext(tx, identity, input.item_id, input.project_id);
    const {
      version
    } = await readingCandidate(tx, identity, input.candidate_version_id, ctx.projectId, input.target_key);
    const candidate = (await tx.query(`SELECT * FROM evolvable_asset_versions WHERE id=$1 FOR UPDATE`, [version.id])).rows[0]!;
    if (candidate.content_hash !== input.candidate_content_hash) throw new HttpError(409, 'Candidate changed');
    const sample = (await tx.query(`SELECT * FROM evaluation_cases WHERE id=$1 AND space_id=$2 AND asset_id=$3 AND created_by_user_id=$4 AND status='active'`, [input.case_id, identity.spaceId, asset.id, identity.userId])).rows[0];
    if (!sample || sample.input_json?.reading_item_id !== ctx.item.id || sample.input_json?.project_id !== ctx.projectId) throw new HttpError(404, 'Comparison sample unavailable');
    if (sample.input_json.authority !== ctx.authority || sample.input_json.context_hash !== sha256Json(ctx.context)) throw new HttpError(409, 'Comparison sample stale');
    await assertSampleAuthority(tx, identity, ctx, sample.input_json);
    assertRevisionSample(input.target_key,sample.input_json.pages);
    const baseline = await freezeReadingMethod(tx, {
      ...identity,
      projectId: ctx.projectId
    }, ctx.context, input.target_key);
    const provider = await revisionProvider(tx, identity, input.provider_id, input.model, true);
    await assertRevisionProvider(tx, identity, provider, ctx.source?.id ?? null, true);
    if (input.retry_of) {
      const prior = await authorizedPair(tx, identity, input.retry_of);
      if (prior.ref.item_id !== ctx.item.id || prior.row.candidate_version_id !== candidate.id || !['failed', 'blocked', 'cancelled'].includes(prior.row.status)) throw new HttpError(409, 'Only this unsuccessful terminal comparison may be retried');
    }
    const key = sha256Json([identity.userId, input, ctx.authority, baseline.frozen, provider, sample.input_json]);
    const prior = (await tx.query(`SELECT id FROM evolvable_asset_evaluation_runs WHERE space_id=$1 AND asset_id=$2 AND evaluator_version=$3 AND eval_suite_ref_json->>'request_key'=$4`, [identity.spaceId, asset.id, PAIR_EVALUATOR, key])).rows[0];
    if (prior) return readReadingTrial(tx, identity, String(prior.id));
    const counts = (await tx.query(`SELECT count(*) FILTER(WHERE status IN ('queued','running'))::int active,count(*) FILTER(WHERE created_at>now()-interval '1 day')::int daily FROM evolvable_asset_evaluation_runs WHERE space_id=$1 AND created_by_user_id=$2 AND evaluator_version=$3`, [identity.spaceId, identity.userId, PAIR_EVALUATOR])).rows[0];
    if (counts.active) throw new HttpError(409, 'A comparison is running');
    if (counts.daily >= 3) throw new HttpError(429, 'At most three comparisons per day');
    if (candidate.status === 'draft') await new EvolvableAssetRepository(tx).transitionVersionStatus(identity, asset.id, String(candidate.id), {
      status: 'candidate'
    });
    const evaluation = await new EvolvableAssetEvaluationRepository(tx).recordEvaluationRun(identity, asset.id, String(candidate.id), {
      baseline_version_id: baseline.frozen.version_id,
      eval_suite_ref: {
        kind: PAIR_EVALUATOR
      },
      evaluator_version: PAIR_EVALUATOR,
      status: 'queued'
    }, {
      trustedExecutor: true
    });
    const ids: string[] = [];
    for (const side of ['baseline', 'candidate'] as const) {
      const strategy = side === 'baseline' ? baseline.text : readingStrategy(candidate.content_json);
      const prompt = comparisonPrompt(input.target_key,strategy,ctx.context,sample.input_json.pages);
      if (prompt.length > 48000) throw new HttpError(422, 'Comparison exceeds 48000 characters');
      const run = await new PgRunRepository(tx).createQueuedProviderTaskRun({
        visibility: "private",
        space_id: identity.spaceId,
        user_id: identity.userId,
        task: CAPABILITY,
        capability_id: CAPABILITY,
        run_type: 'agent',
        trigger_origin: 'manual',
        project_id: null,
        prompt,
        instruction: prompt,
        contract_snapshot: {
          source: {
            kind: 'direct',
            id: ctx.item.id
          },
          workflow_input_json: {
            reading_method_trial: {
              evaluation_id: evaluation.id,
              side,
              target_key: input.target_key,
              prompt_hash: sha256Json(prompt),
              provider
            }
          },
          route_hints_json: {
            provider_id: provider.id,
            model: provider.model
          },
          max_attempts: 1,
          max_duration_seconds: 180
        }
      });
      ids.push(run.id);
      await enqueueProviderTaskRunJob(tx, {
        run_id: run.id,
        space_id: identity.spaceId,
        user_id: identity.userId,
        max_attempts: 1
      });
      }
    const ref: PairRef = {
      target_key: input.target_key,
      provider,
      kind: PAIR_EVALUATOR,
      item_id: ctx.item.id,
      project_id: ctx.projectId,
      authority: ctx.authority,
      context_hash: sha256Json(ctx.context),
      case_id: String(sample.id),
      case_hash: sha256Json(sample.input_json),
      case_name: String(sample.name),
      baseline_run_id: ids[0]!,
      candidate_run_id: ids[1]!,
      baseline_hash: baseline.frozen.content_hash!,
      candidate_hash: String(candidate.content_hash),
      request_key: key,
      profile_hash: '',
      execution_name: provider.name
    };
    await tx.query(`UPDATE evolvable_asset_evaluation_runs SET eval_suite_ref_json=$2::jsonb,run_id=$3 WHERE id=$1`, [evaluation.id, JSON.stringify(ref), ids[1]]);
    return readReadingTrial(tx, identity, String(evaluation.id));
  });
}
export function registerRevisionProviderTrials() {
  providerTaskRunPreparers.register(CAPABILITY, async ({
    db,
    run
  }) => {
    const trial = trialContext(run);
    if (!trial) throw new HttpError(409, 'Comparison contract missing');
    const pair = await authorizedPair(db, {
      spaceId: run.space_id,
      userId: run.instructed_by_user_id!
    }, trial.evaluation_id);
    const provider = pair.ref.provider as RevisionProvider;
    if (!provider) throw new HttpError(409, 'Comparison provider missing');
    await assertReadingTrialRun(db, run);
    const revision=pair.ref.target_key==='prompt.revision.method';
    const strategyVersion=revision?(await db.query(`SELECT content_json FROM evolvable_asset_versions WHERE id=$1`,[trial.side==='baseline'?pair.row.baseline_version_id:pair.row.candidate_version_id])).rows[0]:null;
    return {
      completion: 'text',
      spaceId: run.space_id,
      userId: run.instructed_by_user_id!,
      task: CAPABILITY,
      providerId: provider.id,
      model: provider.model,
      system: revision?readingStrategy(strategyVersion?.content_json)+'\nReturn only reading_method_revision.v1 JSON: schema, method, summary, changes. No tools or retrieval; this is not quality certification.':'Use only supplied data; no tools or retrieval. Output is not a quality certification.',
      messages: [{
        role: 'user',
        content: revision?JSON.stringify({baseline_method:PROMPT_REVISION_FIXTURE.pages[0].text,description:PROMPT_REVISION_FIXTURE.pages[1].text}):run.prompt!
      }],
      prompt: run.prompt!,
      runType: 'agent',
      triggerOrigin: 'manual',
      spend: {
        kind: 'person',
        user_id: run.instructed_by_user_id!
      },
      allowProviderFallback: false,
      deadlineSeconds: 180,
      authorizeAttempt: async (tx, actual) => {
        if (actual.provider_id !== provider.id || actual.model !== provider.model) throw new HttpError(403, 'Comparison destination changed');
        await (await import('../../runtimeContext/index.js')).lockReadingRunAuthority(tx, run);
        await assertReadingTrialRun(tx, run);
      },
      finalize: async completion => {
        let text = completion.text;
        if (pair.ref.target_key === 'prompt.revision.method') {
          const result = ReadingMethodGeneratedOutputSchema.parse(JSON.parse(text));
          text = `# Revised prompt\n${result.method}\n\n## Changes\n${result.summary}\n${result.changes.map(c => '- ' + c).join('\n')}`;
        }
        if (!text.trim()) throw new HttpError(422, 'Empty comparison output');
        await withQueryableTransaction(db, async tx => {
          await (await import('../../runtimeContext/index.js')).lockReadingRunAuthority(tx, run);
          await assertReadingTrialRun(tx, run);
          await tx.query(`SELECT id FROM runs WHERE id=$1 FOR UPDATE`, [run.id]);
          const current = await new PgRunRepository(tx).getRun(run.space_id, run.id);
          if (current?.status !== 'running') throw new HttpError(409, 'Comparison no longer running');
          await new PgRunRepository(tx).markRunTerminal({
            run_id: run.id,
            space_id: run.space_id,
            status: 'succeeded',
            completed_at: new Date().toISOString(),
            output_json: canonicalRunOutput({
              success: true,
              outputText: text,
              outputJson: {}
            })
          });
          registerReadingTrialSettlement();
          await runFinalizationReconcilerRegistry.entries().find(r => r.key === 'reading_method_pair')!.reconcile(tx, (await new PgRunRepository(tx).getRun(run.space_id, run.id))!);
        });
        return null;
      }
    };
  });
}
