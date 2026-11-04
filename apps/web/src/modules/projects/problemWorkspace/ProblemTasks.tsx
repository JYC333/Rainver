import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ProblemLinkedTasksPage, ProblemTaskResult } from '@rainver/protocol';
import { inquiryApi, tasksApi } from '../../../api/client';
import { StatusBadge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Select } from '../../../components/ui/select';
import { Card } from '../../../components/ui/card';
import { Textarea } from '../../../components/ui/textarea';
import { SpaceLink } from '../../../core/spaceNav';
import { errMsg } from '../../../lib/utils';
import { problemToken, type ProblemProjection } from './useProblem';
import { useProblemText } from './strings';
export function ProblemTasks({ project, thread, projection, editable, refresh }: {
    project: string;
    thread: string;
    projection: ProblemProjection;
    editable: boolean;
    refresh: () => Promise<void>;
}) {
    const text = useProblemText();
    const [page, setPage] = useState<ProblemLinkedTasksPage | null>(null);
    const [choices, setChoices] = useState<{
        id: string;
        title: string;
    }[]>([]);
    const [choiceTotal,setChoiceTotal]=useState(0);
    async function moreChoices(){try{const p=await tasksApi.list({project_id:project,limit:'100',offset:String(choices.length)});setChoices(old=>[...old,...p.items]);setChoiceTotal(p.total)}catch(e){setError(errMsg(e))}}
    const [choice, setChoice] = useState('');
    const [title, setTitle] = useState('');
    const [reason, setReason] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<ProblemTaskResult | null>(null);
    async function load(after?: string) { try {
        const p = await inquiryApi.linkedTasks(project, thread, after);
        setPage(old => after && old ? { ...p, items: [...old.items, ...p.items] } : p);
        setError('');
    }
    catch (e) {
        setError(errMsg(e));
    } }
    useEffect(() => { let live = true; setPage(null); setResult(null); void inquiryApi.linkedTasks(project, thread).then(p => { if (live)
        setPage(p); }).catch(e => { if (live)
        setError(errMsg(e)); }); void tasksApi.list({ project_id: project, limit: '100' }).then(p => { if (live)
        {setChoices(p.items);setChoiceTotal(p.total)} }).catch(e=>{if(live)setError(errMsg(e))}); return () => { live = false; }; }, [project, thread, projection.revision]);
    async function link(create: boolean) { setBusy(true); try {
        await inquiryApi.linkTask(project, thread, { idempotency_key: crypto.randomUUID(), role: 'investigates', reason: reason || text('Work toward this problem', '推进此问题'), ...(create ? { task: { title } } : { task_id: choice }) });
        setTitle('');
        await load();
        await refresh();
    }
    catch (e) {
        toast.error(errMsg(e));
    }
    finally {
        setBusy(false);
    } }
    async function reference() { if (!result)
        return; setBusy(true); try {
        await inquiryApi.referenceTaskResult(project, thread, result.task_id, { ...problemToken(projection), stage: 'verify', work_kind: 'reference_result', reason, input_refs: [], output_refs: result.artifacts.filter(a => a.role === 'output').slice(0, 20).map(a => ({ type: 'artifact', id: a.id })) });
        await refresh();
        setResult(null);
    }
    catch (e) {
        toast.error(errMsg(e));
    }
    finally {
        setBusy(false);
    } }
    return <Card className="space-y-3 p-4">
    <h3 className="font-medium">{text('Linked Tasks', '关联任务')}</h3>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{page?.items.map(t => <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2">
        <SpaceLink className="min-w-0 break-words text-primary underline" to={`/projects/${project}/tasks/${t.id}`}>{t.title}</SpaceLink>
        <StatusBadge status={t.status}/>
        <Button variant="outline" size="sm" onClick={() => void inquiryApi.taskResult(project, thread, t.id).then(setResult).catch(e => toast.error(errMsg(e)))}>{text('View result', '查看结果')}</Button>
        </div>)}{page?.next_cursor && <Button variant="outline" onClick={() => void load(page.next_cursor!)}>{text('More Tasks', '更多任务')}</Button>}
 {editable && <div className="space-y-2 border-t border-border pt-3">
        <Input aria-label={text('New Task title', '新任务标题')} value={title} onChange={e => setTitle(e.target.value)}/>
        <Button disabled={busy || !title.trim()} onClick={() => void link(true)}>{text('Create and link Task', '创建并关联任务')}</Button>
        <Select ariaLabel={text('Existing Task', '已有任务')} value={choice} onChange={setChoice} options={[{ value: '', label: text('Choose an existing Task', '选择已有任务') }, ...choices.map(t => ({ value: t.id, label: t.title }))]}/>
        {choices.length<choiceTotal&&<Button variant="ghost" onClick={()=>void moreChoices()}>{text('More existing Tasks','更多已有任务')}</Button>}<Button variant="outline" disabled={busy || !choice} onClick={() => void link(false)}>{text('Link existing Task', '关联已有任务')}</Button>
        </div>}
 {result && <div className="space-y-2 rounded-md border border-border p-3">
        <p className="text-sm">{text('Task result', '任务结果')} · <StatusBadge status={result.status}/>
        </p>
        <SpaceLink className="text-primary underline" to={`/projects/${project}/tasks/${result.task_id}`}>{text('Open Task', '打开任务')}</SpaceLink>{result.artifacts.map((a, i) => <SpaceLink className="ml-3 text-primary underline" key={a.id} to={`/artifacts/${a.id}`}>{text('Artifact', '资料产物')} {i + 1}</SpaceLink>)}{result.artifacts_truncated && <p className="text-xs">{text('More outputs are available on the Task.', '更多产物可在任务中查看。')}</p>}{editable && <>
            <Textarea aria-label={text('Result applicability and reason', '结果适用性与理由')} value={reason} onChange={e => setReason(e.target.value)}/>
            <Button disabled={busy || !reason.trim()} onClick={() => void reference()}>{text('Reference result for verification', '引用结果以检验判断')}</Button>
            </>}</div>}
 </Card>;
}
