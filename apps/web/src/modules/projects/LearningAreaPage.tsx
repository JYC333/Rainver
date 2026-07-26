import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Plus } from 'lucide-react'
import { knowledgeApi, learningApi, type LearningItem, type LearningObjective } from '../../api/client'
import type { KnowledgeItemSummary } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import { Badge } from '../../components/ui/badge'
import { toast } from 'sonner'

const err = (error: unknown) => error instanceof Error ? error.message : String(error)

export default function LearningAreaPage() {
  const { projectId = '' } = useParams()
  const [objectives, setObjectives] = useState<LearningObjective[]>([])
  const [items, setItems] = useState<LearningItem[]>([])
  const [objectiveTitle, setObjectiveTitle] = useState('')
  const [objectiveId, setObjectiveId] = useState('')
  const [knowledgeId, setKnowledgeId] = useState('')
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItemSummary[]>([])
  const [knowledgeQuery, setKnowledgeQuery] = useState('')
  const [knowledgeSearch, setKnowledgeSearch] = useState('')
  const [prompt, setPrompt] = useState('')
  const [answer, setAnswer] = useState('')

  const load = useCallback(async () => {
    const [nextObjectives, nextItems, knowledgePage] = await Promise.all([
      learningApi.objectives(projectId),
      learningApi.items(projectId),
      knowledgeApi.list({ status: 'active', q: knowledgeQuery || undefined, limit: 100 }),
    ])
    setObjectives(nextObjectives); setItems(nextItems)
    setKnowledgeItems(knowledgePage.items.filter(item => item.project_id === null || item.project_id === projectId))
    setObjectiveId(current => current || nextObjectives[0]?.id || '')
  }, [knowledgeQuery, projectId])
  useEffect(() => { load().catch(error => toast.error(err(error))) }, [load])

  async function run(action: () => Promise<unknown>) {
    try { await action(); await load() } catch (error) { toast.error(err(error)) }
  }

  return <div className="p-6 space-y-5">
    <div className="flex items-center gap-3"><Button variant="ghost" size="sm" asChild><Link to={`/projects/${projectId}`}><ArrowLeft className="size-4" />Project</Link></Button><div><h1 className="text-xl font-semibold">Learning</h1><p className="text-sm text-muted-foreground">Turn shared, versioned Knowledge into durable cards and exercises.</p></div></div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4 space-y-3"><h2 className="font-medium">Learning objectives</h2><div className="flex gap-2"><Input placeholder="Objective" value={objectiveTitle} onChange={e => setObjectiveTitle(e.target.value)} /><Button disabled={!objectiveTitle.trim()} onClick={() => run(async () => { await learningApi.createObjective({ project_id: projectId, title: objectiveTitle }); setObjectiveTitle('') })}><Plus className="size-4" />Add</Button></div>{objectives.map(item => <button key={item.id} onClick={() => setObjectiveId(item.id)} className={`w-full rounded border p-3 text-left ${objectiveId === item.id ? 'border-primary bg-muted' : ''}`}>{item.title}</button>)}</Card>
      <Card className="p-4 space-y-3">
        <h2 className="font-medium">Create a learning item</h2>
        <div className="flex gap-2">
          <Input aria-label="Search Knowledge" placeholder="Search shared or Project Knowledge" value={knowledgeSearch} onChange={e => setKnowledgeSearch(e.target.value)} onKeyDown={event => { if (event.key === 'Enter') setKnowledgeQuery(knowledgeSearch.trim()) }} />
          <Button type="button" variant="outline" onClick={() => setKnowledgeQuery(knowledgeSearch.trim())}>Search</Button>
        </div>
        <select aria-label="Knowledge item" className="w-full rounded-md border bg-background p-2 text-sm" value={knowledgeId} onChange={e => setKnowledgeId(e.target.value)}>
          <option value="">{knowledgeItems.length ? 'Select Knowledge' : 'No matching active Knowledge'}</option>
          {knowledgeItems.map(item => <option key={item.id} value={item.id}>{item.title} · v{item.version}{item.project_id ? ' · this Project' : ' · shared'}</option>)}
        </select>
        <Textarea placeholder="Prompt" value={prompt} onChange={e => setPrompt(e.target.value)} />
        <Textarea placeholder="Answer" value={answer} onChange={e => setAnswer(e.target.value)} />
        <Button disabled={!knowledgeId || !prompt.trim() || !answer.trim()} onClick={() => run(async () => { await learningApi.createItem({ project_id: projectId, objective_id: objectiveId || undefined, knowledge_item_id: knowledgeId, item_kind: 'card', prompt, answer }); setPrompt(''); setAnswer('') })}>Create card</Button>
      </Card>
    </div>
    <div className="grid gap-3 md:grid-cols-2">{items.map(item => <Card key={item.id} className="p-4 space-y-3"><div className="flex justify-between"><Badge variant="outline">{item.item_kind}</Badge><span className="text-xs text-muted-foreground">Knowledge v{item.knowledge_item_version}</span></div><p className="font-medium">{item.prompt}</p><details><summary className="cursor-pointer text-sm text-muted-foreground">Show answer</summary><p className="mt-2 text-sm">{item.answer}</p></details><div className="flex gap-2"><Button size="sm" onClick={() => run(() => learningApi.review(item.id, 'correct'))}>Correct</Button><Button size="sm" variant="outline" onClick={() => run(() => learningApi.review(item.id, 'incorrect'))}>Needs work</Button></div></Card>)}</div>
  </div>
}
