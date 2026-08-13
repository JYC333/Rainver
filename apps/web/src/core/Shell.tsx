import { useState, useEffect, useRef, useCallback } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Sun, Moon, LogOut, Menu, Globe } from 'lucide-react'
import { Toaster } from 'sonner'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { useSpace } from '../contexts/SpaceContext'
import { SpaceSwitcher } from '../components/SpaceSwitcher'
import { UserAvatar } from '../components/UserAvatar'
import { GlobalRail, type PluginNavItem } from '../components/shell/GlobalRail'
import { SceneSidebar, SceneTabs } from '../components/shell/SceneSidebar'
import { MobileTabBar } from '../components/shell/MobileTabBar'
import { FloatingQuickCapture } from '../components/FloatingQuickCapture'
import { ProjectCaptureTargetProvider } from '../contexts/CaptureContext'
import { routeScopeForPath, sceneForPath, stripSpacePrefix } from './navigation'
import { moduleForPath } from '../modules/registry'
import { useEffectiveModules } from '../modules/plugins/useEffectivePlugins'
import { proposalsApi } from '../api/client'
import { REVIEW_ATTENTION_CHANGED_EVENT } from './reviewAttention'

const RAIL_KEY = 'agent-space:rail-expanded'
const SCENE_COLLAPSE_KEY = 'agent-space:scene-collapsed'

function readBool(key: string, fallback: boolean): boolean {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === 'true' } catch { return fallback }
}
function readMap(key: string): Record<string, boolean> {
  try { const v = JSON.parse(localStorage.getItem(key) ?? '{}'); return typeof v === 'object' && v ? v : {} } catch { return {} }
}

/* ── Theme toggle ──────────────────────────────────────────────────────────── */
function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  return (
    <button
      onClick={toggleTheme}
      className="flex items-center justify-center w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
    </button>
  )
}

