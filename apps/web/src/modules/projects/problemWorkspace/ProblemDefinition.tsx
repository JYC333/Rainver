import { useState } from 'react';
import { toast } from 'sonner';
import { inquiryApi } from '../../../api/client';
import type { InquiryThreadDetail } from '../../../types/api';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import { Label } from '../../../components/ui/label';
import { Card } from '../../../components/ui/card';
import { SpaceLink } from '../../../core/spaceNav';
import { errMsg } from '../../../lib/utils';
import { judgmentWords, useProblemText } from './strings';
export function ProblemDefinition({ project, detail, editable, refresh }: {
    project: string;
    detail: InquiryThreadDetail;
    editable: boolean;
    refresh: () => Promise<void>;
}) {
    const text = useProblemText();
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState(detail.statement);
    const [boundary, setBoundary] = useState(detail.scope_boundary ?? '');
    const [criteria, setCriteria] = useState(detail.question_state?.resolution_criteria ?? detail.hypothesis_state?.falsification_criteria ?? '');
    const [saving, setSaving] = useState(false);
    async function save() { setSaving(true); try {
        await inquiryApi.reviseDefinition(project, detail.id, { revision_kind: 'semantic_change', structure_action: 'narrow', new_statement: title, new_scope_boundary: boundary, ...(detail.kind === 'question' ? { new_resolution_criteria: criteria } : { new_falsification_criteria: criteria }), impact_note: 'Explicit problem definition revision' });
        setEditing(false);
        await refresh();
    }
    catch (e) {
        toast.error(errMsg(e));
    }
    finally {
        setSaving(false);
    } }
    return <Card className="min-w-0 space-y-3 p-4">
  <div className="flex flex-wrap items-center justify-between gap-2">
    <h2 className="text-lg font-semibold break-words">{detail.statement}</h2>{editable && <Button variant="outline" size="sm" onClick={() => { setTitle(detail.statement); setBoundary(detail.scope_boundary ?? ''); setCriteria(detail.question_state?.resolution_criteria ?? detail.hypothesis_state?.falsification_criteria ?? ''); setEditing(!editing); }}>{text('Edit definition', '编辑定义')}</Button>}</div>
  <p className="text-xs text-muted-foreground">{detail.lifecycle_status === 'active' ? text('Active', '进行中') : detail.lifecycle_status === 'archived' ? text('Archived', '已归档') : text('Closed', '已结束')}</p>
  {editing ? <div className="space-y-3">
        <Label htmlFor="problem-title">{text('Problem', '问题')}</Label>
        <Input id="problem-title" value={title} onChange={e => setTitle(e.target.value)}/>
        <Label htmlFor="problem-boundary">{text('Boundaries', '边界')}</Label>
        <Textarea id="problem-boundary" maxLength={4000} value={boundary} onChange={e => setBoundary(e.target.value)}/>
        <Label htmlFor="problem-criteria">{text('Success or falsification criteria', '成功或证伪判据')}</Label>
        <Textarea id="problem-criteria" value={criteria} onChange={e => setCriteria(e.target.value)}/>
        <Button disabled={saving || !title.trim()} onClick={() => void save()}>{text('Save definition', '保存定义')}</Button>
        </div> : <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
        <dt className="text-muted-foreground">{text('Boundaries', '边界')}</dt>
        <dd className="whitespace-pre-wrap break-words">{!detail.question_state&&!detail.hypothesis_state?text('Content unavailable','内容不可用'):detail.scope_boundary || text('Not specified', '未指定')}</dd>
        </div>
        <div>
        <dt className="text-muted-foreground">{detail.kind==='question'?text('Success criteria','成功判据'):text('Falsification criteria','证伪判据')}</dt>
        <dd className="whitespace-pre-wrap break-words">{!detail.question_state&&!detail.hypothesis_state?text('Content unavailable','内容不可用'):detail.question_state?.resolution_criteria || detail.hypothesis_state?.falsification_criteria || text('Not specified', '未指定')}</dd>
        </div>
        </dl>}
  <div className="border-t border-border pt-3 text-sm">
    <h3 className="font-medium">{text('Current judgment', '当前判断')}</h3>
    <p className="whitespace-pre-wrap break-words">{!detail.question_state&&!detail.hypothesis_state?text('Judgment content is unavailable','判断内容不可用'):detail.question_state?.current_answer_summary || detail.hypothesis_state?.proposed_claim || text('No judgment recorded', '尚未记录判断')}</p>
    {(detail.question_state||detail.hypothesis_state)&&<p className="text-muted-foreground">{text(...(judgmentWords[detail.question_state?.answer_state || detail.hypothesis_state?.evaluation_state || 'open'] ?? judgmentWords.open!))}</p>}
    {typeof detail.hypothesis_state?.confidence==='number'&&<p className="text-muted-foreground">{text('Confidence','置信度')}: {Math.round(detail.hypothesis_state.confidence*100)}%</p>}
    </div>
  {detail.kind === 'question' && <SpaceLink className="text-sm text-primary underline" to={`/projects/${project}/inquiry/${detail.id}/assess`}>{text('Optional question assessment (FINER)', '可选的问题评估（FINER）')}</SpaceLink>}
 </Card>;
}
