import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

export type NavSection = 'capture' | 'knowledge' | 'agents' | 'dev'
export type AppGroup   = 'daily' | 'work' | 'knowledge' | 'agents' | 'system'
export type PerspectiveType = 'space-scoped' | 'personal' | 'neutral'

/**
 * Where an app entry originates.
 *
 * built_in       — shipped with the core bundle, always present.
 * official_plugin — an official optional module (developed by agent-space maintainers,
 *                  installed/enabled via the official plugin control plane).
 *                  These entries are NOT capabilities. See OFFICIAL_OPTIONAL_MODULES.md.
 * installed      — reserved for future third-party installable plugin packages.
 *                  NOT yet implemented. Do not use in MVP.
 * external       — references a remote tool or external service (reserved).
 *
 * For current core features all entries are built_in.
 * Optional features added by agent-space maintainers use official_plugin.
 */
export type AppSource = 'built_in' | 'official_plugin' | 'installed' | 'external'

export interface Module {
  // ── Identity ───────────────────────────────────────────────────────────────
  id: string
  label: string
  path: string
  icon: string          // lucide icon name (kebab-case)
  description: string   // gallery card description
  group: AppGroup       // gallery section
  section: NavSection   // nav grouping for the shell layout

  // ── Capability link ────────────────────────────────────────────────────────
  /**
   * Backend capability ID this entry is backed by.
   * undefined = no formal capability (core UI feature).
   *
   * NOTE: Capability is an agent AI skill descriptor
   * (capability-definitions / workflow framework).
   * It is NOT the same as an official optional module. Do not use this field
   * to represent official optional module enablement — use pluginId for that.
   */
  capabilityId?: string

  /**
   * Official optional module plugin ID this entry belongs to.
   * Set for entries with source: 'official_plugin'.
   *
   * The frontend overlays enabled/visible state for these entries from
   * GET /api/v1/plugins/effective rather than from static registry values.
   * See useEffectivePlugins hook and OFFICIAL_OPTIONAL_MODULES.md.
   */
  pluginId?: string

  // ── Origin ────────────────────────────────────────────────────────────────
  /** Where this entry comes from. */
  source: AppSource

  // ── Runtime state ─────────────────────────────────────────────────────────
  /**
   * Whether the module is enabled for the active space/user.
   * - true  → app is interactive and navigable.
   * - false → app appears in the gallery but is grayed out (not clickable).
   *
   * For built_in entries this is always true at static registration time.
   * For official_plugin entries: this is the static default; the runtime value
   * is overlaid from GET /api/v1/plugins/effective by useEffectivePlugins.
   * The frontend is NOT the source of truth for enabled state.
   */
  enabled: boolean

  /**
   * Whether the app card is shown in the home gallery.
   * - true  → card renders in gallery grid.
   * - false → card is hidden (e.g. retired capability, space policy).
   *
   * Intentionally separate from `enabled`: a capability can be enabled
   * but its gallery card hidden (accessed only via direct URL).
   */
  visible: boolean

  /**
   * Dev-status flag: feature is not yet implemented.
   * Shows a "soon" badge on the card. Implies non-interactive regardless
   * of `enabled`. Does NOT mean permanently disabled — `enabled` handles that.
   */
  planned: boolean

  // ── Display preferences (user-adjustable in future) ────────────────────────
  /** Pin to the top row of the home gallery. */
  pinned?: boolean
  /** Explicit display order within the group. Lower = earlier. */
  order?: number

  // ── UI hints ──────────────────────────────────────────────────────────────
  /** Render this card with an indigo accent tile (one per group recommended). */
  accent?: boolean

  // ── Router ────────────────────────────────────────────────────────────────
  /** When true, route is registered as `path/*` to allow nested <Routes>. */
  hasSubRoutes?: boolean
  /** Whether this route operates against personal aggregation, a concrete space, or no perspective. */
  perspectiveType: PerspectiveType
  /** Hide direct UI entry points unless the active Space role is owner/admin. Routes still guard themselves. */
  requiresSpaceAdmin?: boolean
  component: LazyExoticComponent<ComponentType>
}

