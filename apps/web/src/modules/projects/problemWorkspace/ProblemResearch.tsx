import { useEffect, useState, useRef } from 'react';
import { toast } from 'sonner';
import { projectResearchApi } from '../../../api/client';
import type { ProjectOperation } from '../../../types/api';
import { researchCheckpointOperationId } from '../researchReviewAttention';
import { ResearchOperationRow } from '../ResearchOperationRow';
import { Button } from '../../../components/ui/button';
import { Textarea } from '../../../components/ui/textarea';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Select } from '../../../components/ui/select';
import { Card } from '../../../components/ui/card';
import { SpaceLink } from '../../../core/spaceNav';
import { errMsg } from '../../../lib/utils';
import { type ProblemProjection } from './useProblem';
import { useProblemText } from './strings';
type Result = Awaited<ReturnType<typeof projectResearchApi.result>>;
export function ProblemResearch({ project, thread, kind, projection, editable, refresh }: {
    project: string;
    thread: string;
    kind: string;
    projection: ProblemProjection;
    editable: boolean;
    refresh: () => Promise<void>;
}) {
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const text = useProblemText();
    const [operations, setOperations] = useState<ProjectOperation[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [gap, setGap] = useState('');
    const [startLimit, setStartLimit] = useState('');
    const [operationLimits,setOperationLimits]=useState<Record<string,string>>({});
    const [since, setSince] = useState('');
    const [busy, setBusy] = useState('');
    const [result, setResult] = useState<Result | null>(null);
    const [selected, setSelected] = useState('');
    const selectedRef=useRef(''),resultRequest=useRef(0);
    async function readResult(id:string){const ticket=++resultRequest.current;selectedRef.current=id;setSelected(id);setResult(null);try{const value=await projectResearchApi.result(project,id);if(mounted.current&&ticket===resultRequest.current)setResult(value)}catch(error){if(mounted.current&&ticket===resultRequest.current)toast.error(errMsg(error))}}
    const [reason, setReason] = useState('');
    const [applicability, setApplicability] = useState('limited');
    const [counter, setCounter] = useState('');
    const [gaps, setGaps] = useState('');
    const [checkpoints, setCheckpoints] = useState<Record<string, Awaited<ReturnType<typeof projectResearchApi.checkpoints>>>>({});
    async function load(after?: string) { try {
        const p = await projectResearchApi.problemOperations(project, thread, after);
        if (!mounted.current)
            return;
        setOperations(old => after ? [...old, ...p.items] : p.items);
        setCursor(p.next_cursor);
        const selectedOperation=p.items.find(o=>o.id===selectedRef.current);
        if(selectedOperation?.progress_json.content_withheld===true){resultRequest.current++;setResult(null);setSelected('');selectedRef.current=''}
        setError('');
        const workflowIds = [...new Set(p.items.map(o => String(o.progress_json.workflow_id ?? '')).filter(Boolean))];
        for (const id of workflowIds) {
            const list = await projectResearchApi.checkpoints(project, id);
            setCheckpoints(old => ({ ...old, [id]: list }));
        }
    }
    catch (e) {
        setError(errMsg(e));
    } }
    useEffect(() => { let live = true; setOperations([]); setResult(null); setCheckpoints({}); void projectResearchApi.problemOperations(project, thread).then(p => { if (live) {
        setOperations(p.items);
        setCursor(p.next_cursor);
        setError('');
        for (const id of new Set(p.items.map(o => String(o.progress_json.workflow_id ?? '')).filter(Boolean)))
            void projectResearchApi.checkpoints(project, id).then(c => { if (live)
                setCheckpoints(old => ({ ...old, [id]: c })); }).catch(e => { if (live)
                setError(errMsg(e)); });
    } }).catch(e => { if (live)
        setError(errMsg(e)); }); return () => { live = false; }; }, [project, thread, projection.revision]);
    useEffect(() => { if (!operations.some(o => ['active', 'waiting_review'].includes(o.status)))
        return; const timer = setInterval(() => { void load(); }, 5000); return () => clearInterval(timer); }, [project, thread, operations.some(o => ['active', 'waiting_review'].includes(o.status))]);
    async function action(key: string, fn: () => Promise<unknown>) { setBusy(key); try {
        await fn();
        await load();
        await refresh();
        return true;
    }
    catch (e) {
        toast.error(errMsg(e));
        return false;
    }
    finally {
        setBusy('');
    } }
    async function adopt() { if (!selected)
        return; const succeeded=await action('adopt', () => projectResearchApi.adoptResult(project, selected, { expected_version: projection.version, expected_revision: projection.revision, idempotency_key: crypto.randomUUID(), applicability, reason, counterevidence: counter, remaining_gaps: gaps })); if(succeeded)setResult(null); }
    return <div className="space-y-4">
    <Card className="space-y-3 p-4">
    <h3 className="font-medium">{text('Research calls', '研究调用')}</h3>
    <p className="text-sm text-muted-foreground">{text('Research returns evidence. Success does not accept a judgment or close a round.', '研究返回证据；成功不会自动接受判断或收尾。')}</p>{editable && kind === 'question' && <>
        <Label htmlFor="research-gap">{text('Gap to investigate', '待查缺口')}</Label>
        <Textarea id="research-gap" maxLength={4000} value={gap} onChange={e => setGap(e.target.value)}/>
        <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label={text('Item limit, optional', '条数上限（可选）')} type="number" min={1} max={2000} value={startLimit} onChange={e => setStartLimit(e.target.value)}/>
        <Input aria-label={text('Since, optional', '起始日期（可选）')} type="date" value={since} onChange={e => setSince(e.target.value)}/>
        </div>
        <p className="text-xs text-muted-foreground">{text('Omitted limits use the accepted bounded defaults. Existing Source, budget and approval checks still apply.', '未指定时使用已接受的有界默认值，仍受来源、预算与审批约束。')}</p>
        <Button disabled={!!busy || !gap.trim()} onClick={() => void action('start', () => projectResearchApi.startAcquisition(project, { thread_id: thread, idempotency_key: crypto.randomUUID(), intent_note: gap, ...(startLimit ? { max_items: Number(startLimit) } : {}), ...(since ? { since } : {}) }))}>{text('Start research call', '启动研究调用')}</Button>
        </>}{kind !== 'question' && <p className="text-sm">{text('The acquisition capability currently accepts questions. Reference a linked question or existing results without changing this hypothesis.', '采集能力当前接受问题；可引用关联问题或已有结果，无须改写此假设。')}</p>}<SpaceLink className="block text-sm text-primary underline" to={`/projects/${project}/inquiry/records?tab=runs&thread=${thread}`}>{text('Project research records, including unbound history', '项目研究记录（含未绑定历史）')}</SpaceLink>
    </Card>
 {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{operations.map(o => {
            const withheld = o.progress_json.content_withheld === true, workflow = String(o.progress_json.workflow_id ?? '');
            return <Card key={o.id} className="space-y-3 p-3">
            <ResearchOperationRow operation={o} workflow={undefined} thread={undefined} readOnly={!editable} checkpoints={(checkpoints[workflow] ?? []).filter(c => researchCheckpointOperationId(c) === o.id)} busyAction={busy} reconciling={busy === 'reconcile'} onDecideCheckpoint={(c, d) => action('checkpoint', () => projectResearchApi.decideCheckpoint(project, c.workflow_id, c.id, { decision: d }))} onCancelOperation={id => void action(`cancel-operation-${id}`, () => projectResearchApi.cancelOperation(project, id))} onRetryOperation={id => void action('retry-operation', () => projectResearchApi.retryOperation(project, id))} onReconcileOperation={id => void action('reconcile', () => projectResearchApi.reconcileOperation(project, id))}/>{withheld ? <p className="text-sm text-muted-foreground">{text('Content is unavailable. Authorized status and stopping remain available.', '内容不可用；仍可查看授权状态并停止。')}</p> : <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => void readResult(o.id)}>{text('Read result', '读取结果')}</Button>{editable && ['baseline', 'historical_backfill'].includes(String(o.progress_json.run_kind)) && <>
                    <Input className="max-w-40" aria-label={text('New item limit', '新条数上限')} type="number" min={1} max={2000} value={operationLimits[o.id]??''} onChange={e => setOperationLimits(old=>({...old,[o.id]:e.target.value}))}/>
                    <Button variant="outline" disabled={!!busy || !operationLimits[o.id] || Number(operationLimits[o.id]) < 1 || Number(operationLimits[o.id]) > 2000} onClick={() => void action('limit', () => projectResearchApi.updateItemLimit(project, o.id, Number(operationLimits[o.id])))}>{text('Update limit', '修改上限')}</Button>
                    <Button variant="outline" disabled={!!busy || o.progress_json.partial === true} onClick={() => void action('rescan', () => projectResearchApi.rescanBackfill(project, o.id))}>{text('Rescan', '重扫')}</Button>
                    </>}</div>}</Card>;
        })}
 {cursor && <Button variant="outline" onClick={() => void load(cursor)}>{text('More calls', '更多调用')}</Button>}
 {result && <Card className="space-y-3 p-4">
        <h3 className="font-medium">{text('Result for assessment', '待评估结果')}</h3>
        <p className="text-sm">{result.applicability === 'requires_assessment' ? text('Problem or round changed. Reassess applicability.', '问题或轮次已变化，请重新评估适用性。') : text('Matches the initiating snapshot', '与发起快照一致')}</p>{result.partial && <p className="text-sm">{text('Partial results; see limitations.', '部分结果，请查看局限。')}</p>}{result.findings.map(f => <article className="space-y-2 text-sm" key={f.report_id}>
            <p className="whitespace-pre-wrap break-words">{f.summary}</p>
            <SpaceLink className="text-primary underline" to={`/projects/${project}/research/reports/${f.report_id}?thread=${thread}`}>{text('Open full report', '打开完整报告')}</SpaceLink>
            </article>)}{result.limitations.map((s, i) => <p className="text-sm text-muted-foreground" key={i}>{s}</p>)}{editable && ['completed', 'failed', 'cancelled'].includes(result.status) && <>
            <Select ariaLabel={text('Applicability', '适用性')} value={applicability} onChange={setApplicability} options={[{ value: 'applicable', label: text('Applicable', '适用') }, { value: 'limited', label: text('Limited', '有限适用') }, { value: 'not_applicable', label: text('Not applicable', '不适用') }]}/>
            <Textarea aria-label={text('Assessment reason', '评估理由')} maxLength={1800} value={reason} onChange={e => setReason(e.target.value)}/>
            <Textarea aria-label={text('Counterevidence', '反证')} maxLength={900} value={counter} onChange={e => setCounter(e.target.value)}/>
            <Textarea aria-label={text('Remaining gaps', '剩余缺口')} maxLength={900} value={gaps} onChange={e => setGaps(e.target.value)}/>
            <Button disabled={!!busy || !reason.trim()} onClick={() => void adopt()}>{text('Record applicability in Verify', '在检验阶段记录适用性')}</Button>
            </>}</Card>}
 </div>;
}
