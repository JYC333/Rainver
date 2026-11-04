import { problemReferences } from './ProblemReferences';
import { useState } from 'react';
import { toast } from 'sonner';
import { inquiryApi } from '../../../api/client';
import type { InquiryThreadDetail } from '../../../types/api';
import { Button } from '../../../components/ui/button';
import { Textarea } from '../../../components/ui/textarea';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Select } from '../../../components/ui/select';
import { Card } from '../../../components/ui/card';
import { errMsg } from '../../../lib/utils';
import { problemToken, type ProblemProjection } from './useProblem';
import { judgmentWords, useProblemText } from './strings';
export function ProblemCloseout({ project, detail, projection, editable, refresh }: {
    project: string;
    detail: InquiryThreadDetail;
    projection: ProblemProjection;
    editable: boolean;
    refresh: () => Promise<void>;
}) {
    const text = useProblemText();
    const [summary, setSummary] = useState('');
    const [changed, setChanged] = useState('unchanged');
    const [answer, setAnswer] = useState(detail.question_state?.current_answer_summary ?? '');
    const [state, setState] = useState<string>(detail.question_state?.answer_state ?? detail.hypothesis_state?.evaluation_state ?? 'open');
    const [confidence, setConfidence] = useState(detail.hypothesis_state?.confidence?.toString() ?? '');
    const [next, setNext] = useState('');
    const [saving, setSaving] = useState(false);
    const [includeRefs, setIncludeRefs] = useState(false);
    const refs = problemReferences(projection.steps.filter(s => s.round_number === projection.round_number).flatMap(s => Array.isArray(s.context_refs) ? s.context_refs : [])).filter((r, i, a) => a.findIndex(x => x.type === r.type && x.id === r.id) === i).slice(0, 20);
    async function close() { setSaving(true); try {
        const token = problemToken(projection);
        if (changed === 'unchanged')
            await inquiryApi.closeProblemRound(project, detail.id, { ...token, summary, input_refs: includeRefs ? refs : [], ...(next.trim() ? { next_focus: { stage: 'frame', work_kind: 'record_work', reason: next } } : {}) });
        else
            await inquiryApi.recordIteration(project, detail.id, { ...token, round_intent: 'close_round', change_summary: summary, input_refs: includeRefs ? refs : [], ...(detail.kind === 'question' ? { answer_state: state, current_answer_summary: answer.trim() || null } : { evaluation_state: state, ...(confidence === '' ? {} : { confidence: Number(confidence) }) }) });
        setSummary('');
        await refresh();
    }
    catch (e) {
        toast.error(errMsg(e));
    }
    finally {
        setSaving(false);
    } }
    return <Card className="space-y-3 p-4">
    <h3 className="font-medium">{text('Close this round', '本轮收尾')}</h3>
    <p className="text-sm text-muted-foreground">{text('A round can end with no change in judgment. Tasks and research are not completed by this action.', '判断不变也可收尾；此操作不会完成任务或研究。')}</p>{editable && <>
        <Select ariaLabel={text('Judgment change', '判断变化')} value={changed} onChange={setChanged} options={[{ value: 'unchanged', label: text('Keep current judgment', '保持当前判断') }, { value: 'changed', label: text('Record a changed judgment', '记录判断变化') }]}/>{changed === 'changed' && <>
            <Select ariaLabel={text('Judgment state', '判断状态')} value={state} onChange={setState} options={(detail.kind === 'question' ? ['open', 'partial', 'answered', 'unanswerable'] : ['untested', 'supported', 'challenged', 'contradicted', 'inconclusive']).map(v => ({ value: v, label: judgmentWords[v] ? text(...judgmentWords[v]) : v }))}/>{detail.kind === 'question' ? <Textarea aria-label={text('Updated answer', '更新后的答案')} value={answer} onChange={e => setAnswer(e.target.value)}/> : <Input aria-label={text('Confidence, optional', '置信度（可选）')} type="number" min={0} max={1} step={0.05} value={confidence} onChange={e => setConfidence(e.target.value)}/>}</>}
 <Label htmlFor="round-summary">{text('Summary and remaining gaps', '总结与剩余缺口')}</Label>
        <Textarea id="round-summary" maxLength={4000} value={summary} onChange={e => setSummary(e.target.value)}/>{changed === 'unchanged' && <>
            <Label htmlFor="round-next">{text('Next intent, optional (does not start work)', '下一步意图（可选，不会启动工作）')}</Label>
            <Textarea id="round-next" value={next} onChange={e => setNext(e.target.value)}/>
            </>}{refs.length > 0 && <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeRefs} onChange={e => setIncludeRefs(e.target.checked)}/>{text('Include displayed work references (up to 20)', '附上已显示工作的引用（最多 20 条）')}</label>}<Button disabled={saving || !summary.trim() || (changed === 'changed' && (detail.kind === 'question' ? state === detail.question_state?.answer_state && (answer.trim() || null) === (detail.question_state.current_answer_summary || null) : state === detail.hypothesis_state?.evaluation_state && (confidence === '' ? null : Number(confidence)) === (detail.hypothesis_state.confidence ?? null)))} onClick={() => void close()}>{text('Close round', '收尾本轮')}</Button>
        </>}</Card>;
}
