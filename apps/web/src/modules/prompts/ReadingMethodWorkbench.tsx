import { readingHrefReturning } from '../library/readingLinks';
import { ReadingMethodComparisonExample } from './ReadingMethodComparisonExample';
import {ReadingMethodApiExecution,type MethodExecution} from './ReadingMethodApiExecution';
import { ReadingMethodAdvanced } from './ReadingMethodAdvanced';
import {ReadingMethodGeneration} from './ReadingMethodGeneration';
import { Select } from '../../components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
import { formatNumber } from '../../i18n/format';
import { Card } from '../../components/ui/card';
import { readingMethodReturn } from './readingMethodLinks';
import { ReadingMethodSamplePreview } from './ReadingMethodSamplePreview';
import { ReadingMethodSampleEditor } from './ReadingMethodSampleEditor';
import { MarkdownReader } from '../../components/editor/MarkdownReader';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSpace } from '../../contexts/SpaceContext';
import { SpaceLink } from '../../core/spaceNav';
import { useAppTranslation } from '../../i18n';
import { sessionEpoch, registerInMemoryResidue } from '../../lib/sessionResidue';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { errMsg } from '../../lib/utils';
import { readingMethodsApi, evidenceSample,revisionSample, type ReadingMethodContext, type ReadingMethodTrialView } from './readingMethodApi';
export default function ReadingMethodWorkbench() {
  const {
    activeSpaceId,
    userId
  } = useSpace();
  const [q, setQuery] = useSearchParams();
  const item = q.get('item_id'),
    project = q.get('project_id'),
    artifact = q.get('artifact_id'),
    target = q.get('target_key')==='prompt.revision.method'?'prompt.revision.method':'reading.project_investigation';
  const {
    t
  } = useAppTranslation();
  const [record, setRecord] = useState<{
      scope: string;
      epoch: number;
      data: ReadingMethodContext;
    } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [generationBusy,setGenerationBusy]=useState(false),
    [execution,setExecution]=useState<MethodExecution>({}),
    [tab, setTab] = useState('current'),
    [editing, setEditing] = useState(false),
    [advancedOpen, setAdvancedOpen] = useState(false),
    [editRequest, setEditRequest] = useState(0),
    [manualParent,setManualParent]=useState(''),
    [method, setMethod] = useState(''),
    [reason, setReason] = useState(''),
    [candidate, setCandidate] = useState(''),
    [sample, setSample] = useState(''),
    [judgment, setJudgment] = useState('unknown'),
    [comment, setComment] = useState(''),
    [proposal, setProposal] = useState(''),
    [notice, setNotice] = useState('');
  const requestedCandidate=q.get('candidate_id')??'';
  const scope = `${activeSpaceId}:${userId}:${item}:${project}:${artifact}:${target}:${requestedCandidate}`;
  const current = useRef(scope);
  current.current = scope;
  const owner = useRef<object | null>(null);
  const request = useRef(0);
  const operation = useRef(false);
  const data = record?.scope === scope && record.epoch === sessionEpoch() ? record.data : null;
  const setData = (value: ReadingMethodContext | null) => setRecord(value ? {
    scope,
    epoch: sessionEpoch(),
    data: value
  } : null);
  const reload = useCallback(async () => {
    const token = owner.current,
      epoch = sessionEpoch(),
      which = ++request.current;
    let response: ReadingMethodContext;
    try {
      response = await readingMethodsApi.context(item, project, artifact,target);
    } catch (e) {
      if (token && owner.current === token && current.current === scope && epoch === sessionEpoch() && which === request.current && [401, 403, 404].includes(Number((e as {
        status?: number;
      }).status))) {
        setData(null);
        setEditing(false);
        setAdvancedOpen(false);
        setMethod('');
        setReason('');
        setComment('');
        setCandidate('');
        setProposal('');
      }
      throw e;
    }
    if (token && owner.current === token && current.current === scope && epoch === sessionEpoch() && which === request.current) {
      if(requestedCandidate&&response.project_id!==project){setData(null);setError('reading_scope_changed');return false;}
      setData(response);
      if(requestedCandidate&&!response.versions.some(v=>v.id===requestedCandidate))setCandidate('');
      setError('');
      return true;
    }
    return false;
  }, [item, project, scope, artifact,target]);
  useEffect(() => {
    const token = {};
    owner.current = token;
    setTab(q.get('method_tab')==='compare'?'compare':'current');
    setExecution({});
    setData(null);
    setError('');
    setEditing(false);
    setAdvancedOpen(false);
    setCandidate(requestedCandidate);
    setManualParent('');
    setProposal('');
    setNotice('');
    setMethod('');
    setReason('');
    setSample('');
    setComment('');
    setBusy(false);
    operation.current = false;
    const drop = registerInMemoryResidue(() => {
      owner.current = null;
      setData(null);
      setExecution({});
      setMethod('');
      setReason('');
      setComment('');
      setEditing(false);
      setAdvancedOpen(false);
      setManualParent('');
      setCandidate('');
      setProposal('');
      setNotice('');
      setBusy(false);
    });
    void reload().catch(e => {
      if (owner.current === token) setError(errMsg(e));
    });
    return () => {
      if (owner.current === token) owner.current = null;
      drop();
    };
  }, [scope, reload, item, requestedCandidate]);
  const act = async (action: () => Promise<unknown>) => {
    if (operation.current||generationBusy) return;
    const token = owner.current,
      epoch = sessionEpoch();
    operation.current = true;
    setBusy(true);
    setError('');
    const live = () => token && owner.current === token && current.current === scope && epoch === sessionEpoch();
    try {
      await action();
      if (live()) await reload();
    } catch (e) {
      if (live()) {
        setError(errMsg(e));
        if ((e as {
          status?: number;
        }).status === 403) setData(null);
      }
    } finally {
      if (live()) {
        operation.current = false;
        setBusy(false);
      }
    }
  };
  const trial: ReadingMethodTrialView | undefined = data?.trials.find(t => t.candidate_version_id === candidate) ?? (!candidate ? data?.trials[0] : undefined);
  const running = trial && ['queued', 'running'].includes(trial.status);
  useEffect(() => {
    const p = data?.promotion;
    if (!p || p.candidate_version_id !== (candidate || trial?.candidate_version_id)) return;
    if (p.status === 'pending') {
      setProposal(p.id);
      return;
    }
    setProposal('');
    if (p.status === 'accepted' && data?.effective_version_id === p.candidate_version_id) {
      setNotice(t('readingMethod.effective_version_confirmed_only_new_runs_use'));
      setCandidate('');
      setEditing(false);
      setTab('current');
    } else setNotice(t('readingMethod.proposal_decided_the_header_shows_the_actual'));
  }, [data?.promotion, data?.effective_version_id, candidate, trial?.candidate_version_id, t]);
  const statusLabel = (status: string) => ({
    degraded: t('readingMethod.degraded'), orphaned: t('readingMethod.orphaned'), unavailable: t('readingMethod.unavailable'), queued: t('readingMethod.queued'),
    running: t('readingMethod.running'),
    passed: t('readingMethod.completed'),
    succeeded: t('readingMethod.succeeded'),
    failed: t('readingMethod.failed'),
    cancelled: t('readingMethod.cancelled'),
    blocked: t('readingMethod.authority_or_input_changed')
  })[status] ?? status;
  const judgmentLabel = (v: string) => ({
    better: t('readingMethod.better'),
    same: t('readingMethod.similar'),
    worse: t('readingMethod.worse'),
    unknown: t('readingMethod.cannot_judge')
  })[v] ?? v;
  const positive = data?.versions.find(v => v.id === trial?.candidate_version_id)?.status !== 'approved' && trial?.visibility === 'visible' && trial.status === 'passed' && !trial.stale && ['better', 'same'].includes(trial.judgment ?? '');
  const manualDisabled = busy || generationBusy || !!running || !!proposal;
  const startManual = () => {
    if (!data?.can_manage || !data.initialized || manualDisabled) return;
    setMethod(data.versions.find(v => v.id === candidate)?.method ?? data.method ?? '');
    setReason('');
    setManualParent(candidate || data.effective_version_id || '');
    setAdvancedOpen(true);
    setEditRequest(n => n + 1);
    setEditing(true);
  };
  const cancelManual = () => {
    setEditing(false);
    setMethod('');
    setReason('');
    setManualParent('');
  };
  const saveDraft = () => {
    if (!data?.can_manage || !data.initialized || manualDisabled) return;
    const token = owner.current;
    void act(async () => {
      const v = await readingMethodsApi.draft({
        target_key:target,
        item_id: item,
        project_id: data.project_id,
        parent_version_id: manualParent || data.effective_version_id,
        reason,
        method
      });
      if (owner.current === token) {
        setCandidate(v.id);
        setEditing(false);
        setTab('compare');
      }
    });
  };
  const requestActivation = () => {
    if (!trial || !data) return;
    const token = owner.current;
    void act(async () => {
      const r = await readingMethodsApi.promote({
        version_id: trial.candidate_version_id,
        evaluation_id: trial.id,
        project_id: data.project_id
      });
      if (owner.current === token) setProposal(r.proposal_id ?? r.id);
    });
  };
  useEffect(() => {
    if (!running) return;
    let live = true;
    const timer = window.setInterval(() => {
      if (live) void reload().catch(e => {
        if (live) setError(errMsg(e));
      });
    }, 2500);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [running, reload]);

  return <main className="mx-auto max-w-6xl space-y-5 p-4 pb-24 sm:p-6 sm:pb-12 reading-touch text-sm">
 <Button variant="ghost" size="sm" asChild><SpaceLink to={readingMethodReturn(item, q.get('reader'), data?.project_id ?? project)}>← {t(item?'readingMethod.back_to_reading':'readingMethod.back_to_settings')}</SpaceLink></Button>
 <header className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h1 className="text-xl font-semibold">{t(target==='prompt.revision.method'?'readingMethod.revision_method':'readingMethod.reading_method')}</h1><p className="break-words text-sm text-muted-foreground">{data?.project_name ?? t('readingMethod.current_space')} · {data?.effective_version ? (data.effective_scope === 'system' ? t('readingMethod.system_baseline') : data.effective_scope === 'space' ? t('readingMethod.space_default') : t('readingMethod.project_override')) + t('readingMethod.effective') + ` v${data.effective_version}` : t('readingMethod.not_initialized_deployed')} · {editing ? t('readingMethod.unsaved_changes') : candidate ? t('readingMethod.candidate_draft') : t('readingMethod.production_unchanged')}</p></div>
 {data?.can_manage && data.initialized && (positive||proposal||candidate&&tab!=='compare'&&tab!=='current') && <Button disabled={busy||generationBusy||!!running||!!proposal||editing} onClick={()=>{if(positive)requestActivation();else setTab('compare');}}>{proposal?t('readingMethod.awaiting_decision'):positive?t('readingMethod.request_activation'):t('readingMethod.compare_runs')}</Button>}
 </header>
 {error && <div role="alert" className="rounded border border-destructive p-3"><p className="break-words">{error==='reading_scope_changed'?t('readingMethod.comparison_scope_changed'):error}</p><Button variant="outline" onClick={() => void act(reload)}>{t('readingMethod.retry_refresh')}</Button></div>}
 {notice && <p role="status" className="rounded border border-border p-3 text-sm">{notice}</p>}
 {!data && !error && <p role="status">{t('readingMethod.loading')}</p>}
 {data && <>{item&&target==='reading.project_investigation'&&<p className="text-sm text-muted-foreground">{t('readingMethod.result_method')}{data.result_provenance ? `v${data.result_provenance.version}` : t('readingMethod.unknown_for_this_legacy_result_current_deployment')}</p>}
 {!data.initialized && <p>{t('readingMethod.the_method_has_not_been_synchronized_initialization')}{data.can_manage && <Button disabled={busy||generationBusy} onClick={() => void act(() => readingMethodsApi.initialize())}>{t('readingMethod.initialize_method')}</Button>}</p>}
 {!data.can_manage && <p>{t('readingMethod.editing_and_enabling_require_existing_prompt_maintenance')}</p>}
 <Tabs value={tab} onValueChange={setTab}><TabsList className="h-auto flex-wrap justify-start" aria-label={t('readingMethod.reading_method_views')}>{['current', 'compare', 'history'].map((v, n) => <TabsTrigger key={v} value={v} disabled={busy||generationBusy}>{[t('readingMethod.current_method'), t('readingMethod.comparison'), t('readingMethod.history')][n]}</TabsTrigger>)}</TabsList>
 {tab === 'current' && <TabsContent value="current" className="flex flex-col gap-4">
 <Card className="mb-0 min-w-0 space-y-3 p-4" role="region" aria-label={t('readingMethod.current_method')}>
   <h2 className="font-semibold">{t('readingMethod.current_method')}</h2>
   <p className="break-words text-xs text-muted-foreground">{data.project_name ?? t('readingMethod.current_space')} · {data.effective_version ? `${data.effective_scope === 'system' ? t('readingMethod.system_baseline') : data.effective_scope === 'space' ? t('readingMethod.space_default') : t('readingMethod.project_override')}${t('readingMethod.effective')} v${data.effective_version}` : t('readingMethod.not_initialized_deployed')}</p>
   {data.method && <p className="whitespace-pre-wrap break-words text-sm leading-7">{data.method}</p>}
 </Card>
 {data.can_manage&&data.initialized&&<ReadingMethodGeneration key={scope} data={data} execution={execution} disabled={busy||!!running||!!proposal||editing} onActive={setGenerationBusy} withhold={()=>{setData(null);setMethod('');setReason('');setComment('');setCandidate('');setProposal('');setEditing(false);setError(t('readingMethod.generation_withheld'));}} refresh={reload} select={setCandidate} compare={id=>{setCandidate(id);setTab('compare');}}/>}
 {target === 'reading.project_investigation' && <p className="text-sm text-muted-foreground">{t('readingMethod.investigation_text_is_delivered_through_source_materials')}</p>}
 </TabsContent>}
 {tab === 'compare' && data.can_manage && <TabsContent value="compare" className="space-y-4">
 <Button variant="outline" disabled={manualDisabled} onClick={startManual}>{t('readingMethod.revise_method_save_a_new_draft')}</Button>
 <div className="space-y-2">{t('readingMethod.candidate_method')}<Select portal={false} ariaLabel={t('readingMethod.candidate_method')} value={candidate} disabled={busy||generationBusy} onChange={e => {
              setCandidate(e);
              setComment('');
              setProposal('');
            }} options={[{
              value: '',
              label: t('readingMethod.choose_a_draft')
            }, ...data.versions.filter(v => ['draft', 'candidate', 'testing'].includes(v.status)).map(v => ({
              value: v.id,
              label: `v${v.version} · ${v.reason ?? statusLabel(v.status)}`
            }))]} /></div>
 {!item ? <ReadingMethodComparisonExample spaceId={activeSpaceId!} projectId={data.project_id} disabled={busy||generationBusy||!candidate} select={selected=>{const next=new URLSearchParams(q);next.set('item_id',selected.source_item_id);next.set('candidate_id',candidate);next.set('method_tab','compare');next.set('reader',readingHrefReturning(selected,readingMethodReturn(null,q.get('reader'),data.project_id)));next.delete('artifact_id');setQuery(next);}}/> : <>
 <p className="text-sm">{t(target==='prompt.revision.method'?'readingMethod.revision_comparison_help':'readingMethod.controlled_offline_comparison_homepage_relevant_documentation_example')}</p>
 <div className="space-y-2">{t('readingMethod.sample')}<Select portal={false} ariaLabel={t('readingMethod.sample')} value={sample} disabled={busy||generationBusy} onChange={setSample} options={[{
              value: '',
              label: t('readingMethod.choose_a_sample')
            }, ...data.cases.map(c => ({
              value: c.id,
              label: c.name + (c.stale ? t('readingMethod.historical_input_save_a_fresh_sample') : '')
            }))]} /></div>
 <Button variant="outline" disabled={busy||generationBusy} onClick={() => {
            const token = owner.current;
            void act(async () => {
              const c = await readingMethodsApi.sample({
                item_id: item,
                project_id: data?.project_id ?? project,
                target_key:target,
                sample: target==='prompt.revision.method'?revisionSample:evidenceSample
              });
              if (owner.current === token) setSample(c.id);
            });
          }}>{t(target==='prompt.revision.method'?'readingMethod.add_revision_example':'readingMethod.add_synthetic_homepage_docs_sample')}</Button>
 {target!=='prompt.revision.method'&&<ReadingMethodSampleEditor busy={busy} save={newSample => {
            const token = owner.current;
            void act(async () => {
              const c = await readingMethodsApi.sample({
                item_id: item,
                project_id: data.project_id,
                sample: newSample
              });
              if (owner.current === token) setSample(c.id);
            });
          }} />}
 <ReadingMethodSamplePreview sampleId={data.cases.some(c => c.id === sample) ? sample : ''} />
 <Button variant="outline" disabled={busy||generationBusy || editing || !!running || !candidate || !sample || (execution.agent_id!==undefined?!execution.agent_id:(data.api_execution?.usable===false&&!execution.provider_id)) || data.cases.some(c => c.id === sample && c.stale)} onClick={() => void act(() => readingMethodsApi.trial({
            target_key:target,...execution,
            item_id: item,
            project_id: data?.project_id ?? project,
            candidate_version_id: candidate,
            candidate_content_hash: data.versions.find(v => v.id === candidate)?.content_hash,
            case_id: sample,

            ...(trial && ['failed', 'blocked', 'cancelled'].includes(trial.status) ? {
              retry_of: trial.id
            } : {})
          }))}>{t('readingMethod.start_two_run_comparison')}</Button>
 {running && <Button variant="outline" disabled={busy||generationBusy} onClick={() => void act(() => readingMethodsApi.cancel(trial.id))}>{t('readingMethod.cancel_comparison')}</Button>}
 {trial && <><p className="text-sm">{t('readingMethod.frozen_input_for_this_pair')}{trial.visibility === 'visible' ? trial.case_name : t('readingMethod.withheld')}{trial.visibility === 'visible' && trial.execution_name ? ` · ${trial.execution_name}` : ''} · {t('readingMethod.changing_selectors_prepares_the_next_trial_only')}</p>{trial.stale && <p role="status">{t('readingMethod.the_effective_baseline_candidate_or_input_changed')}</p>}<p role="status">{t('readingMethod.execution_state')}: {statusLabel(trial.status)} · {t('readingMethod.execution_completion_is_not_a_quality_pass')}</p>{trial.visibility === 'withheld' ? <p>{t('readingMethod.material_context_authority_changed_the_entire_comparison')}</p> : <><div className="grid gap-4 md:grid-cols-2">{[trial.baseline, trial.candidate].map((o, n) => <Card key={n} className="mb-0 min-w-0 space-y-2 p-4"><h2 className="font-semibold">{n ? t('readingMethod.candidate') : t('readingMethod.baseline')}{(n ? trial.candidate_version : trial.baseline_version) != null ? ` v${n ? trial.candidate_version : trial.baseline_version}` : ''}</h2><p className="text-sm">{o ? statusLabel(o.status) : '—'} · {t('readingMethod.time')}: {o?.seconds == null ? t('readingMethod.unknown') : `${formatNumber(o.seconds)}s`} · {t('readingMethod.cost')}: {o?.cost_usd == null ? t('readingMethod.unknown') : formatNumber(o.cost_usd, {
                      style: 'currency',
                      currency: 'USD'
                    })}</p>{o?.text ? <><MarkdownReader markdown={o.text} />{o.text.includes('[truncated]') && <p>{t('readingMethod.output_was_truncated_by_the_canonical_run')}</p>}</> : <p>{o && ['succeeded', 'degraded', 'failed', 'cancelled', 'orphaned', 'unavailable'].includes(o.status) ? t('readingMethod.this_run_has_no_readable_output_check') : t('readingMethod.waiting_for_output')}</p>}</Card>)}</div>
 {trial.status === 'passed' && <><div className="space-y-2">{t('readingMethod.human_judgment')}<Select portal={false} ariaLabel={t('readingMethod.human_judgment')} value={judgment} disabled={busy||generationBusy} onChange={setJudgment} options={['better', 'same', 'worse', 'unknown'].map(value => ({
                    value,
                    label: judgmentLabel(value)
                  }))} /></div><Textarea disabled={busy||generationBusy} aria-label={t('readingMethod.judgment_reason')} value={comment} maxLength={1600} onChange={e => setComment(e.target.value)} /><Button variant="outline" disabled={busy||generationBusy || !comment.trim() || trial.stale} onClick={() => void act(() => readingMethodsApi.judge(trial.id, {
                  judgment,
                  reason: comment
                }))}>{t('readingMethod.record_judgment')}</Button><p className="text-sm">{t('readingMethod.you_may_request_activation_for_better_or')}</p>{trial.reason && <p className="break-words text-sm">{judgmentLabel(trial.judgment ?? 'unknown')}: {trial.reason}</p>}
</>}
 </>}</>}
 {proposal && <p role="status">{t('readingMethod.proposal_awaits_your_decision_it_is_not')} <SpaceLink className="underline" to="/proposals">{t('readingMethod.open_proposals')}</SpaceLink><Button variant="outline" onClick={() => void act(reload)}>{t('readingMethod.refresh_effective_version_after_decision')}</Button></p>}
 </>}
 </TabsContent>}
 {tab === 'history' && <TabsContent value="history" className="space-y-4">{data.versions.map(v => <Card key={v.id} className="break-words p-3">v{v.version} · {{
              draft: t('readingMethod.draft'),
              candidate: t('readingMethod.candidate'),
              testing: t('readingMethod.candidate_in_evaluation'),
              approved: t('readingMethod.approved'),
              deprecated: t('readingMethod.deprecated')
            }[v.status] ?? v.status}<p>{v.reason}</p><Button variant="ghost" disabled={busy||generationBusy} onClick={() => {
              setCandidate(v.id);
              setTab('compare');
            }}>{t('readingMethod.view_comparison')}</Button></Card>)}<Button variant="outline" disabled={busy||generationBusy || editing || !data.can_manage} onClick={() => void act(() => readingMethodsApi.rollback({
            item_id: item,
            project_id: data?.project_id ?? project,
            target_key:target,expected_version_id: data.effective_version_id
          }))}>{t('readingMethod.roll_back_this_scope_to_previous_effective')}</Button></TabsContent>}
 </Tabs>
 <ReadingMethodAdvanced data={data} open={advancedOpen} onOpen={setAdvancedOpen} editRequest={editRequest} editing={editing} disabled={manualDisabled} execution={advancedOpen&&<ReadingMethodApiExecution projectId={data.project_id} key={scope} value={execution} onChange={setExecution} disabled={manualDisabled||editing}/>} method={method} reason={reason} setMethod={setMethod} setReason={setReason} startEditing={startManual} cancelEditing={cancelManual} save={saveDraft} />
 </>}
 </main>;
}
