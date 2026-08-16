import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { focusAreasApi, knowledgeApi, notesApi, projectsApi } from '../../api/client'
import type { FocusArea, FocusAreaContents } from '../../types/api'
import { SpaceLink as Link } from '../../core/spaceNav'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import KnowledgeSectionHeader from '../knowledge/KnowledgeSectionHeader'
import { EmptyState } from '../../components/ui/empty-state'
import { Input } from '../../components/ui/input'
import { errMsg } from '../../lib/utils'

/**
 * A focus area aggregates what already exists and grants nothing. Everything
 * listed here is content the viewer could already reach; classifying never
 * widens access (ADR 0015).
 */
export default function FocusAreaList() {
  const [areas, setAreas] = useState<FocusArea[]>([])
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setAreas(await focusAreasApi.list())
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setCreating(true)
    try {
      await focusAreasApi.create({ name: trimmed })
      setName('')
      await load()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-4 p-4">
      <KnowledgeSectionHeader section="domains" />

      <Card className="p-4 flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="focus-area-name">New domain</label>
          <Input
            id="focus-area-name"
            value={name}
            placeholder="My finances"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void create() }}
          />
        </div>
        <Button onClick={() => void create()} disabled={creating || !name.trim()}>
          {creating ? 'Creating…' : 'Create'}
        </Button>
      </Card>

      {loading ? null : areas.length === 0 ? (
        <EmptyState title="No domains yet" description="Create one for something you return to over time." />
      ) : (
        <div className="grid gap-2">
          {areas.map((area) => (
            <Link key={area.id} to={`/knowledge/domains/${area.id}`}>
              <Card className="p-3 hover:bg-accent/50">
                <div className="font-medium text-sm">{area.name}</div>
                {area.description ? (
                  <p className="text-xs text-muted-foreground mt-1">{area.description}</p>
                ) : null}
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export function FocusAreaDetail() {
  const { focusAreaId: id = '' } = useParams()
  const [area, setArea] = useState<FocusArea | null>(null)
  const [contents, setContents] = useState<FocusAreaContents | null>(null)
  const [projectOptions, setProjectOptions] = useState<Choice[]>([])
  const [objectOptions, setObjectOptions] = useState<Choice[]>([])
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      // Notes and Knowledge items are `space_objects` subtypes keyed on the
      // object id, so their list ids are exactly what the classification
      // endpoint expects.
      const [a, c, projects, notes, items] = await Promise.all([
        focusAreasApi.get(id),
        focusAreasApi.contents(id),
        projectsApi.list({ status: 'active', limit: 200 }),
        notesApi.list({ limit: 100 }),
        knowledgeApi.list({ limit: 100 }),
      ])
      setArea(a)
      setContents(c)
      setProjectOptions(projects.items.map((p) => ({ id: p.id, label: p.name })))
      setObjectOptions([
        ...notes.items.map((n) => ({ id: n.id, label: n.title || 'Untitled note' })),
        ...items.items.map((k) => ({ id: k.id, label: k.title || 'Untitled item' })),
      ])
    } catch (e) {
      setFailed(true)
      toast.error(errMsg(e))
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  const assign = async (kind: 'project' | 'object', targetId: string) => {
    try {
      if (kind === 'project') await focusAreasApi.setForProject(targetId, id)
      else await focusAreasApi.setForObject(targetId, id)
      await load()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  if (failed) {
    return (
      <div className="p-4">
        <EmptyState title="Could not load this domain" description="Refresh to try again." />
      </div>
    )
  }
  if (!area) return null
  const inArea = new Set([
    ...(contents?.projects.map((p) => p.id) ?? []),
    ...(contents?.objects.map((o) => o.id) ?? []),
  ])
  const projectChoices = projectOptions.filter((c) => !inArea.has(c.id))
  const objectChoices = objectOptions.filter((c) => !inArea.has(c.id))
  const empty = contents !== null
    && contents.projects.length === 0
    && contents.objects.length === 0

  return (
    <div className="space-y-4 p-4">
      <KnowledgeSectionHeader section="domains" description={area.description ?? undefined} />
      <div>
        <Link to="/knowledge/domains" className="text-xs text-muted-foreground hover:underline">← Domains</Link>
        <h1 className="text-xl font-semibold tracking-tight mt-1">{area.name}</h1>
        {area.description ? (
          <p className="text-sm text-muted-foreground mt-1">{area.description}</p>
        ) : null}
      </div>

      {empty ? (
        <Card className="p-4 space-y-3">
          <EmptyState title="Nothing points here yet" description="Add a project, note or knowledge item below." />
          <Assign label="Add a project…" options={projectChoices} onAssign={(v) => assign('project', v)} />
          <Assign label="Add a note or knowledge item…" options={objectChoices} onAssign={(v) => assign('object', v)} />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4 space-y-2">
            <CardTitle>Projects</CardTitle>
            <Assign label="Add a project…" options={projectChoices} onAssign={(v) => assign('project', v)} />
            {contents?.projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">None.</p>
            ) : contents?.projects.map((project) => (
              <Link key={project.id} to={`/projects/${project.id}`} className="block text-sm hover:underline">
                {project.name}
                <span className="text-xs text-muted-foreground ml-2">{project.status}</span>
              </Link>
            ))}
          </Card>

          <Card className="p-4 space-y-2">
            <CardTitle>Notes &amp; knowledge</CardTitle>
            <Assign label="Add a note or knowledge item…" options={objectChoices} onAssign={(v) => assign('object', v)} />
            {contents?.objects.length === 0 ? (
              <p className="text-xs text-muted-foreground">None.</p>
            ) : contents?.objects.map((object) => (
              <div key={object.id} className="text-sm">
                {object.title ?? <span className="text-muted-foreground">Untitled</span>}
                <span className="text-xs text-muted-foreground ml-2">{object.object_type}</span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  )
}

interface Choice { id: string; label: string }

function Assign({
  label,
  options,
  onAssign,
}: {
  label: string
  options: Choice[]
  onAssign: (id: string) => void | Promise<void>
}) {
  const [value, setValue] = useState('')
  if (options.length === 0) return null
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label={label}
        className="flex-1 h-9 rounded-md border border-input bg-background px-2 text-sm"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      >
        <option value="">{label}</option>
        {options.map((choice) => (
          <option key={choice.id} value={choice.id}>{choice.label}</option>
        ))}
      </select>
      <Button
        size="sm"
        disabled={!value}
        onClick={() => { const chosen = value; setValue(''); void onAssign(chosen) }}
      >
        Add
      </Button>
    </div>
  )
}
