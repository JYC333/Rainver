import {ProjectResearchStandingPanel} from '../ProjectResearchStandingPanel';
import { useEffect, useState,useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { ProblemStage } from '@rainver/protocol';
import {usePeriodicRefresh} from '../../../hooks/usePeriodicRefresh';
import { inquiryApi } from '../../../api/client';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Select } from '../../../components/ui/select';
import { Card } from '../../../components/ui/card';
import { SpaceLink } from '../../../core/spaceNav';
import { errMsg } from '../../../lib/utils';
import { useProblem } from './useProblem';
import { useProblemText } from './strings';
import { ProblemDefinition } from './ProblemDefinition';
import { ProblemWork, stageOrder, stageWords } from './ProblemWork';
import { ProblemTasks } from './ProblemTasks';
import { ProblemResearch } from './ProblemResearch';
import { ProblemCloseout } from './ProblemCloseout';
import { ProblemHistory } from './ProblemHistory';
type Page = Awaited<ReturnType<typeof inquiryApi.workspaceThreads>>;
export default function ProblemAreaPage() {
    const { projectId = '' } = useParams();
    const [params, setParams] = useSearchParams(), text = useProblemText(), thread = params.get('thread'), section = params.get('section') ?? 'work', stage = (stageOrder.includes(params.get('stage') as ProblemStage) ? params.get('stage') : 'frame') as ProblemStage;
    const [items, setItems] = useState<Page['items']>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [filter, setFilter] = useState('active');
    const [query, setQuery] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [canCreate, setCanCreate] = useState(false);
    const [title, setTitle] = useState('');
    const [creating, setCreating] = useState(false);
    const [kind, setKind] = useState<'question'|'hypothesis'>('question');
    const problem = useProblem(projectId, thread);
    const quietRefresh=useCallback(()=>problem.refresh(true),[problem.refresh]);
    usePeriodicRefresh(quietRefresh,5000,stage!=='conclude'&&section!=='history'&&!!(problem.projection?.current_focus||problem.projection?.stages.some(s=>s.running)));
    function navigate(values: Record<string, string>) { const next = new URLSearchParams(params); for (const [k, v] of Object.entries(values))
        next.set(k, v); next.delete('view'); setParams(next); }
    async function list(after?: string) { setLoading(true); try {
        const page = await inquiryApi.workspaceThreads(projectId, { status: filter, q: query, ...(after ? { after_thread_id: after } : {}) });
        setItems(old => after ? [...old, ...page.items] : page.items);
        setCursor(page.next_cursor);
        setError('');
    }
    catch (e) {
        setError(errMsg(e));
    }
    finally {
        setLoading(false);
    } }
    useEffect(() => { let live = true; setItems([]); setLoading(true); void inquiryApi.workspaceThreads(projectId, { status: filter, q: query }).then(p => { if (live) {
        setItems(p.items);
        setCursor(p.next_cursor);
        setError('');
    } }).catch(e => { if (live)
        setError(errMsg(e)); }).finally(() => { if (live)
        setLoading(false); }); return () => { live = false; }; }, [projectId, filter, query]);
    useEffect(() => { let live = true; setCanCreate(false); void inquiryApi.workspaceAccess(projectId).then(p => { if (live)
        setCanCreate(p.can_write); }).catch(() => { }); return () => { live = false; }; }, [projectId]);
    async function create() { setCreating(true); try {
        const t = await inquiryApi.createThread(projectId, { kind, statement: title });
        setTitle('');
        navigate({ thread: t.id, section: 'work', stage: 'frame' });
        await list();
    }
    catch (e) {
        toast.error(errMsg(e));
    }
    finally {
        setCreating(false);
    } }
    async function refreshAll(){await problem.refresh();await list()}
    const detail = problem.detail, projection = problem.projection, editable = !!projection?.can_write && detail?.lifecycle_status === 'active';
    return <main className="min-w-0 space-y-4 p-4 md:p-6">
    <header className="flex flex-wrap items-center justify-between gap-3">
    <div>
    <h1 className="text-xl font-semibold">{text('Problem workspace', '问题推进')}</h1>
    <p className="text-sm text-muted-foreground">{text('Choose work, examine results, and close a round when ready.', '选择工作、检验产物，并在适当时收尾本轮。')}</p>
    </div>
    <SpaceLink className="text-sm text-primary underline" to={`/projects/${projectId}/inquiry?section=standing`}>{text('Monitoring overview','监测汇总')}</SpaceLink><SpaceLink className="text-sm text-primary underline" to={`/projects/${projectId}/inquiry/records?tab=runs`}>{text('Research records', '研究记录')}</SpaceLink>
    </header>
 {thread&&<Button variant="outline" className="xl:hidden" onClick={()=>{const next=new URLSearchParams(params);next.delete('thread');setParams(next)}}>{text('All problems','所有问题')}</Button>}<nav className="flex flex-wrap gap-4 text-sm" aria-label={text('Other problem views', '其他问题视图')}>{[['map', text('Map', '关系图')], ['review', text('Review', '审核')], ['experiments', text('Experiments', '实验')]].map(([view, label]) => <SpaceLink className="text-primary underline" key={view} to={`/projects/${projectId}/inquiry?view=${view}`}>{label}</SpaceLink>)}</nav>
 {section==='standing'?<ProjectResearchStandingPanel key={projectId} projectId={projectId} canAct={canCreate}/>:<div className="grid min-w-0 gap-4 xl:grid-cols-[15rem_minmax(0,1fr)]">
    <aside className={`min-w-0 space-y-3 ${thread?'hidden xl:block':''}`}>
    <Input aria-label={text('Find a problem', '查找问题')} value={query} onChange={e => setQuery(e.target.value)}/>
    <Select ariaLabel={text('Problem status', '问题状态')} value={filter} onChange={setFilter} options={[{ value: 'active', label: text('Active', '进行中') }, { value: 'history', label: text('History', '历史') }, { value: 'all', label: text('All', '全部') }]}/>{error && <p role="alert">{error}</p>}{loading && <p role="status">{text('Loading…', '加载中…')}</p>}
 {items.map(t => <button key={t.id} type="button" aria-current={thread === t.id ? 'page' : undefined} className={`block w-full min-w-0 rounded-md border p-3 text-left text-sm ${thread === t.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'}`} onClick={() => navigate({ thread: t.id })}>
        <span className="block break-words font-medium">{t.statement}{t.statement_truncated ? '…' : ''}</span>{t.judgment && <span className="mt-1 block break-words text-xs text-muted-foreground">{t.judgment}</span>}</button>)}{cursor && <Button variant="outline" disabled={loading} onClick={() => void list(cursor)}>{text('More problems', '更多问题')}</Button>}
 {canCreate && <Card className="space-y-2 p-3">
        <h2 className="text-sm font-medium">{text('New problem', '新问题')}</h2>
        <Input aria-label={text('Problem statement', '问题描述')} value={title} onChange={e => setTitle(e.target.value)}/>
        <Select ariaLabel={text('Problem type', '问题类型')} value={kind} onChange={value=>{if(value==='question'||value==='hypothesis')setKind(value)}} options={[{ value: 'question', label: text('Question', '问题') }, { value: 'hypothesis', label: text('Hypothesis', '假设') }]}/>
        <Button disabled={creating || !title.trim()} onClick={() => void create()}>{text('Create problem', '创建问题')}</Button>
        </Card>}</aside>
 <div className="min-w-0 space-y-4">{!thread ? <Card className="p-6">{text('Select a problem. Tasks and daily reading also work independently.', '请选择问题；任务和日常阅读也可独立进行。')}</Card> : <>{problem.loading && <p role="status">{text('Loading problem…', '正在加载问题…')}</p>}{problem.error && <Card className="space-y-2 p-4">
            <p role="alert">{problem.error}</p>
            <Button variant="outline" onClick={() => void problem.refresh()}>{text('Retry', '重试')}</Button>
            </Card>}{detail && <ProblemDefinition key={detail.id} project={projectId} detail={detail} editable={editable} refresh={refreshAll}/>}{detail && projection && <>{detail.blocked_reason && <p className="text-sm text-destructive">{text('Work is blocked: ', '工作受阻：')}{detail.blocked_reason}</p>}{!editable && <p className="text-sm text-muted-foreground">{text('Read only: this problem is closed or you do not have change access.', '只读：问题已结束或你没有更改权限。')}</p>}
 <nav className="flex flex-wrap gap-2" aria-label={text('Problem stages', '问题阶段')}>{stageOrder.map(s => { const fact = projection.stages.find(x => x.stage === s); return <Button key={s} variant={stage === s ? 'default' : 'outline'} aria-pressed={stage === s} onClick={() => navigate({ stage: s, section: 'work' })}>{text(...stageWords[s])}{fact?.running ? ' · ' + text('running', '执行中') : fact?.has_outputs ? ' · ' + text('outputs', '有产物') : fact?.worked ? ' · ' + text('worked', '有工作') : ''}</Button>; })}</nav>
 <nav className="flex flex-wrap gap-2" aria-label={text('Problem sections', '问题内容')}>{[['work', text('Work', '工作')], ['tasks', text('Linked tasks', '关联任务')], ['research', text('Research', '研究')], ['history', text('Rounds and history', '轮次与历史')]].map(([value, label]) => <Button key={value} variant={section === value ? 'secondary' : 'ghost'} aria-pressed={section === value} onClick={() => navigate({ section: value })}>{label}</Button>)}</nav>
 {section === 'tasks' ? <ProblemTasks key={thread} project={projectId} thread={thread} projection={projection} editable={editable} refresh={refreshAll}/> : section === 'research' ? <ProblemResearch key={thread} project={projectId} thread={thread} kind={detail.kind} projection={projection} editable={editable} refresh={refreshAll}/> : section === 'history' ? <ProblemHistory key={thread} project={projectId} thread={thread} projection={projection}/> : <>
                <ProblemWork key={`${thread}:${stage}`} project={projectId} thread={thread} projection={projection} stage={stage} editable={editable && !detail.blocked_reason} refresh={refreshAll}/>{stage === 'conclude' && <ProblemCloseout key={`${thread}:${projection.revision}`} project={projectId} detail={detail} projection={projection} editable={editable} refresh={refreshAll}/>}</>}
 </>}</>}</div>
    </div>}
    </main>;
}
