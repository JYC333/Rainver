import { useState, useEffect, useRef, useCallback } from 'react'
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Sun, Moon, LogOut, Menu, Globe } from 'lucide-react'
import { Toaster, toast } from 'sonner'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { useSpace } from '../contexts/SpaceContext'
import { SpaceSwitcher } from '../components/SpaceSwitcher'
import { UserAvatar } from '../components/UserAvatar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu'
import { AddAccountDialog, BrowserAccountSection, useBrowserAccounts } from '../components/shell/BrowserAccounts'
import { GlobalRail, type PluginNavItem } from '../components/shell/GlobalRail'
import { SceneSidebar, SceneTabs } from '../components/shell/SceneSidebar'
import { SettingsNavigation } from '../components/shell/SettingsNavigation'
import { MobileTabBar } from '../components/shell/MobileTabBar'
import { FloatingQuickCapture } from '../components/FloatingQuickCapture'
import { ProjectCaptureTargetProvider } from '../contexts/CaptureContext'
import { routeScopeForPath, sceneForPath, stripSpacePrefix } from './navigation'
import { moduleForPath } from '../modules/registry'
import { useEffectiveModules } from '../modules/plugins/useEffectivePlugins'
import { proposalsApi } from '../api/client'
import { REVIEW_ATTENTION_CHANGED_EVENT } from './reviewAttention'
import { AgentAttentionProvider } from '../modules/agent_work/AgentAttentionProvider'
import { useAppTranslation } from '../i18n'
import { useIPhonePwaViewport } from './useIPhonePwaViewport'

const RAIL_KEY = 'rainver:rail-expanded'
const SCENE_COLLAPSE_KEY = 'rainver:scene-collapsed'

function readBool(key: string, fallback: boolean): boolean {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === 'true' } catch { return fallback }
}
function readMap(key: string): Record<string, boolean> {
  try { const v = JSON.parse(localStorage.getItem(key) ?? '{}'); return typeof v === 'object' && v ? v : {} } catch { return {} }
}

/* ── Theme toggle ──────────────────────────────────────────────────────────── */
function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const { t } = useAppTranslation()
  return (
    <button
      onClick={toggleTheme}
      className="flex items-center justify-center w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      title={theme === 'dark' ? t('shell.switch_to_light') : t('shell.switch_to_dark')}
    >
      {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
    </button>
  )
}

