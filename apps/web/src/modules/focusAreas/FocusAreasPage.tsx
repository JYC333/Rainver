import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { focusAreasApi, knowledgeApi, notesApi, projectsApi } from '../../api/client'
import type { FocusArea, FocusAreaContents, Page } from '../../types/api'
import { SpaceLink as Link } from '../../core/spaceNav'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import KnowledgeSectionHeader from '../knowledge/KnowledgeSectionHeader'
import { EmptyState } from '../../components/ui/empty-state'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { errMsg } from '../../lib/utils'
import { useAppTranslation } from '../../i18n'

/**
 * A focus area aggregates what already exists and grants nothing. Everything
 * listed here is content the viewer could already reach; classifying never
 * widens access (ADR 0015).
 */
export default function FocusAreaList() {
  const { t } = useAppTranslation()
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
          <label className="text-xs text-muted-foreground" htmlFor="focus-area-name">{t('core_ui.focus_areas.new_domain')}</label>
          <Input
            id="focus-area-name"
            value={name}
            placeholder={t('core_ui.focus_areas.name_placeholder')}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void create() }}
          />
        </div>
        <Button onClick={() => void create()} disabled={creating || !name.trim()}>
          {creating ? t('core_ui.focus_areas.creating') : t('core_ui.focus_areas.create')}
        </Button>
      </Card>

      {loading ? null : areas.length === 0 ? (
        <EmptyState title={t('core_ui.focus_areas.empty_title')} description={t('core_ui.focus_areas.empty_description')} />
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

// The picker sources keep their own offset pages; these sizes match what the
// pickers loaded before they could continue.
const PROJECT_CHOICE_PAGE = 200
const OBJECT_CHOICE_PAGE = 100

interface Choice { id: string; label: string; focusAreaId: string | null }
/** `next` is the offset of the source's next page, or `null` once it is exhausted. */
interface ChoiceList { choices: Choice[]; next: number | null }
type ContentsList = 'projects' | 'objects'

const NO_CHOICES: ChoiceList = { choices: [], next: null }

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((row) => row.id))
  return [...current, ...incoming.filter((row) => !seen.has(row.id))]
}

function appendChoices<T>(
  list: ChoiceList,
  page: Page<T>,
  offset: number,
  toChoice: (item: T) => Choice,
): ChoiceList {
  const end = offset + page.items.length
  return {
    choices: mergeById(list.choices, page.items.map(toChoice)),
    next: page.items.length > 0 && end < page.total ? end : null,
  }
}

