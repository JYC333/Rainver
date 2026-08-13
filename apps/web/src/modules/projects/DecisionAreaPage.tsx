import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Plus } from 'lucide-react'
import { decisionCasesApi, inquiryApi, type DecisionCase } from '../../api/client'
import type { InquiryThread } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import { Badge } from '../../components/ui/badge'
import { Select } from '../../components/ui/select'
import { toast } from 'sonner'
import { ThreadOriginBar } from './inquiryArea/ThreadOriginBar'

const err = (error: unknown) => error instanceof Error ? error.message : String(error)

export default function DecisionAreaPage() {
  const { projectId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const [cases, setCases] = useState<DecisionCase[]>([])
  const [selected, setSelected] = useState<DecisionCase | null>(null)
  const [title, setTitle] = useState('')
  const [framing, setFraming] = useState('')
  const [option, setOption] = useState('')
  const [criterion, setCriterion] = useState('')
  const [commitment, setCommitment] = useState('')
  const [threads, setThreads] = useState<InquiryThread[]>([])
  const [sourceThreadIds, setSourceThreadIds] = useState<string[]>([])

  const load = useCallback(async (caseId?: string) => {
    const [rows, threadRows] = await Promise.all([
      decisionCasesApi.list(projectId),
      inquiryApi.listThreads(projectId),
    ])
    setCases(rows)
    setThreads(threadRows)
    const id = caseId ?? searchParams.get('open') ?? selected?.id ?? rows[0]?.id
    setSelected(id ? await decisionCasesApi.get(projectId, id) : null)
  }, [projectId, searchParams, selected?.id])
  useEffect(() => { load().catch(error => toast.error(err(error))) }, [projectId])

  async function run(action: () => Promise<unknown>) {
    try { await action(); await load() } catch (error) { toast.error(err(error)) }
  }

  async function createCase() {
    try {
      const created = await decisionCasesApi.create(projectId, {
        title,
        framing,
        source_thread_ids: sourceThreadIds,
      })
      setTitle('')
      setFraming('')
      setSourceThreadIds([])
      await load(created.id)
    } catch (error) {
      toast.error(err(error))
    }
  }

  return <div className="p-6 space-y-5">
    <ThreadOriginBar projectId={projectId} kinds={['create_decision_case']} />
    <div className="flex items-center gap-3"><Button variant="ghost" size="sm" asChild><Link to={`/projects/${projectId}`}><ArrowLeft className="size-4" />Project</Link></Button><div><h1 className="text-xl font-semibold">Decisions</h1><p className="text-sm text-muted-foreground">Frame choices, compare options, commit, then create Delivery work.</p></div></div>
    <Card className="grid gap-3 p-4">
      <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]"><Input placeholder="Decision title" value={title} onChange={e => setTitle(e.target.value)} /><Input placeholder="Framing (optional)" value={framing} onChange={e => setFraming(e.target.value)} /><Button disabled={!title.trim()} onClick={createCase}><Plus className="size-4" />New case</Button></div>
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">Related Inquiry Threads (optional)</p>
        <div className="flex flex-wrap gap-2">
          {threads.map(thread => <label key={thread.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"><input type="checkbox" checked={sourceThreadIds.includes(thread.id)} onChange={event => setSourceThreadIds(current => event.target.checked ? [...current, thread.id] : current.filter(id => id !== thread.id))} />{thread.statement}</label>)}
          {threads.length === 0 && <span className="text-xs text-muted-foreground">No Inquiry Threads yet; this Decision will be standalone.</span>}
        </div>
      </div>
    </Card>
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <Card className="p-3 space-y-2">{cases.map(item => <button key={item.id} onClick={() => decisionCasesApi.get(projectId, item.id).then(setSelected)} className={`w-full text-left rounded-md border p-3 ${selected?.id === item.id ? 'border-primary bg-muted' : ''}`}><div className="flex justify-between"><span className="font-medium text-sm">{item.title}</span><Badge variant="outline">{item.status}</Badge></div><p className="text-xs text-muted-foreground mt-1">{item.framing}</p></button>)}{cases.length === 0 && <p className="p-3 text-sm text-muted-foreground">No Decision Cases yet.</p>}</Card>
      <Card className="p-5 space-y-5">{selected ? <>
        <div><h2 className="font-semibold">{selected.title}</h2><p className="text-sm text-muted-foreground">{selected.framing}</p>{(selected.source_thread_ids?.length ?? 0) > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{selected.source_thread_ids?.map(id => { const thread = threads.find(item => item.id === id); return <Button key={id} size="sm" variant="outline" asChild><Link to={`/projects/${projectId}/inquiry`}>{thread?.statement ?? 'Related Inquiry Thread'}</Link></Button> })}</div>}</div>
        {selected.status === 'open' && <><div className="flex gap-2"><Input placeholder="Add option" value={option} onChange={e => setOption(e.target.value)} /><Button disabled={!option.trim()} onClick={() => run(async () => { await decisionCasesApi.addOption(projectId, selected.id, { title: option }); setOption('') })}>Add option</Button></div><div className="flex gap-2"><Input placeholder="Add criterion" value={criterion} onChange={e => setCriterion(e.target.value)} /><Button disabled={!criterion.trim()} onClick={() => run(async () => { await decisionCasesApi.addCriterion(projectId, selected.id, { name: criterion, weight: 3 }); setCriterion('') })}>Add criterion</Button></div></>}
        <div className="space-y-2"><h3 className="text-sm font-medium">Options</h3>{selected.options?.map(item => <div key={item.id} className="flex items-center justify-between rounded border p-3"><span>{item.title}</span>{selected.status === 'open' && <Button size="sm" variant="outline" onClick={() => run(() => decisionCasesApi.decide(projectId, selected.id, item.id))}>Choose</Button>}</div>)}</div>
        {selected.status === 'open' && (selected.criteria?.length ?? 0) > 0 && <div className="space-y-2"><h3 className="text-sm font-medium">Trade-off scores</h3>{selected.options?.flatMap(optionRow => selected.criteria?.map(criterionRow => {
          const score = selected.scores?.find(item => item.option_id === optionRow.id && item.criterion_id === criterionRow.id)?.score
          return <div key={`${optionRow.id}:${criterionRow.id}`} className="grid grid-cols-[1fr_1fr_100px] items-center gap-2 rounded border p-2 text-sm"><span>{optionRow.title}</span><span>{criterionRow.name}</span><Select value={score ? String(score) : ''} ariaLabel={`Score ${optionRow.title} for ${criterionRow.name}`} options={[{ value: '', label: 'Score' }, ...[1, 2, 3, 4, 5].map(value => ({ value: String(value), label: String(value) }))]} onChange={value => value && run(() => decisionCasesApi.score(projectId, selected.id, { option_id: optionRow.id, criterion_id: criterionRow.id, score: Number(value) }))} /></div>
        }))}</div>}
        {selected.status === 'decided' && <><div className="flex gap-2"><Textarea placeholder="Commitment statement" value={commitment} onChange={e => setCommitment(e.target.value)} /><Button disabled={!commitment.trim()} onClick={() => run(async () => { await decisionCasesApi.addCommitment(projectId, selected.id, commitment); setCommitment('') })}>Commit</Button></div><div className="space-y-2">{selected.commitments?.map(item => <div key={item.id} className="flex items-center justify-between rounded border p-3"><span>{item.statement}</span>{item.created_delivery_task_id ? <Badge>Delivery created</Badge> : <Button size="sm" onClick={() => run(() => decisionCasesApi.createDelivery(projectId, selected.id, item.id))}>Create Delivery task</Button>}</div>)}</div></>}
      </> : <p className="text-sm text-muted-foreground">Select a Decision Case.</p>}</Card>
    </div>
  </div>
}
