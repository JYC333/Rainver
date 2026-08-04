import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom'
import { projectsApi } from '../../api/client'
import type { Project, ProjectOverview } from '../../types/api'
import { cn } from '../../lib/utils'
import { Badge } from '../../components/ui/badge'
import { spacePath } from '../../core/navigation'
import { REVIEW_ATTENTION_CHANGED_EVENT } from '../../core/reviewAttention'

const groups = [
  {
    label: 'Project',
    items: [
      { label: 'Overview', path: '' },
      { label: 'Rooms', path: 'rooms' },
    ],
  },
  {
    label: 'Explore',
    items: [
      { label: 'Inquiry', path: 'inquiry' },
      { label: 'Research', path: 'research' },
      { label: 'Sources', path: 'sources' },
      { label: 'Files & Code', path: 'files' },
      { label: 'Experiments', path: 'experiments' },
    ],
  },
  {
    label: 'Decide & learn',
    items: [
      { label: 'Decisions', path: 'decisions' },
      { label: 'Learning', path: 'learning' },
      { label: 'Knowledge review', path: 'knowledge-review' },
    ],
  },
  {
    label: 'Execute',
    items: [
      { label: 'Delivery', path: 'delivery' },
      { label: 'Operations', path: 'operations' },
    ],
  },
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

  return (
    <div className="min-h-full lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="border-b bg-muted/20 p-4 lg:border-b-0 lg:border-r">
        <div className="mb-5 px-2">
          <p className="truncate font-semibold">{project?.name ?? 'Project'}</p>
          <p className="text-xs capitalize text-muted-foreground">{project?.primary_mode ?? 'project'} mode</p>
          {overview?.template && <Badge className="mt-2" variant="outline">{overview.template.name} template</Badge>}
        </div>
        <nav className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-1">
          {groups.map(group => (
            <div key={group.label}>
              <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map(item => (
                  <NavLink
                    key={item.path}
                    to={spacePath(spaceId, `/projects/${projectId}${item.path ? `/${item.path}` : ''}`)}
                    end={item.path === ''}
                    className={({ isActive }) => cn(
                      'block rounded-md px-2 py-1.5 text-sm',
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
            </div>
          ))}
        </nav>
        {(overview?.setup_checklist?.length ?? 0) > 0 && (
          <div className="mt-5 border-t pt-4">
            <p className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Setup</p>
            <div className="space-y-1">
              {overview?.setup_checklist?.map(item => (
                <NavLink key={item.id} to={spacePath(spaceId, item.href)} className="flex items-start justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted">
                  <span><span className="block">{item.label}{item.required ? ' *' : ''}</span><span className="text-[11px] text-muted-foreground">{item.detail}</span></span>
                  <Badge variant={item.status === 'ready' ? 'success' : item.required ? 'warning' : 'outline'}>{item.status}</Badge>
                </NavLink>
              ))}
            </div>
          </div>
        )}
        {/* This is the only "what should I do next" surface visible from every
            Area, not just Overview — an Area page in the middle of an async
            workflow (research scan, screening review, …) has nowhere else to
            point the user back to the exact pending action. */}
        {(overview?.attention.length ?? 0) > 0 && (
          <div className="mt-5 border-t pt-4">
            <p className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Needs attention</p>
            <div className="space-y-1">
              {overview?.attention.map(item => (
                <Link key={item.id} to={spacePath(spaceId, item.href)} className="block rounded-md px-2 py-1.5 text-xs hover:bg-muted">
                  <span className="block font-medium">{item.title}</span>
                  <span className="block text-[11px] text-muted-foreground">{item.reason ?? item.summary}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </aside>
      <main className="min-w-0"><Outlet /></main>
    </div>
  )
}
