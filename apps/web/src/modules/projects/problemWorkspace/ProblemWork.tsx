import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ProblemStage, ProblemReference } from '@rainver/protocol';
import { inquiryApi, notesApi } from '../../../api/client';
import { Button } from '../../../components/ui/button';
import { Textarea } from '../../../components/ui/textarea';
import { Select } from '../../../components/ui/select';
import { Label } from '../../../components/ui/label';
import { Card } from '../../../components/ui/card';
import { ProblemReferences, problemReferences } from './ProblemReferences';
import { errMsg } from '../../../lib/utils';
import { problemToken, type ProblemProjection } from './useProblem';
import { useProblemText } from './strings';
export const stageOrder: ProblemStage[] = ['frame', 'plan', 'act', 'verify', 'conclude'];
export const stageWords: Record<ProblemStage, [
    string,
    string
]> = { frame: ['Frame', '明确问题'], plan: ['Plan', '制定方案'], act: ['Act', '采取行动'], verify: ['Verify', '检验判断'], conclude: ['Conclude', '总结本轮'] };
export function ProblemWork({ project, thread, projection, stage, editable, refresh }: {
    project: string;
    thread: string;
    projection: ProblemProjection;
    stage: ProblemStage;
    editable: boolean;
    refresh: () => Promise<void>;
}) {
    const text = useProblemText();
    const [reason, setReason] = useState('');
    const [action, setAction] = useState('record_work');
    const [target, setTarget] = useState<ProblemStage>(stage);
    const [ref, setRef] = useState('');
    const [notes, setNotes] = useState<{
        id: string;
        title: string;
    }[]>([]);
    const [noteTotal,setNoteTotal]=useState(0);
    async function moreNotes(){try{const p=await notesApi.list({project_id:project,limit:100,offset:notes.length});setNotes(old=>[...old,...p.items]);setNoteTotal(p.total)}catch(e){toast.error(errMsg(e))}}
    const [saving, setSaving] = useState(false);
    useEffect(() => { setTarget(stageOrder[(stageOrder.indexOf(stage) + 1) % 5]!); }, [stage]);
    useEffect(() => { let live = true; void notesApi.list({ project_id: project, limit: 100 }).then(p => { if (live)
        {setNotes(p.items);setNoteTotal(p.total)} }).catch(e=>toast.error(errMsg(e))); return () => { live = false; }; }, [project]);
    async function record() { setSaving(true); try {
        const refs: ProblemReference[] = ref ? [{ type: 'note', id: ref }] : [];
        await inquiryApi.recordProblemWork(project, thread, { ...problemToken(projection), stage: action === 'skip' ? target : stage, work_kind: action === 'record_work' ? 'record_work' : action === 'reference_result' ? 'reference_result' : 'select_method', reason, input_refs: refs, output_refs: [], skipped_stages: [], ...(action === 'skip' ? { selection_kind: 'skip' as const, skipped_stages: [stage] } : action === 'return' ? { selection_kind: 'return' as const } : action === 'select' ? { selection_kind: 'select' as const } : {}) });
        setReason('');
        await refresh();
    }
    catch (e) {
        toast.error(errMsg(e));
    }
    finally {
        setSaving(false);
    } }
    const selected = projection.stages.find(s => s.stage === stage), primary = projection.steps.find(s => s.id === projection.current_focus?.step_id);
    return <div className="space-y-4">
  <Card className="space-y-2 p-4">
    <h3 className="font-medium">{text('Current focus', '当前关注')}</h3>{projection.current_focus?.stage&&<p className="text-xs text-muted-foreground">{text('Current work stage','当前工作阶段')}: {text(...stageWords[projection.current_focus.stage])}</p>}
    <p className="whitespace-pre-wrap text-sm break-words">{primary ? String(primary.note ?? text('Selected work', '已选择的工作')) : projection.current_focus ? text('Work is selected; its description is in earlier history.', '已选择工作，具体记录在较早历史中。') : text('No work selected. Browsing stages does not start work.', '尚未选择工作。浏览阶段不会启动工作。')}</p>
    <p className="text-xs text-muted-foreground">{text('Round', '本轮')} {projection.round_number} · {text('Outputs in this stage', '本阶段已有产物')}: {selected?.has_outputs ? text('Recorded', '已记录') : text('None visible', '暂无可见产物')}</p>
    </Card>
  {editable && <Card className="space-y-3 p-4">
        <h3 className="font-medium">{text('Choose actual work', '选择实际工作')}</h3><p className="text-sm text-muted-foreground">{selected?.purpose}</p>
        <Select ariaLabel={text('Work action', '工作动作')} value={action} onChange={setAction} options={[{ value: 'record_work', label: text('Record work', '记录工作') }, { value: 'select', label: text('Choose a method', '选择方法') }, { value: 'skip', label: text('Skip this stage', '跳过本阶段') }, { value: 'return', label: text('Return to this stage', '回到本阶段') }, { value: 'reference_result', label: text('Reference evidence', '引用证据') }]}/>{action === 'skip' && <Select ariaLabel={text('Next work stage', '下一工作阶段')} value={target} onChange={s => setTarget(s as ProblemStage)} options={stageOrder.filter(s => s !== stage).map(s => ({ value: s, label: text(...stageWords[s]) }))}/>}
  <Label htmlFor="work-reason">{text('Work and reason', '工作与理由')}</Label>
        <Textarea id="work-reason" value={reason} maxLength={4000} onChange={e => setReason(e.target.value)}/>
        <Select ariaLabel={text('Evidence note', '证据笔记')} value={ref} onChange={setRef} options={[{ value: '', label: text('No note reference', '不引用笔记') }, ...notes.map(n => ({ value: n.id, label: n.title }))]}/>
        {notes.length<noteTotal&&<Button variant="ghost" onClick={()=>void moreNotes()}>{text('More evidence notes','更多证据笔记')}</Button>}<Button disabled={saving || !reason.trim()} onClick={() => void record()}>{text('Record selected work', '记录所选工作')}</Button>
        </Card>}
  <Card className="space-y-3 p-4">
    <h3 className="font-medium">{text('Work and actual outputs', '工作与实际产物')}</h3>{projection.steps.filter(s => (s.method_stage ?? null) === stage).map(s => <article className="space-y-1 border-t border-border pt-2 text-sm" key={String(s.id)}>
        <p className="whitespace-pre-wrap break-words">{String(s.note ?? '')}</p>
        <p className="text-xs text-muted-foreground">{text('Problem work', '问题工作')} · {s.ended_reason==='round_closed'?text('Ended with the round','随本轮结束'):String(s.status) === 'in_progress' ? text('In progress', '进行中') : String(s.status) === 'done' ? text('Ended', '已结束') : text('Stopped', '已停止')}</p>
        <ProblemReferences project={project} refs={problemReferences(s.context_refs)}/>
        </article>)}</Card>
 </div>;
}
