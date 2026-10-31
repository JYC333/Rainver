import type {MethodExecution} from './ReadingMethodApiExecution';
import { useEffect, useRef, useState } from 'react';
import type { ReadingMethodContext, ReadingMethodGenerationView } from '@rainver/protocol';
import { useAppTranslation } from '../../i18n';
import { formatNumber } from '../../i18n/format';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { SpaceLink } from '../../core/spaceNav';
import { Card } from '../../components/ui/card';
import { sessionEpoch, registerInMemoryResidue } from '../../lib/sessionResidue';
import { errMsg } from '../../lib/utils';
import { readingMethodsApi } from './readingMethodApi';
interface Props {
  data: ReadingMethodContext;
  execution?:MethodExecution;
  disabled: boolean;
  onActive: (active: boolean) => void;
  withhold: () => void;
  refresh: () => Promise<boolean>;
  select: (id: string) => void;
  compare: (id: string) => void;
}
const active = (g: ReadingMethodGenerationView | null | undefined) => !!g && ['queued', 'running', 'settling', 'waiting_review', 'waiting_user'].includes(g.status);
/** One mounted, authenticated workspace owns its async results. No feedback/log/body is persisted in browser storage. */
export function ReadingMethodGeneration({
  data,
  execution={},
  disabled,
  onActive,
  withhold,
  refresh,
  select,
  compare
}: Props) {
  const {
    t
  } = useAppTranslation();
  const latest = data.generations?.[0] ?? null;
  const [generation, setGeneration] = useState(latest),
    [description, setDescription] = useState(latest?.description ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const owner = useRef<object | null>(null),
    pending = useRef(false),
    request = useRef(0);
  const current = useRef({
    refresh,
    select,
    withhold
  });
  current.current = {
    refresh,
    select,
    withhold
  };
  const epoch = useRef(sessionEpoch());
  useEffect(() => {
    const token = {};
    owner.current = token;
    epoch.current = sessionEpoch();
    const drop = registerInMemoryResidue(() => {
      owner.current = null;
      ++request.current;
      setGeneration(null);
      setDescription('');
      setError('');
      setBusy(false);
      pending.current = false;
    });
    return () => {
      if (owner.current === token) owner.current = null;
      drop();
    };
  }, []);
  const live = (token: object | null, e: number, id: number) => !!token && owner.current === token && sessionEpoch() === e && request.current === id;
  // A context refresh must not replace an edited description or a newer locally started request.
  useEffect(() => {
    if (owner.current && epoch.current === sessionEpoch() && latest && !generation) {
      setGeneration(latest);
      setDescription(latest.description ?? '');
    }
  }, [latest, generation]);
  const accept = async (view: ReadingMethodGenerationView, token: object | null, e: number, id: number) => {
    if (!live(token, e, id)) return;
    setGeneration(view);
    if (view.visibility === 'withheld') {
      setDescription('');
      current.current.withhold();
      return;
    }
    if (view.status === 'ready' && view.candidate_version_id) {
      const landed = await current.current.refresh();
      if (landed && live(token, e, id)) current.current.select(view.candidate_version_id);
    }
  };
  useEffect(() => {
    if (!generation || !active(generation) || generation.visibility === 'withheld') return;
    const token = owner.current,
      e = sessionEpoch();
    let cancelled = false,
      inflight = false;
    const poll = async () => {
      if (cancelled || inflight || pending.current || !live(token, e, request.current)) return;
      const id=request.current;
      inflight = true;
      try {
        const view = await readingMethodsApi.generation(generation.id);
        if (!cancelled && live(token, e, id)) {
          setBusy(true);
          await accept(view, token, e, id);
        }
      } catch (error) {
        if (!cancelled && live(token, e, id)) {
          if ([401, 403, 404].includes(Number((error as {
            status?: number;
          }).status))) {
            setGeneration(null);
            setDescription('');
            current.current.withhold();
          }
          setError(errMsg(error));
        }
      } finally {
        inflight = false;
        if (live(token, e, id)) setBusy(false);
      }
    };
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [generation?.id, generation?.status, generation?.visibility]);
  const run = async (action: () => Promise<ReadingMethodGenerationView>) => {
    if (pending.current || !owner.current || epoch.current !== sessionEpoch()) return;
    const token = owner.current,
      e = sessionEpoch(),
      id = ++request.current;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await accept(await action(), token, e, id);
    } catch (error) {
      if (live(token, e, id)) {
        setError(errMsg(error));
        if ([401, 403, 404].includes(Number((error as {
          status?: number;
        }).status))) {
          setGeneration(null);
          setDescription('');
          current.current.withhold();
        }
      }
    } finally {
      if (owner.current === token && sessionEpoch() === e) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const running = active(generation);
  useEffect(() => {
    onActive(busy || running);
    return () => onActive(false);
  }, [busy, running, onActive]);
  const withheld = generation?.visibility === 'withheld';
  const currentCandidate = generation?.status==='ready'&&!generation.stale&&generation.description===description.trim();
  return <section className="space-y-4" aria-label={t('readingMethod.description_revision')}>
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">{t('readingMethod.describe_change')}</h2>
      <p className="text-sm text-muted-foreground">{t('readingMethod.description_only_inputs')}</p>
      <label className="block space-y-2"><span>{t('readingMethod.change_description')}</span><Textarea value={description} disabled={disabled || busy || running} maxLength={2400} onChange={e => setDescription(e.target.value)} placeholder={t(data.target_key === 'prompt.revision.method' ? 'readingMethod.revision_description_example' : 'readingMethod.description_example')} /></label>
      <p className="text-sm text-muted-foreground">{t(execution.agent_id!==undefined?'readingMethod.cli_execution':execution.provider_id?'readingMethod.api_override_active':'readingMethod.api_default_notice')}{execution.agent_id===undefined&&!execution.provider_id&&data.api_execution?.name ? ` · ${data.api_execution.name}` : ''}</p>
      {data.api_execution?.usable===false&&!execution.provider_id&&execution.agent_id===undefined&&<p role="status">{t('readingMethod.api_unavailable')} <Button size="sm" variant="ghost" asChild><SpaceLink to="/providers">{t('readingMethod.configure_api')}</SpaceLink></Button></p>}
      <p className="text-xs text-muted-foreground">{t('readingMethod.generation_limits')}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant={currentCandidate?'outline':'default'} disabled={disabled || busy || running || (execution.agent_id!==undefined&&!execution.agent_id) || !description.trim() || (data.api_execution?.usable===false&&!execution.provider_id&&execution.agent_id===undefined) || !data.effective_content_hash} onClick={() => void run(() => readingMethodsApi.generate({
          target_key:data.target_key,
          source_kind: 'description',
          item_id: data.item_id,
          project_id: data.project_id,
          parent_version_id: data.effective_version_id,
          parent_content_hash: data.effective_content_hash,
          description,
          ...execution,
          ...(generation && ['failed', 'degraded', 'cancelled', 'blocked', 'orphaned'].includes(generation.status) ? {
            retry_of: generation.id
          } : {})
        }))}>{t('readingMethod.generate_candidate')}</Button>
        {running&&<p className="text-xs text-muted-foreground">{t('readingMethod.api_cancel_notice')}</p>}
        {running && generation && <Button variant="outline" disabled={busy} onClick={() => void run(() => readingMethodsApi.cancelGeneration(generation.id))}>{t('readingMethod.cancel_generation')}</Button>}
        {generation && <Button variant="ghost" disabled={busy} onClick={() => void run(() => readingMethodsApi.generation(generation.id))}>{t('readingMethod.refresh_generation')}</Button>}
      </div>
      {error && <p role="alert" className="break-words text-destructive">{error}</p>}
    </Card>
    {generation && <Card className="space-y-3 p-4" aria-label={t('readingMethod.generated_candidate')}>
      <p role="status">{t('readingMethod.generation_status')}: {t(`readingMethod.generation_${generation.status}` as 'readingMethod.generation_queued', {
          defaultValue: generation.status
        })}</p>
      {withheld ? <p>{t('readingMethod.generation_withheld')}</p> : <>
        {generation.stale && <p role="status">{t('readingMethod.generation_stale')}</p>}
        {['failed', 'degraded', 'blocked', 'orphaned'].includes(generation.status) && <p>{t('readingMethod.generation_failure')}</p>}
        <p className="text-xs text-muted-foreground">{generation.execution_name}</p><Button variant="ghost" size="sm" asChild><SpaceLink to={`/runs/${generation.id}`}>{t('readingMethod.generation_run')}</SpaceLink></Button>
        <p className="text-xs text-muted-foreground">{t('readingMethod.time')}: {generation.seconds == null ? t('readingMethod.unknown') : `${formatNumber(generation.seconds)}s`} · {t('readingMethod.cost')}: {generation.cost_usd == null ? t('readingMethod.unknown') : formatNumber(generation.cost_usd, {
            style: 'currency',
            currency: 'USD'
          })}</p>
        {generation.method && <>{generation.description!==description.trim()&&<p role="status">{t('readingMethod.changed_description')}</p>}<h3 className="font-semibold">{t('readingMethod.change_summary')}</h3><p className="whitespace-pre-wrap break-words">{generation.summary}</p><ul className="list-disc space-y-1 pl-5">{generation.changes.map((c, i) => <li className="break-words" key={i}>{c}</li>)}</ul><p className="text-xs text-muted-foreground">{t('readingMethod.candidate_only_notice')}</p><div className="grid gap-4 md:grid-cols-2">{[generation.baseline_method, generation.method].map((method, i) => <div className="min-w-0" key={i}><h3 className="mb-2 font-semibold">{i ? t('readingMethod.candidate') : t('readingMethod.baseline')}</h3><p className="whitespace-pre-wrap break-words text-sm leading-7">{method}</p></div>)}</div><Button variant={currentCandidate?'default':'outline'} disabled={disabled || busy || generation.stale} onClick={() => generation.candidate_version_id && compare(generation.candidate_version_id)}>{t('readingMethod.compare_generated_candidate')}</Button></>}
      </>}
    </Card>}
  </section>;
}
