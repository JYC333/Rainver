import { useEffect, useState } from 'react'
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

/**
 * The three things a person switches between while running a Project.
 *
 * Everything else stays reachable under Areas — this is a promotion, not a
 * removal, and every route is unchanged so existing links keep working. A flat
 * list of fifteen made choosing a module the first step of understanding a
 * Project, which is backwards: the question on arriving is what is going on,
 * not which subsystem to open.
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
 * Six, flat. Thirteen entries in four groups were six research surfaces that
 * had grown up separately and pointed at each other with banners, plus three
 * doors to one source pipeline. Each fold keeps the route: Raw material and
 * Digest are tabs of Sources; Knowledge review and Experiments are views of
 * Inquiry; every Room's conversations are one list under Conversations, and
 * the Rooms page (roster, invitations) is reached from there. Group labels
 * went with the groups — six is one glance.
 */
const areas = [
  { label: 'Notes', path: 'notes' },
  { label: 'Inquiry', path: 'inquiry' },
  { label: 'Research', path: 'research' },
  { label: 'Sources', path: 'sources' },
  { label: 'Files & Code', path: 'files' },
  { label: 'Decisions', path: 'decisions' },
] as const

export default function ProjectAreaLayout() {
  const { projectId = '', spaceId = '' } = useParams()
  const { pathname } = useLocation()
  const [project, setProject] = useState<Project | null>(null)
  const [overview, setOverview] = useState<ProjectOverview | null>(null)

  useEffect(() => {
    // This layout stays mounted across every Area sub-route (Outlet swaps
    // only the child) — resolving an attention item on one Area and
    // navigating to another must refresh the sidebar's attention badge, not
    // just wait for the projectId itself to change.
    Promise.all([projectsApi.get(projectId), projectsApi.getOverview(projectId)])
      .then(([nextProject, nextOverview]) => {
        setProject(nextProject)
        setOverview(nextOverview)
      })
      .catch(() => {
        setProject(null)
        setOverview(null)
      })
  }, [projectId, pathname])

  useEffect(() => {
    let active = true
    const refreshOverview = () => {
      void projectsApi.getOverview(projectId)
        .then(nextOverview => {
          if (active) setOverview(nextOverview)
        })
        .catch(() => {
          // Attention is advisory. Keep the last known overview if this
          // event-driven refresh encounters a transient request failure.
        })
    }
    window.addEventListener(REVIEW_ATTENTION_CHANGED_EVENT, refreshOverview)
    return () => {
      active = false
      window.removeEventListener(REVIEW_ATTENTION_CHANGED_EVENT, refreshOverview)
    }
  }, [projectId])

  // Capture is one affordance in the app shell, not one per Area and not a
  // second one per Project: a thought that arrives while doing an experiment
  // must not require navigating to notes first (U2). This declares the Project
  // the shell's composer may offer as a destination; Areas that know what they
  // are currently about declare that object separately.
  // Open by default: an Area a person cannot see is one they will not
  // remember exists, and the dropdown exists to shorten the list, not to hide
  // it. Their choice is remembered per browser.
  const [areasOpen, setAreasOpen] = useState(() => {
    try { return localStorage.getItem('project.areas.open') !== 'false' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('project.areas.open', String(areasOpen)) } catch { /* private mode */ }
  }, [areasOpen])

  useDeclareProjectCaptureProject(projectId)

  return (
    <div className="min-h-full lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="border-b bg-muted/20 p-4 lg:border-b-0 lg:border-r">
        <div className="mb-5 px-2">
          <p className="truncate font-semibold">{project?.name ?? 'Project'}</p>
        </div>
        <nav className="space-y-4">
          <div className="space-y-0.5">
            {primary.map(item => (
              <NavLink
                key={item.path}
                to={spacePath(spaceId, `/projects/${projectId}${item.path ? `/${item.path}` : ''}`)}
                end={item.path === ''}
                className={({ isActive }) => cn(
                  'block rounded-md px-2 py-1.5 text-sm font-medium',
                  isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  {item.label}
                  {item.path === '' && (overview?.attention.length ?? 0) > 0 && <Badge variant="destructive">{overview?.attention.length}</Badge>}
                </span>
              </NavLink>
            ))}
          </div>

          <div className="border-t pt-3">
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
                    to={spacePath(spaceId, `/projects/${projectId}/${item.path}`)}
                    className={({ isActive }) => cn(
                      'block rounded-md px-2 py-1.5 text-sm',
                      isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                    )}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        </nav>
        {/* This is the only "what should I do next" surface visible from every
            Area, not just Overview — an Area page in the middle of an async
            workflow (research scan, screening review, …) has nowhere else to
            point the user back to the exact pending action. */}
        {(overview?.attention.length ?? 0) > 0 && (
          <div className="mt-5 border-t pt-4">
            <p className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Needs attention</p>
            <div className="space-y-1">
              {overview?.attention.map(item => (
                <Link key={item.id} to={spacePath(spaceId, inProjectHref(projectId, item.href))} className="block rounded-md px-2 py-1.5 text-xs hover:bg-muted">
                  <span className="block font-medium">{item.title}</span>
                  <span className="block text-[11px] text-muted-foreground">{item.reason ?? item.summary}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </aside>
      {/* The sidecar sits beside every Area, so discussing what you are looking
          at never means leaving it. It renders the Room's own conversation, not
          a private one. */}
      <div className="flex min-w-0">
        <main className="min-w-0 flex-1"><Outlet /></main>
        <ProjectChatSidecar />
      </div>
    </div>
  )
}
