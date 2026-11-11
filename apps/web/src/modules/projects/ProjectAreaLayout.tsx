import {ProjectPluginNavigation} from '../plugins/ProjectPluginNavigation'
import { isNotFoundError } from '../../lib/utils'
import ProjectDetailPage from './ProjectDetailPage'
import {useSpace} from '../../contexts/SpaceContext'
import {registerInMemoryResidue,sessionEpoch} from '../../lib/sessionResidue'
import { useCallback, useEffect, useRef, useState } from 'react'
import {useProjectLiveRefresh} from '../../hooks/useProjectLiveRefresh'
import { useAppTranslation } from '../../i18n'
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom'
import { projectsApi } from '../../api/client'
import type { Project, ProjectOverview } from '../../types/api'
import { cn } from '../../lib/utils'
import { Badge } from '../../components/ui/badge'
import { spacePath } from '../../core/navigation'
import ProjectChatSidecar from './sidecar/ProjectChatSidecar'
import { REVIEW_ATTENTION_CHANGED_EVENT } from '../../core/reviewAttention'
import { useDeclareProjectCaptureProject } from '../../contexts/CaptureContext'
import { inProjectHref } from './taskHref'
import { ProjectFolderConversationProvider } from './ProjectFolderConversationContext'

/**
 * The three things a person switches between while running a Project.
 *
 * Everything else stays reachable under Areas. Routes stay put, so existing
 * links keep working. The question on arriving is what is going on.
 * Do not open with a flat list of every module.
 */
const primary = [
  { label: 'Pulse', path: '' },
  { label: 'Board', path: 'board' },
  { label: 'Updates', path: 'updates' },
  // A Project is pushed forward through conversation, so all of it is a
  // first-level destination — not a Room picker two clicks down.
  { label: 'Conversations', path: 'conversations' },
] as const

/**
 * Five, flat. Research is reached inside Inquiry. Reading/material and secondary collection views share Sources; Knowledge review
 * and Experiments are views of Inquiry; every Room's conversations are one
 * list under Conversations, and the Rooms page (roster, invitations) is
 * reached from there. Do not put them back into labeled groups, and do not
 * give each fold its own sidebar entry.
 */
const areas = [
  { label: 'Notes', path: 'notes' },
  { label: 'Inquiry', path: 'inquiry' },
  { label: 'Sources', path: 'sources' },
  { label: 'Files & Code', path: 'files' },
  { label: 'Decisions', path: 'decisions' },
] as const