/**
 * Central app + module registry.
 *
 * Every entry is simultaneously:
 *   - A gallery card on the home page (uses group, icon, description, enabled, visible)
 *   - A React Router route (uses path, component, hasSubRoutes)
 *   - A future capability link (uses capabilityId, source, enabled)
 *
 * ── Extension boundary ──────────────────────────────────────────────────────
 * To add a new BUILT-IN app:
 *   1. Create src/modules/<id>/<PageName>.tsx
 *   2. Add an entry below with source: 'built_in'
 *   3. Route auto-registers in App.tsx
 *
 * To add an OFFICIAL OPTIONAL MODULE entry (bundled in repo, opt-in per space/user):
 *   1. Create the plugin frontend entry under plugins/official/<pluginId>/web/src/
 *   2. Add an entry below with source: 'official_plugin', pluginId: '<plugin_id>'
 *   3. Set enabled: false, visible: true as static defaults
 *   4. The useEffectivePlugins hook will overlay runtime enabled/visible from backend
 *   5. Register the descriptor in server/src/modules/plugins/official/<pluginId>.ts
 *   6. If it contributes backend behavior, add a bundled plugin package under
 *      plugins/official/<pluginId>/; server loads its build artifact via
 *      server/src/modules/plugins/builtInPlugins.ts
 *   7. Add an app-owned adapter under src/plugins/<pluginId>/ that injects frontend host APIs
 *
 * To support future INSTALLED third-party plugins (do not implement yet):
 *   - Reserved for a future plugin package system with sandboxing/SDK.
 *   - Do NOT implement third-party plugin loading in this registry.
 *
 * NOTE: Capabilities are agent AI skills, NOT product modules. Do not confuse
 * GET /api/v1/capability-definitions (agent skill framework) with
 * GET /api/v1/plugins/effective (official module control plane).
 *
 * ── State semantics ─────────────────────────────────────────────────────────
 *   planned   = not yet built ("soon" badge, non-interactive, dev concern)
 *   !enabled  = capability off for this space (grayed card, runtime concern)
 *   !visible  = hidden from gallery (space policy or user pref, shown nowhere)
 *   pinned    = promoted in gallery (user preference, future)
 * ───────────────────────────────────────────────────────────────────────────
 */