export function FocusAreaDetail() {
  const { t } = useAppTranslation()
  const { focusAreaId: id = '' } = useParams()
  const [area, setArea] = useState<FocusArea | null>(null)
  const [contents, setContents] = useState<FocusAreaContents | null>(null)
  const [projectChoices, setProjectChoices] = useState<ChoiceList>(NO_CHOICES)
  const [noteChoices, setNoteChoices] = useState<ChoiceList>(NO_CHOICES)
  const [itemChoices, setItemChoices] = useState<ChoiceList>(NO_CHOICES)
  const [loadingContents, setLoadingContents] = useState<ContentsList | null>(null)
  const [loadingChoices, setLoadingChoices] = useState<'project' | 'object' | null>(null)
  const [failed, setFailed] = useState(false)
  // A response for an earlier load, or for another Domain, must not land here.
  const generation = useRef(0)

  const projectChoice = useCallback((p: { id: string; name: string; focus_area_id?: string | null }): Choice => (
    { id: p.id, label: p.name, focusAreaId: p.focus_area_id ?? null }
  ), [])
  const noteChoice = useCallback((n: { id: string; title: string | null; focus_area_id?: string | null }): Choice => (
    { id: n.id, label: n.title || t('core_ui.focus_areas.untitled_note'), focusAreaId: n.focus_area_id ?? null }
  ), [t])
  const itemChoice = useCallback((k: { id: string; title: string | null; focus_area_id?: string | null }): Choice => (
    { id: k.id, label: k.title || t('core_ui.focus_areas.untitled_item'), focusAreaId: k.focus_area_id ?? null }
  ), [t])

  const load = useCallback(async () => {
    const current = ++generation.current
    try {
      // Notes and Knowledge items are `space_objects` subtypes keyed on the
      // object id, so their list ids are exactly what the classification
      // endpoint expects.
      const [a, c, projects, notes, items] = await Promise.all([
        focusAreasApi.get(id),
        focusAreasApi.contents(id),
        projectsApi.list({ status: 'active', limit: PROJECT_CHOICE_PAGE, offset: 0 }),
        notesApi.list({ limit: OBJECT_CHOICE_PAGE, offset: 0 }),
        knowledgeApi.list({ limit: OBJECT_CHOICE_PAGE, offset: 0 }),
      ])
      if (current !== generation.current) return
      setArea(a)
      setContents(c)
      setProjectChoices(appendChoices(NO_CHOICES, projects, 0, projectChoice))
      setNoteChoices(appendChoices(NO_CHOICES, notes, 0, noteChoice))
      setItemChoices(appendChoices(NO_CHOICES, items, 0, itemChoice))
    } catch (e) {
      if (current !== generation.current) return
      setFailed(true)
      toast.error(errMsg(e))
    }
  }, [id, projectChoice, noteChoice, itemChoice])

  useEffect(() => { void load() }, [load])

  const loadMoreContents = async (list: ContentsList) => {
    const cursor = list === 'projects' ? contents?.projects_next_cursor : contents?.objects_next_cursor
    if (!cursor) return
    const current = generation.current
    setLoadingContents(list)
    try {
      // Only the continued list is taken from the response; the other list
      // in it is a first page the viewer already has.
      const next = await focusAreasApi.contents(id, list === 'projects' ? { projects_cursor: cursor } : { objects_cursor: cursor })
      if (current !== generation.current) return
      setContents((prev) => {
        if (!prev) return prev
        return list === 'projects'
          ? { ...prev, projects: mergeById(prev.projects, next.projects), projects_next_cursor: next.projects_next_cursor }
          : { ...prev, objects: mergeById(prev.objects, next.objects), objects_next_cursor: next.objects_next_cursor }
      })
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoadingContents(null)
    }
  }

  const loadMoreChoices = async (kind: 'project' | 'object') => {
    const current = generation.current
    setLoadingChoices(kind)
    try {
      if (kind === 'project') {
        const offset = projectChoices.next
        if (offset === null) return
        const page = await projectsApi.list({ status: 'active', limit: PROJECT_CHOICE_PAGE, offset })
        if (current !== generation.current) return
        setProjectChoices((prev) => appendChoices(prev, page, offset, projectChoice))
        return
      }
      const noteOffset = noteChoices.next
      const itemOffset = itemChoices.next
      const [notes, items] = await Promise.all([
        noteOffset === null ? null : notesApi.list({ limit: OBJECT_CHOICE_PAGE, offset: noteOffset }),
        itemOffset === null ? null : knowledgeApi.list({ limit: OBJECT_CHOICE_PAGE, offset: itemOffset }),
      ])
      if (current !== generation.current) return
      if (notes && noteOffset !== null) setNoteChoices((prev) => appendChoices(prev, notes, noteOffset, noteChoice))
      if (items && itemOffset !== null) setItemChoices((prev) => appendChoices(prev, items, itemOffset, itemChoice))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setLoadingChoices(null)
    }
  }

  const assign = async (kind: 'project' | 'object', targetId: string) => {
    try {
      if (kind === 'project') await focusAreasApi.setForProject(targetId, id)
      else await focusAreasApi.setForObject(targetId, id)
      // Keep the pages already loaded into the pickers; only the chosen entry
      // changed. The server stays the authority on whether the write was allowed.
      const classify = (list: ChoiceList): ChoiceList => ({
        ...list,
        choices: list.choices.map((c) => (c.id === targetId ? { ...c, focusAreaId: id } : c)),
      })
      if (kind === 'project') setProjectChoices(classify)
      else {
        setNoteChoices(classify)
        setItemChoices(classify)
      }
      const current = ++generation.current
      const next = await focusAreasApi.contents(id)
      if (current === generation.current) setContents(next)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  if (failed) {
    return (
      <div className="p-4">
        <EmptyState title={t('core_ui.focus_areas.load_failed_title')} description={t('core_ui.focus_areas.load_failed_description')} />
      </div>
    )
  }
  if (!area) return null
  // Filter on each choice's own classification, not on the loaded contents
  // pages, so an item already filed here stays out of the picker however many
  // contents pages are loaded.
  const unfiled = (c: Choice) => c.focusAreaId !== id
  const projectPicker = {
    options: projectChoices.choices.filter(unfiled),
    hasMore: projectChoices.next !== null,
    loadingMore: loadingChoices === 'project',
    moreLabel: t('core_ui.focus_areas.more_project_choices'),
    onLoadMore: () => loadMoreChoices('project'),
  }
  const objectPicker = {
    options: [...noteChoices.choices, ...itemChoices.choices].filter(unfiled),
    hasMore: noteChoices.next !== null || itemChoices.next !== null,
    loadingMore: loadingChoices === 'object',
    moreLabel: t('core_ui.focus_areas.more_object_choices'),
    onLoadMore: () => loadMoreChoices('object'),
  }
  const empty = contents !== null
    && contents.projects.length === 0
    && contents.objects.length === 0

  return (
    <div className="space-y-4 p-4">
      <KnowledgeSectionHeader section="domains" description={area.description ?? undefined} />
      <div>
        <Link to="/knowledge/domains" className="text-xs text-muted-foreground hover:underline">{t('core_ui.focus_areas.back')}</Link>
        <h1 className="text-xl font-semibold tracking-tight mt-1">{area.name}</h1>
        {area.description ? (
          <p className="text-sm text-muted-foreground mt-1">{area.description}</p>
        ) : null}
      </div>

      {empty ? (
        <Card className="p-4 space-y-3">
          <EmptyState title={t('core_ui.focus_areas.nothing_title')} description={t('core_ui.focus_areas.nothing_description')} />
          <Assign label={t('core_ui.focus_areas.add_project')} {...projectPicker} onAssign={(v) => assign('project', v)} />
          <Assign label={t('core_ui.focus_areas.add_object')} {...objectPicker} onAssign={(v) => assign('object', v)} />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4 space-y-2">
            <CardTitle>{t('core_ui.focus_areas.projects')}</CardTitle>
            <Assign label={t('core_ui.focus_areas.add_project')} {...projectPicker} onAssign={(v) => assign('project', v)} />
            {contents?.projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('core_ui.focus_areas.none')}</p>
            ) : contents?.projects.map((project) => (
              <Link key={project.id} to={`/projects/${project.id}`} className="block text-sm hover:underline">
                {project.name}
                <span className="text-xs text-muted-foreground ml-2">{project.status}</span>
              </Link>
            ))}
            <LoadMore
              show={Boolean(contents?.projects_next_cursor)}
              loading={loadingContents === 'projects'}
              ariaLabel={t('core_ui.focus_areas.load_more_projects')}
              onClick={() => loadMoreContents('projects')}
            />
          </Card>

          <Card className="p-4 space-y-2">
            <CardTitle>{t('core_ui.focus_areas.notes_knowledge')}</CardTitle>
            <Assign label={t('core_ui.focus_areas.add_object')} {...objectPicker} onAssign={(v) => assign('object', v)} />
            {contents?.objects.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('core_ui.focus_areas.none')}</p>
            ) : contents?.objects.map((object) => (
              <div key={object.id} className="text-sm">
                {object.title ?? <span className="text-muted-foreground">{t('core_ui.focus_areas.untitled')}</span>}
                <span className="text-xs text-muted-foreground ml-2">{object.object_type}</span>
              </div>
            ))}
            <LoadMore
              show={Boolean(contents?.objects_next_cursor)}
              loading={loadingContents === 'objects'}
              ariaLabel={t('core_ui.focus_areas.load_more_objects')}
              onClick={() => loadMoreContents('objects')}
            />
          </Card>
        </div>
      )}
    </div>
  )
}

