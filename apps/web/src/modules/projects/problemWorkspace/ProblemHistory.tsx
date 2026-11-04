import { useEffect, useState } from 'react';
import { inquiryApi } from '../../../api/client';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { errMsg } from '../../../lib/utils';
import { ProblemReferences, problemReferences } from './ProblemReferences';
import { useProblemText } from './strings';
import type { ProblemProjection } from './useProblem';
export function ProblemHistory({ project, thread, projection }: {
    project: string;
    thread: string;
    projection: ProblemProjection;
}) {
    const text = useProblemText();
    const [history, setHistory] = useState(projection);
    const [error, setError] = useState('');
    const [iterations, setIterations] = useState<Awaited<ReturnType<typeof inquiryApi.listIterations>>>([]);
    useEffect(() => { let live = true; setHistory(projection); void inquiryApi.listIterations(project, thread).then(v => { if (live)
        setIterations(v); }).catch(e => { if (live)
        setError(errMsg(e)); }); return () => { live = false; }; }, [project, thread, projection]);
    async function more() { try {
        const p = await inquiryApi.problem(project, thread, { ...(history.next_step_cursor ? { before_step: String(history.next_step_cursor) } : {}), ...(history.next_closeout_cursor ? { before_closeout: String(history.next_closeout_cursor) } : {}) });
        setHistory(old => ({ ...p, steps: [...old.steps, ...p.steps.filter(s => !old.steps.some(x => x.id === s.id))], closeouts: [...old.closeouts, ...p.closeouts.filter(s => !old.closeouts.some(x => x.id === s.id))] }));
    }
    catch (e) {
        setError(errMsg(e));
    } }
    return <div className="space-y-3">
    <h3 className="font-medium">{text('Current round', '当前轮次')} {projection.round_number}</h3>{error && <p role="alert">{error}</p>}{history.closeouts.map(c => <Card className="space-y-1 p-4 text-sm" key={String(c.id)}>
        <h4 className="font-medium">{text('Round', '轮次')} {String(c.round_number)}</h4>
        <p className="whitespace-pre-wrap break-words">{c.content_withheld ? text('Referenced content is no longer accessible.', '引用内容已不可访问。') : String(c.summary ?? '')}</p>
        <p className="text-muted-foreground">{c.iteration_id ? text('Judgment changed', '判断已变化') : text('Judgment unchanged', '判断未变化')}{c.compensated ? ' · ' + text('Compensated; original record retained', '已补偿，原记录保留') : ''}</p>{!!c.next_focus && <p>{text('Next intent (not active work)', '下一步意图（并非当前工作）')}: {String((c.next_focus as {
            reason?: string;
        }).reason ?? '')}</p>}<ProblemReferences project={project} refs={problemReferences(c.input_refs)}/>
        </Card>)}{history.steps.map(s => <Card className="space-y-1 p-3 text-sm" key={String(s.id)}>
        <p className="whitespace-pre-wrap break-words">{String(s.note ?? '')}</p>
        <p className="text-xs text-muted-foreground">{text('Problem work', '问题工作')} · {text('Round', '轮次') + ' ' + s.round_number}</p><ProblemReferences project={project} refs={problemReferences(s.context_refs)}/>
        </Card>)}{(history.next_step_cursor || history.next_closeout_cursor) && <Button variant="outline" onClick={() => void more()}>{text('Earlier history', '更早历史')}</Button>}{iterations.length > 0 && <details>
        <summary className="cursor-pointer text-sm">{text('Judgment history (separate from rounds)', '判断历史（与轮次分开）')}</summary>{iterations.map(i => <Card className="mt-2 p-3 text-sm" key={i.id}>
            <p>{i.change_summary}</p>
            <time>{new Date(i.created_at).toLocaleString()}</time>
            </Card>)}</details>}</div>;
}