/* ── User menu ─────────────────────────────────────────────────────────────── */
function UserMenu() {
  const { currentUser, logout } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (!currentUser) {
    return (
      <button
        onClick={() => navigate('/login')}
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        Sign in
      </button>
    )
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border hover:opacity-90 transition-opacity"
        title={currentUser.display_name}
      >
        <UserAvatar avatarUrl={currentUser.avatar_url} displayName={currentUser.display_name} email={currentUser.email} />
      </button>

      {open && (
        <div className="absolute top-[calc(100%+6px)] right-0 w-56 bg-card border border-border rounded-lg shadow-lg z-50 py-1 overflow-hidden">
          <div className="px-3 py-2 border-b border-border">
            <div className="text-[13px] font-medium text-foreground truncate">{currentUser.display_name}</div>
            <div className="text-[11px] text-muted-foreground truncate">{currentUser.email}</div>
          </div>
          <button
            onClick={() => { setOpen(false); logout() }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <LogOut size={13} />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

/* ── Scene header (title + collapsed-sidebar expand handle + space context) ─── */
function SceneHeader({
  title, isHome, sidebarCollapsed, hasSidebar, onExpandSidebar,
}: {
  title: string
  isHome: boolean
  sidebarCollapsed: boolean
  hasSidebar: boolean
  onExpandSidebar: () => void
}) {
  return (
    <header className="shrink-0 flex items-center gap-2.5 h-14 px-4 border-b border-border bg-card">
      {hasSidebar && sidebarCollapsed ? (
        <button
          type="button"
          onClick={onExpandSidebar}
          className="hidden md:flex items-center gap-2 h-8 px-2.5 rounded-md border border-border text-[13px] font-semibold text-foreground hover:bg-accent transition-colors"
          title="Show sidebar"
          aria-label="Show sidebar"
        >
          <Menu className="size-4" /> {title}
        </button>
      ) : (
        <h1 className="text-[15px] font-semibold tracking-tight text-foreground truncate">{title}</h1>
      )}

      {isHome && (
        <span className="hidden sm:inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border text-[11px] text-muted-foreground">
          <Globe className="size-3" /> Showing: All spaces
        </span>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-1.5">
        <SpaceSwitcher />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  )
}

/* ── Shell ─────────────────────────────────────────────────────────────────── */
export default function Shell() {
  const { theme } = useTheme()
  const { currentUser } = useAuth()
  const { activeSpaceId, preferredSpaceId, spaces } = useSpace()
  const location = useLocation()
  const { modules: effectiveModules, refresh: refreshPlugins } = useEffectiveModules()

  // Re-fetch plugin state whenever PluginsPage enables or disables a module.
  useEffect(() => {
    const handler = () => refreshPlugins()
    window.addEventListener('agent-space:plugin-state-changed', handler)
    return () => window.removeEventListener('agent-space:plugin-state-changed', handler)
  }, [refreshPlugins])

  const scope = routeScopeForPath(location.pathname)
  const scene = scope === 'home' ? null : sceneForPath(location.pathname)
  const logicalPath = stripSpacePrefix(location.pathname)
  const isHome = logicalPath === '/home' || logicalPath.startsWith('/home/') || logicalPath === '/'

  const [railExpanded, setRailExpanded] = useState(() => readBool(RAIL_KEY, false))
  const [collapsedScenes, setCollapsedScenes] = useState<Record<string, boolean>>(() => readMap(SCENE_COLLAPSE_KEY))
  const reviewSpaceId = activeSpaceId ?? preferredSpaceId
  const [pendingReviewCount, setPendingReviewCount] = useState(0)

  const refreshReviewAttention = useCallback(async () => {
    if (!currentUser?.id || !reviewSpaceId) {
      setPendingReviewCount(0)
      return
    }
    try {
      const page = await proposalsApi.list({ status: 'pending', limit: 1 })
      setPendingReviewCount(page.total)
    } catch {
      // Review indicators are advisory; a transient read failure must not
      // interrupt navigation or turn into a global error toast.
    }
  }, [currentUser?.id, reviewSpaceId])

  useEffect(() => {
    void refreshReviewAttention()
    const refresh = () => { void refreshReviewAttention() }
    window.addEventListener(REVIEW_ATTENTION_CHANGED_EVENT, refresh)
    const interval = window.setInterval(refresh, 30_000)
    return () => {
      window.removeEventListener(REVIEW_ATTENTION_CHANGED_EVENT, refresh)
      window.clearInterval(interval)
    }
  }, [refreshReviewAttention])

  useEffect(() => { try { localStorage.setItem(RAIL_KEY, String(railExpanded)) } catch { /* ignore */ } }, [railExpanded])
  useEffect(() => { try { localStorage.setItem(SCENE_COLLAPSE_KEY, JSON.stringify(collapsedScenes)) } catch { /* ignore */ } }, [collapsedScenes])

  const sceneCollapsed = scene ? (collapsedScenes[scene.id] ?? false) : false
  const showSidebar = Boolean(scene) && !sceneCollapsed
  const title = scene?.title ?? (isHome ? 'Home' : moduleForPath(logicalPath, effectiveModules)?.label ?? 'agent-space')
  const permissionSpaceId = activeSpaceId ?? preferredSpaceId
  const permissionRole = spaces.find(s => s.id === permissionSpaceId)?.role
  const canManageSpace = permissionRole === 'owner' || permissionRole === 'admin'
  const canManageInstance = Boolean(currentUser?.is_instance_admin)

  const pluginNavItems: PluginNavItem[] = effectiveModules
    .filter(m => m.source === 'official_plugin' && m.enabled && m.perspectiveType !== 'neutral')
    .map(m => ({
      id: m.id, label: m.label, path: m.path, icon: m.icon,
      scope: m.perspectiveType === 'space-scoped' ? 'space' as const : 'personal' as const,
    }))

  function setSceneCollapsed(collapsed: boolean) {
    if (!scene) return
    setCollapsedScenes(prev => ({ ...prev, [scene.id]: collapsed }))
  }

  return (
    // The capture composer is mounted once here, so one gesture serves every
    // page. What it may offer as a destination is declared from below: the
    // Project shell names the Project, an Area names the object it is about.
    <ProjectCaptureTargetProvider>
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <GlobalRail
        expanded={railExpanded}
        onToggle={() => setRailExpanded(v => !v)}
        spaceId={preferredSpaceId}
        canManageSpace={canManageSpace}
        canManageInstance={canManageInstance}
        pendingReviewCount={pendingReviewCount}
        pluginModules={pluginNavItems}
      />

      {showSidebar && scene && (
        <SceneSidebar
          scene={scene}
          onCollapse={() => setSceneCollapsed(true)}
          spaceId={preferredSpaceId}
        />
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <SceneHeader
          title={title}
          isHome={isHome}
          hasSidebar={Boolean(scene)}
          sidebarCollapsed={sceneCollapsed}
          onExpandSidebar={() => setSceneCollapsed(false)}
        />

        {scene && <SceneTabs scene={scene} spaceId={preferredSpaceId} />}

        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>

        <MobileTabBar spaceId={preferredSpaceId} pendingReviewCount={pendingReviewCount} />
      </div>

      <FloatingQuickCapture />

      <Toaster
        theme={theme}
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--card)',
            border: '1px solid var(--border)',
            color: 'var(--foreground)',
          },
        }}
      />
    </div>
    </ProjectCaptureTargetProvider>
  )
}