export default function ProjectAreaLayout() {
  const { t,locale } = useAppTranslation()
  const { projectId = '', spaceId = '' } = useParams()
  const { pathname } = useLocation()
  const boardArea = pathname.replace(/\/$/, '').endsWith(`/projects/${projectId}/board`)
  const {userId}=useSpace()
  const scope=`${spaceId}:${userId}:${projectId}`
  const [loadedScope,setLoadedScope]=useState('')
  const [cleared,setCleared]=useState(0)
  useEffect(()=>registerInMemoryResidue(()=>{setLoadedScope('');setProject(null);setOverview(null);setCleared(n=>n+1)}),[])
  const [project, setProject] = useState<Project | null>(null)
  const [overview, setOverview] = useState<ProjectOverview | null>(null)

  const overviewVersion=useRef(0)
  useEffect(() => {
    // This layout stays mounted across every Area sub-route (Outlet swaps
    // only the child) — resolving an attention item on one Area and
    // navigating to another must refresh the sidebar's attention badge, not
    // just wait for the projectId itself to change.
    let live=true;const epoch=sessionEpoch(),version=++overviewVersion.current
    projectsApi.get(projectId).then(async metadata => {
      if (metadata.current_user_can_read === false) return [metadata, null] as const
      try { return [metadata, await projectsApi.getOverview(projectId)] as const }
      catch (error) {
        if (isNotFoundError(error) || (error instanceof Error && 'status' in error && [401, 403].includes(Number(error.status)))) return [{ ...metadata, current_user_can_read: false }, null] as const
        throw error
      }
    })
      .then(([nextProject, nextOverview]) => {
        if(!live||epoch!==sessionEpoch())return
        setLoadedScope(scope)
        setProject(nextProject)
        if(version===overviewVersion.current)setOverview(nextOverview)
      })
      .catch(error => {
        if(!live||epoch!==sessionEpoch())return
        setLoadedScope(scope);setProject(null);setOverview(null)
      })
    return()=>{live=false;overviewVersion.current+=1}
  }, [projectId, pathname,spaceId,userId,cleared])

  const refreshOverview=useCallback(async()=>{
    if(loadedScope!==scope||project?.current_user_can_read===false)return
    const version=++overviewVersion.current,epoch=sessionEpoch()
    try{
      const next=await projectsApi.getOverview(projectId)
      if(version===overviewVersion.current&&epoch===sessionEpoch())setOverview(next)
    }catch(error){
      if(version===overviewVersion.current&&epoch===sessionEpoch()&&[401,403,404].includes((error as {status?:number})?.status??0)){
        setOverview(null);setProject(current=>current?{...current,current_user_can_read:false}:current)
      }
    }
  },[projectId,scope,loadedScope,project?.current_user_can_read])
  useEffect(()=>{
    const refresh=()=>{void refreshOverview()}
    window.addEventListener(REVIEW_ATTENTION_CHANGED_EVENT,refresh)
    return()=>window.removeEventListener(REVIEW_ATTENTION_CHANGED_EVENT,refresh)
  },[refreshOverview])
  // The sidebar remains mounted on every Area. It must observe Agent-created,
  // updated and closed Tasks even when the person never changes the route.
  useProjectLiveRefresh(projectId,refreshOverview,loadedScope===scope&&project?.current_user_can_read!==false)

  // Capture is one affordance in the app shell, not one per Area and not a
  // second one per Project: a thought that arrives while doing an experiment
  // must not require navigating to notes first. This declares the Project
  // the shell's composer may offer as a destination; Areas that know what they
  // are currently about declare that object separately.
  // Open by default: an Area a person cannot see is one they will not
  // remember exists. The dropdown shortens the list. Do not use it to hide
  // an Area. Their choice is remembered per browser.
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [areasOpen, setAreasOpen] = useState(() => {
    try { return localStorage.getItem('project.areas.open') !== 'false' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('project.areas.open', String(areasOpen)) } catch { /* private mode */ }
  }, [areasOpen])

  useDeclareProjectCaptureProject(loadedScope === scope && project?.current_user_can_read !== false ? projectId : null)

  const visibleProject=loadedScope===scope?project:null,visibleOverview=loadedScope===scope?overview:null
  if (loadedScope !== scope) return <div className="p-6 text-sm text-muted-foreground">{t('management_ui.project_members.loading_project')}</div>
  if (!visibleProject || visibleProject.current_user_can_read === false) return <ProjectDetailPage key={scope} onAccessChanged={() => setCleared(n => n + 1)} />
  return (
    <ProjectFolderConversationProvider key={projectId} projectId={projectId}>
      <div className={cn('lg:grid lg:grid-cols-[220px_minmax(0,1fr)]',boardArea?'flex h-full min-h-0 flex-col overflow-hidden':'min-h-full lg:h-full lg:min-h-0 lg:overflow-hidden')}>
      <aside data-project-navigation data-shell-chrome className={cn('border-b border-border bg-muted/20 p-4 lg:min-h-0 lg:overflow-y-auto lg:overscroll-y-contain lg:border-b-0 lg:border-r',boardArea&&'max-h-[40dvh] shrink-0 overflow-y-auto overscroll-y-contain lg:max-h-none')}>
        <div className="flex min-w-0 items-center justify-between gap-3 px-2 lg:mb-5">
          <p className="min-w-0 break-words font-semibold">{visibleProject?.name ?? 'Project'}</p>
          <button type="button" className="shrink-0 rounded border border-border px-3 py-1.5 text-xs lg:hidden" aria-expanded={navigationOpen} aria-controls="project-navigation-items" onClick={()=>setNavigationOpen(open=>!open)}>{t('monitoring.projectNavigation')} {navigationOpen ? '▴' : '▾'}</button>
        </div>
        <div id="project-navigation-items" className={cn('mt-4 lg:mt-0 lg:block', !navigationOpen && 'hidden')}>
        <nav aria-label={t('plugin_ui.project_navigation')} className="space-y-4">
          <div className="space-y-0.5">
            {primary.map(item => (
              <NavLink
                key={item.path}
                onClick={()=>setNavigationOpen(false)}
                to={spacePath(spaceId, `/projects/${projectId}${item.path ? `/${item.path}` : ''}`)}
                end={item.path === ''}
                className={({ isActive }) => cn(
                  'block rounded-md px-2 py-1.5 text-sm font-medium',
                  isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  {item.label}
                  {item.path === '' && (visibleOverview?.attention.length ?? 0) > 0 && <Badge variant="destructive">{visibleOverview?.attention.length}</Badge>}
                </span>
              </NavLink>
            ))}
          </div>

          <div className="border-t border-border pt-3">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-muted"
              onClick={() => setAreasOpen(open => !open)}
              aria-expanded={areasOpen}
            >
              Areas
              <span aria-hidden>{areasOpen ? '▾' : '▸'}</span>
            </button>
            {areasOpen && (
              <div className="mt-1 space-y-0.5">
                {areas.map(item => (
                  <NavLink
                    key={item.path}
                    onClick={()=>setNavigationOpen(false)}
                    to={spacePath(spaceId, `/projects/${projectId}/${item.path}`)}
                    className={({ isActive }) => cn(
                      'block rounded-md px-2 py-1.5 text-sm',
                      isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                    )}
                  >
                    {item.path === 'inquiry' ? (locale==='zh-CN'?'问题推进':'Problems') : item.path === 'sources' ? t('nav.library') : item.label}
                  </NavLink>
                ))}
                <ProjectPluginNavigation onNavigate={()=>setNavigationOpen(false)}/>
              </div>
            )}
          </div>
        </nav>
        {/* This is the only "what should I do next" surface visible from every
            Area, not just Overview — an Area page in the middle of an async
            workflow (research scan, screening review, …) has nowhere else to
            point the user back to the exact pending action. */}
        {(visibleOverview?.attention.length ?? 0) > 0 && (
          <div className="mt-5 border-t border-border pt-4">
            <p className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Needs attention</p>
            <div className="space-y-1">
              {visibleOverview?.attention.map(item => {
                const href = inProjectHref(projectId, item.href)
                const className = 'block rounded-md px-2 py-1.5 text-xs hover:bg-muted'
                const body = (
                  <>
                    <span className="block font-medium">{item.title}</span>
                    <span className="block text-[11px] text-muted-foreground">{item.reason ?? item.summary}</span>
                  </>
                )
                return href
                  ? <Link key={item.id} to={spacePath(spaceId, href)} className={className}>{body}</Link>
                  : <div key={item.id} className={className}>{body}</div>
              })}
            </div>
          </div>
        )}
        </div>
      </aside>
      {/* The sidecar sits beside every Area, so discussing what you are looking
          at never means leaving it. It renders the Room's own conversation, not
          a private one. */}
      <div className={cn('flex min-w-0',boardArea?'min-h-0 flex-1 overflow-hidden':'lg:min-h-0 lg:overflow-hidden')}>
        <main data-project-area-content className={cn('min-w-0 flex-1',boardArea?'min-h-0 overflow-hidden':'lg:min-h-0 lg:overflow-y-auto lg:overscroll-y-contain')}><Outlet context={{ onAccessChanged: () => setCleared(n => n + 1) }} /></main>
        <div data-shell-chrome className="contents"><ProjectChatSidecar /></div>
      </div>
      </div>
    </ProjectFolderConversationProvider>
  )
}