/* ── User menu ─────────────────────────────────────────────────────────────── */
function UserMenu() {
  const { currentUser, logout, accountAddReturned, acknowledgeAccountAdd } = useAuth()
  const { t } = useAppTranslation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  // The menu returns focus to its trigger on close; not when it opened the dialog.
  const openingDialog = useRef(false)
  const accounts = useBrowserAccounts(open)

  // Back from Google without a new account: say why, once, and drop the reason from the address.
  useEffect(() => {
    if (!accountAddReturned) return
    acknowledgeAccountAdd()
    const reason = params.get('error')
    if (reason === null) return
    // After this commit: the shell's Toaster, mounted beside this menu, subscribes in its own effect.
    const message = reason === 'account_limit' ? t('shell.account_limit') : t('shell.add_account_failed')
    setTimeout(() => toast.error(message), 0)
    const next = new URLSearchParams(params)
    next.delete('error')
    next.delete('error_description')
    setParams(next, { replace: true })
  }, [accountAddReturned, acknowledgeAccountAdd, params, setParams, t])

  if (!currentUser) {
    return (
      <button
        onClick={() => navigate('/login')}
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        {t('shell.sign_in')}
      </button>
    )
  }

  // Sign-out ends every account of this browser; it is plain "Sign out" only when that is one.
  const signOutLabel = accounts.status === 'ready' && accounts.accounts.length <= 1 ? t('shell.sign_out') : t('shell.sign_out_all')
  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border hover:opacity-90 transition-opacity"
            title={currentUser.display_name}
            aria-label={t('shell.account_menu', { name: currentUser.display_name })}
          >
            <UserAvatar avatarUrl={currentUser.avatar_url} displayName={currentUser.display_name} email={currentUser.email} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-56 overflow-hidden p-0 py-1"
          onCloseAutoFocus={event => { if (openingDialog.current) { event.preventDefault(); openingDialog.current = false } }}
        >
          <div className="px-3 py-2 border-b border-border">
            <div className="text-[13px] font-medium text-foreground truncate">{currentUser.display_name}</div>
            <div className="text-[11px] text-muted-foreground truncate">{currentUser.email}</div>
          </div>
          <BrowserAccountSection state={accounts} onAdd={() => { openingDialog.current = true; setAdding(true) }} />
          <DropdownMenuItem
            onSelect={() => { void logout() }}
            className="w-full rounded-none gap-2 px-3 py-2 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <LogOut size={13} />
            {signOutLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {adding && <AddAccountDialog onOpenChange={setAdding} />}
    </>
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
  const { t } = useAppTranslation()
  return (
    <header
      className="shrink-0 flex items-center gap-2.5 h-14 px-4 border-b border-border bg-card"
    >
      {hasSidebar && sidebarCollapsed ? (
        <button
          type="button"
          onClick={onExpandSidebar}
          className="hidden md:flex items-center gap-2 h-8 px-2.5 rounded-md border border-border text-[13px] font-semibold text-foreground hover:bg-accent transition-colors"
          title={t('shell.show_sidebar')}
          aria-label={t('shell.show_sidebar')}
        >
          <Menu className="size-4" /> {title}
        </button>
      ) : (
        <h1 className="min-w-0 text-[15px] font-semibold tracking-tight text-foreground truncate">{title}</h1>
      )}

      {isHome && (
        <span className="hidden sm:inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border text-[11px] text-muted-foreground">
          <Globe className="size-3" /> {t('shell.all_spaces')}
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
  const { currentUser } = useAuth()
  return currentUser ? <AgentAttentionProvider userId={currentUser.id}><ShellContent /></AgentAttentionProvider> : <ShellContent />
}
function ShellContent() {
  useIPhonePwaViewport()
  const { t } = useAppTranslation()
  const { theme } = useTheme()
  const { currentUser } = useAuth()
  const { activeSpaceId, preferredSpaceId, spaces } = useSpace()
  const location = useLocation()
  // Follows PluginsPage enable/disable through the hook's own plugin-state subscription.
  const { modules: effectiveModules } = useEffectiveModules()

  const scope = routeScopeForPath(location.pathname)
  const logicalPath = stripSpacePrefix(location.pathname)
  // Home-scope pages have no scene, except user-scoped My Agents: it keeps the Agents scene
  // (desktop sidebar and mobile tabs), whose in-Space items link through the preferred Space.
  const userScopedScene = logicalPath === '/my-agents' || logicalPath.startsWith('/my-agents/')
  const scene = scope === 'home' && !userScopedScene ? null : sceneForPath(location.pathname)
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
  const module = moduleForPath(logicalPath, effectiveModules)
  const title = logicalPath === '/settings/security' ? t('settings.account_security') : scene
    ? t(`nav.${scene.id}`, { defaultValue: t(`modules.${scene.id}`, { defaultValue: scene.title }) })
    : isHome ? t('nav.home') : module ? t(`modules.${module.id}`, { defaultValue: module.label }) : 'rainver'
  const permissionSpaceId = activeSpaceId ?? preferredSpaceId
  const permissionRole = spaces.find(s => s.id === permissionSpaceId)?.role
  const canManageSpace = permissionRole === 'owner' || permissionRole === 'admin'
  const canManageInstance = Boolean(currentUser?.is_instance_admin)

  const pluginNavItems: PluginNavItem[] = effectiveModules
    .filter(m => m.source === 'official_plugin' && m.enabled && m.perspectiveType !== 'neutral')
    .map(m => ({
      id: m.id, label: t(`modules.${m.id}`, { defaultValue: m.label }), path: m.path, icon: m.icon,
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
    <div className="app-safe-shell fixed inset-0 flex overflow-hidden overscroll-none bg-background text-foreground">
      {/* data-shell-chrome: what the Reader's focus mode hides (see index.css). */}
      <div data-shell-chrome data-app-chrome className="contents">
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
      </div>

      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <div data-shell-chrome data-app-chrome className="contents">
        <SceneHeader
          title={title}
          isHome={isHome}
          hasSidebar={Boolean(scene)}
          sidebarCollapsed={sceneCollapsed}
          onExpandSidebar={() => setSceneCollapsed(false)}
        />

        {scene && <SceneTabs scene={scene} spaceId={preferredSpaceId} />}
        </div>

        <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          <SettingsNavigation />
          <Outlet />
        </main>

        <div data-shell-chrome data-app-chrome className="contents"><MobileTabBar spaceId={preferredSpaceId} pendingReviewCount={pendingReviewCount} canManageSpace={canManageSpace} canManageInstance={canManageInstance} pluginModules={pluginNavItems} /></div>
      </div>

      <div data-shell-chrome data-app-chrome className="contents"><FloatingQuickCapture /></div>

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