export const MODULE_REGISTRY: Module[] = [

  // ── Official optional modules ──────────────────────────────────────────────
  // These entries have source: 'official_plugin'. Their enabled/visible values
  // are static defaults; runtime state is overlaid by useEffectivePlugins from
  // GET /api/v1/plugins/effective. Direct navigation to a disabled plugin route
  // shows a disabled-module stub, not a generic 404.
  {
    id: 'diary', label: 'Diary', path: '/diary',
    section: 'capture', group: 'daily', icon: 'book',
    description: 'Personal diary with same-day history across years. Supports AI reflection, daily reminders, and opt-in memory proposals after your review.',
    source: 'official_plugin', pluginId: 'diary', capabilityId: undefined,
    enabled: false, visible: true, planned: false,
    perspectiveType: 'personal',
    component: lazy(() => import('../plugins/diary/DiaryPageAdapter')),
  },
  {
    id: 'finance', label: 'Finance', path: '/finance',
    section: 'knowledge', group: 'work', icon: 'landmark',
    description: 'Double-entry finance ledger for this space: books, accounts, commodities, and transactions with Beancount import/export.',
    source: 'official_plugin', pluginId: 'finance_ledger', capabilityId: undefined,
    enabled: false, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('../plugins/finance_ledger/FinancePageAdapter')),
  },
  // ── Daily ─────────────────────────────────────────────────────────────────
  {
    id: 'today', label: 'Today', path: '/today',
    section: 'capture', group: 'daily', icon: 'sun', accent: true,
    description: "This space's daily overview, active items, and suggested actions.",
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./today/TodayPage')),
  },
  {
    id: 'capture', label: 'Capture', path: '/capture',
    section: 'capture', group: 'daily', icon: 'plus',
    description: 'Quickly save thoughts, ideas, notes, and external content.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./capture/CapturePage')),
  },
  {
    id: 'activity', label: 'Inbox', path: '/activity',
    section: 'capture', group: 'daily', icon: 'inbox',
    description: 'Everything awaiting your attention: new briefings and records to review.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    hasSubRoutes: true,
    component: lazy(() => import('./activity/ActivityModule')),
  },
  {
    id: 'library', label: 'Library', path: '/library',
    section: 'capture', group: 'daily', icon: 'library',
    description: 'Read, filter, and triage the articles, papers, and digests your sources bring in.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    hasSubRoutes: true,
    component: lazy(() => import('./library/LibraryModule')),
  },
  {
    id: 'daily_reports', label: 'Daily Report', path: '/daily-report',
    section: 'capture', group: 'daily', icon: 'calendar-check',
    description: 'Automatically generate a structured daily report from your captures. Experience and memory proposals require your review.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./daily_reports/DailyReportSettingsPage')),
  },
  {
    id: 'sessions', label: 'Sessions', path: '/sessions',
    section: 'capture', group: 'daily', icon: 'message-square',
    description: 'Manage and continue agent sessions and conversations.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./sessions/SessionsPage')),
  },
  {
    id: 'time', label: 'Time', path: '/time',
    section: 'capture', group: 'daily', icon: 'clock',
    description: 'Track time records and convert them into activity summaries.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: true,
    perspectiveType: 'neutral',
    component: lazy(() => import('./time/TimePage')),
  },
  {
    id: 'source', label: 'Sources', path: '/sources',
    section: 'capture', group: 'daily', icon: 'rss',
    description: 'Manage information subscriptions: connections, scan schedules, and screening rules.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    hasSubRoutes: true,
    component: lazy(() => import('./sources/SourcesModule')),
  },

  // ── Work (task → run → outputs → review) ───────────────────────────────────
  {
    id: 'projects', label: 'Projects', path: '/projects',
    section: 'agents', group: 'work', icon: 'folder-kanban', accent: true,
    description: 'Goal and knowledge context. Organize objectives, artifacts, proposals, memory, and Project Folders.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    order: 5,
    hasSubRoutes: true,
    component: lazy(() => import('./projects/ProjectsModule')),
  },
  {
    id: 'tasks', label: 'Tasks', path: '/tasks',
    section: 'agents', group: 'work', icon: 'list-todo',
    description: 'Plan work, start runs, and review linked outputs.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    order: 10,
    hasSubRoutes: true,
    component: lazy(() => import('./tasks/TasksModule')),
  },
  {
    id: 'plans', label: 'Plans', path: '/plans',
    section: 'agents', group: 'work', icon: 'list-tree',
    description: 'Review Agent-generated Plans linked to source Tasks without a canvas.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    hasSubRoutes: true,
    component: lazy(() => import('./plans/PlansModule')),
  },
  {
    id: 'command_center', label: 'Command Center', path: '/command-center',
    section: 'agents', group: 'work', icon: 'server', accent: true,
    description: 'Dispatch tasks to your registered hosts and review their work (ADR 0016).',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    order: 5,
    hasSubRoutes: true,
    component: lazy(() => import('./command_center/CommandCenterModule')),
  },
  {
    id: 'runs', label: 'Runs', path: '/runs',
    section: 'agents', group: 'work', icon: 'cpu', accent: true,
    description: 'Inspect agent runs, status, activities, artifacts, and proposals.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    order: 20,
    hasSubRoutes: true,
    component: lazy(() => import('./runs/RunsModule')),
  },
  {
    id: 'proposals', label: 'Review', path: '/proposals',
    section: 'knowledge', group: 'work', icon: 'check-circle',
    description: 'Review memory, knowledge, card, code, and system proposals.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    order: 30,
    hasSubRoutes: true,
    component: lazy(() => import('./memory/ProposalsModule')),
  },
  {
    id: 'artifacts', label: 'Artifacts', path: '/artifacts',
    section: 'agents', group: 'work', icon: 'package',
    description: 'Browse and export outputs produced by runs.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    order: 40,
    hasSubRoutes: true,
    component: lazy(() => import('./artifacts/ArtifactsModule')),
  },
  {
    id: 'publications', label: 'Shared', path: '/publications',
    section: 'knowledge', group: 'work', icon: 'share-2',
    description: 'Review targeted snapshots shared with this space and manage publications from this space.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./publications/PublicationsPage')),
  },

  // ── Knowledge ─────────────────────────────────────────────────────────────
  {
    id: 'knowledge', label: 'Knowledge', path: '/knowledge',
    section: 'knowledge', group: 'knowledge', icon: 'book-open', accent: true,
    description: 'Working notes, canonical wiki knowledge, sources, and review material.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    hasSubRoutes: true,
    component: lazy(() => import('./knowledge/KnowledgeModule')),
  },
  {
    id: 'graph', label: 'Graph', path: '/graph',
    section: 'knowledge', group: 'knowledge', icon: 'network',
    description: 'Explore visible Knowledge relationships through the shared graph projection.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./graph/GraphPage')),
  },
  {
    id: 'cards', label: 'Cards', path: '/cards',
    section: 'knowledge', group: 'knowledge', icon: 'layers',
    description: 'Review and manage spaced-repetition flashcards.',
    source: 'built_in', capabilityId: undefined,
    enabled: false, visible: false, planned: true,
    perspectiveType: 'neutral',
    component: lazy(() => import('./cards/CardReviewPage')),
  },
  {
    id: 'memory', label: 'Memory', path: '/memory',
    section: 'knowledge', group: 'knowledge', icon: 'database',
    description: 'Review scoped memories, visibility, and long-term context.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    hasSubRoutes: true,
    component: lazy(() => import('./memory/MemoryModule')),
  },
  {
    id: 'ask_space', label: 'Ask Space', path: '/ask-space',
    section: 'knowledge', group: 'knowledge', icon: 'sparkles', accent: true,
    description: 'Ask one question and get a cited, gap-aware answer across Knowledge, Memory, and Project summaries.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./ask_space/AskSpacePage')),
  },
  {
    id: 'context_ops', label: 'Context Health', path: '/context-ops',
    section: 'knowledge', group: 'knowledge', icon: 'activity',
    description: 'Inspect retrieval health, diagnostics, maintenance, feedback, and memory provenance aggregates.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./context_ops/ContextOpsPage')),
  },

  // ── Agents (execution & infrastructure) ─────────────────────────────────────
  {
    id: 'instance_settings', label: 'Instance Settings', path: '/instance-settings',
    section: 'dev', group: 'system', icon: 'server-cog',
    description: 'Manage server-wide instance configuration.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: false, planned: false,
    perspectiveType: 'neutral',
    component: lazy(() => import('./instance_settings/InstanceSettingsPage')),
  },
  {
    id: 'runtime_tools', label: 'Runtime Tools', path: '/runtime-tools',
    section: 'dev', group: 'system', icon: 'terminal',
    description: 'Install and update server-wide CLI runtime tools.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: false, planned: false,
    perspectiveType: 'neutral',
    component: lazy(() => import('./runtime_tools/RuntimeToolsPage')),
  },
  {
    id: 'cli_profiles', label: 'CLI Profiles', path: '/cli-profiles',
    section: 'dev', group: 'system', icon: 'terminal',
    description: 'Manage personal CLI login profiles and space grants.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'neutral',
    component: lazy(() => import('./cli_profiles/CliProfilesPage')),
  },
  {
    id: 'job_queue', label: 'Job Queue', path: '/jobs',
    section: 'agents', group: 'agents', icon: 'list-checks',
    description: 'Inspect infrastructure jobs, retries, and worker status.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./job_queue/JobQueuePage')),
  },
  {
    id: 'rooms', label: 'Rooms', path: '/rooms',
    section: 'agents', group: 'agents', icon: 'messages-square',
    description: 'Hold project-bound, multi-party conversations and dispatch auditable agent work.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./agent_groups/AgentGroupsPage')),
  },
  {
    id: 'evolution', label: 'Evolution', path: '/evolution',
    section: 'agents', group: 'agents', icon: 'git-branch',
    description: 'Review evolution targets, signals, runs, proposals, and validation metrics.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'neutral',
    hasSubRoutes: true,
    component: lazy(() => import('./evolution/EvolutionModule')),
  },
  {
    id: 'prompt_library', label: 'Prompt Library', path: '/prompts',
    section: 'dev', group: 'system', icon: 'scroll-text',
    description: 'Inspect prompt assets, versions, previews, evaluation evidence, and deployment state.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    requiresSpaceAdmin: true,
    component: lazy(() => import('./prompts/PromptLibraryPage')),
  },

  // ── Context ops ───────────────────────────────────────────────────────────
  {
    id: 'retrieval_settings', label: 'Retrieval Settings', path: '/retrieval-settings',
    section: 'dev', group: 'system', icon: 'search',
    description: 'Configure retrieval search mode, rewrite, rerank, cache, trace, and result defaults.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: false, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./retrieval_settings/RetrievalSettingsPage')),
  },

  // ── Plugin management ─────────────────────────────────────────────────────
  {
    id: 'plugins', label: 'Optional Modules', path: '/plugins',
    section: 'dev', group: 'system', icon: 'puzzle',
    description: 'Manage official optional modules — enable or disable per-space features.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./plugins/PluginsPage')),
  },

  // ── System ────────────────────────────────────────────────────────────────
  {
    id: 'settings', label: 'Settings', path: '/settings',
    section: 'dev', group: 'system', icon: 'settings', accent: true,
    description: 'Configure personal credentials, spaces, and preferences.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'neutral',
    component: lazy(() => import('./settings/SettingsPage')),
  },
  {
    id: 'space_settings', label: 'Space Settings', path: '/space-settings',
    section: 'dev', group: 'system', icon: 'settings',
    description: 'Manage members and space-level system settings.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: false, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./space_settings/SpaceSettingsPage')),
  },
  {
    id: 'capabilities', label: 'Capabilities', path: '/capabilities',
    section: 'agents', group: 'system', icon: 'zap',
    description: 'Browse registered capability manifests and permissions.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./capabilities/CapabilitiesPage')),
  },
  {
    id: 'agents_mgmt', label: 'Agents', path: '/agents',
    section: 'agents', group: 'agents', icon: 'bot',
    description: 'Create agents and configure default model providers.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    hasSubRoutes: true,
    component: lazy(() => import('./agents/AgentsModule')),
  },
  {
    id: 'providers', label: 'Providers', path: '/providers',
    section: 'dev', group: 'system', icon: 'key',
    description: 'Configure API keys for LLM model providers.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./providers/ModelProvidersPage')),
  },
  {
    id: 'usage', label: 'Token Usage', path: '/usage',
    section: 'dev', group: 'system', icon: 'bar-chart-3',
    description: 'Inspect model token usage, accuracy, platform attribution, sessions, dimensions, and local CLI history imports.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./usage/UsagePage')),
  },
  {
    id: 'network_profiles', label: 'Network', path: '/network-profiles',
    section: 'dev', group: 'system', icon: 'globe',
    description: 'Configure direct and proxy routing profiles for providers and CLI runtimes.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: false, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./network_profiles/NetworkProfilesPage')),
  },
  {
    id: 'automations', label: 'Automations', path: '/automations',
    section: 'agents', group: 'agents', icon: 'clock',
    description: 'Schedule agent runs and Knowledge maintenance scans, or trigger them manually.',
    source: 'built_in', capabilityId: undefined,
    enabled: true, visible: true, planned: false,
    perspectiveType: 'space-scoped',
    component: lazy(() => import('./automations/AutomationsPage')),
  },
]

export interface EffectivePluginOverlay {
  enabled: boolean
  visible: boolean
}

export type EffectivePluginOverlayMap = Record<string, EffectivePluginOverlay | undefined>

export function modulesWithEffectivePlugins(
  modules: readonly Module[],
  plugins: EffectivePluginOverlayMap,
): Module[] {
  return modules.map(module => {
    if (module.source !== 'official_plugin' || !module.pluginId) return module
    const state = plugins[module.pluginId]
    if (!state) return module
    return { ...module, enabled: state.enabled, visible: state.visible }
  })
}

/**
 * Find the registered module that owns a path (used for route metadata lookups).
 * Navigation tiers live in `src/core/navigation.tsx`; the home/space scope split lives in
 * `routeScopeForPath`. The old "perspective" path classifier has been removed.
 */
export function moduleForPath(
  pathname: string,
  modules: readonly Module[] = MODULE_REGISTRY,
): Module | undefined {
  return modules.find(module => {
    if (pathname === module.path) return true
    return module.hasSubRoutes && pathname.startsWith(`${module.path}/`)
  })
}