function LoadMore({
  show,
  loading,
  ariaLabel,
  onClick,
}: {
  show: boolean
  loading: boolean
  ariaLabel: string
  onClick: () => void | Promise<void>
}) {
  const { t } = useAppTranslation()
  if (!show) return null
  return (
    <Button size="sm" variant="outline" disabled={loading} aria-label={ariaLabel} onClick={() => void onClick()}>
      {t('core_ui.focus_areas.load_more')}
    </Button>
  )
}

function Assign({
  label,
  options,
  hasMore,
  loadingMore,
  moreLabel,
  onLoadMore,
  onAssign,
}: {
  label: string
  options: Choice[]
  hasMore: boolean
  loadingMore: boolean
  moreLabel: string
  onLoadMore: () => void | Promise<void>
  onAssign: (id: string) => void | Promise<void>
}) {
  const [value, setValue] = useState('')
  const { t } = useAppTranslation()
  if (options.length === 0 && !hasMore) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.length > 0 ? (
        <>
          <Select
            className="min-w-0 flex-1"
            ariaLabel={label}
            value={value}
            onChange={setValue}
            options={[
              { value: '', label, disabled: true },
              ...options.map((choice) => ({ value: choice.id, label: choice.label })),
            ]}
          />
          <Button
            size="sm"
            disabled={!value}
            onClick={() => { const chosen = value; setValue(''); void onAssign(chosen) }}
          >
            {t('core_ui.focus_areas.add')}
          </Button>
        </>
      ) : null}
      {hasMore ? (
        <Button size="sm" variant="ghost" disabled={loadingMore} aria-label={moreLabel} onClick={() => void onLoadMore()}>
          {t('core_ui.focus_areas.more_choices')}
        </Button>
      ) : null}
    </div>
  )
}
