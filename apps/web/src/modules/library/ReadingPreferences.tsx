import { useEffect, useState } from 'react'
import { informationDigestsApi, projectsApi } from '../../api/client'
import { useAppTranslation } from '../../i18n'
import { SpaceLink } from '../../core/spaceNav'
import { Button } from '../../components/ui/button'
import { errMsg } from '../../lib/utils'

export function ProjectReadingPreference({ spaceId, projectId, onChanged, showHint = true }: { spaceId: string; projectId: string; onChanged?: () => void; showHint?: boolean }) {
  const { t } = useAppTranslation()
  const [value, setValue] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setValue(null); setError(null); setBusy(false)
    void informationDigestsApi.readingPreference(spaceId, projectId).then(next => { if (active) setValue(next.show_in_my_reading) }).catch(e => { if (active) setError(e) })
    return () => { active = false }
  }, [spaceId, projectId, attempt])
  // Parent scopes this component by Space/Project, so in-flight mutations cannot land elsewhere.
  return <div className="space-y-2 rounded-lg border border-border p-4">
    <label className="flex items-start gap-3 text-sm font-medium"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={value ?? false} disabled={value === null || busy} onChange={async event => {
      const wanted = event.target.checked
      setBusy(true); setError(null)
      try { const next = await informationDigestsApi.setReadingPreference(spaceId, projectId, wanted); setValue(next.show_in_my_reading); onChanged?.() }
      catch (e) { setError(e) } finally { setBusy(false) }
    }} />{t('reading.includeProject')}</label>
    {showHint && <p className="text-xs text-muted-foreground">{t('reading.preferenceHint')}</p>}
    {error != null && <div role="alert" className="text-sm"><p>{errMsg(error)}</p><Button size="sm" variant="ghost" onClick={() => setAttempt(n => n + 1)}>{t('reading.retry')}</Button></div>}
  </div>
}

export function ReadingPreferences({ spaceId, onChanged }: { spaceId: string; onChanged: () => void }) {
  const { t } = useAppTranslation()
  const [projects, setProjects] = useState<Array<{ id: string; name: string }> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setProjects(null); setError(null)
    void projectsApi.list({ status: 'active', limit: 200 }).then(next => { if (active) setProjects(next.items) }).catch(e => { if (active) setError(e) })
    return () => { active = false }
  }, [spaceId, attempt])
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t('reading.preferenceHint')}</p>
    {error != null && <div role="alert"><p>{errMsg(error)}</p><Button onClick={() => setAttempt(n => n + 1)}>{t('reading.retry')}</Button></div>}
    {projects?.map(project => <section key={project.id} className="space-y-2"><SpaceLink className="font-medium hover:underline" to={`/projects/${project.id}/sources`}>{project.name}</SpaceLink><ProjectReadingPreference key={`${spaceId}:${project.id}`} spaceId={spaceId} projectId={project.id} onChanged={onChanged} showHint={false} /></section>)}
    {projects?.length === 0 && <SpaceLink className="underline" to="/projects">{t('reading.findProjects')}</SpaceLink>}
    {projects && projects.length >= 200 && <SpaceLink className="underline" to="/projects">{t('reading.moreProjects')}</SpaceLink>}
  </div>
}
