import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import {
  BookOpen, Check, ChevronDown, Layers, LayoutDashboard, Library, NotebookPen,
  type LucideIcon,
} from 'lucide-react'
import { useSpace } from '../../contexts/SpaceContext'
import { useSpaceNavigate } from '../../core/spaceNav'
import { stripSpacePrefix } from '../../core/navigation'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
} from '../../components/ui/dropdown-menu'
import { cn } from '../../lib/utils'
import { rememberKnowledgeSection, type KnowledgeSection } from './utils'

interface SectionDef {
  id: KnowledgeSection
  /** Label inside the switcher dropdown. */
  label: string
  /** Short label shown in the breadcrumb (`Knowledge / <crumb> ▼`). */
  crumb: string
  icon: LucideIcon
  /** Logical (space-resolved) path. */
  to: string
  description: string
}

/**
 * The Knowledge sub-areas, in switcher order. `home` is the optional overview hub;
 * the rest are the working sections. This catalog is the single source of truth for
 * the breadcrumb switcher, the overview links, and the index redirect default.
 */
export const KNOWLEDGE_SECTIONS: SectionDef[] = [
  {
    id: 'home', label: 'Knowledge Home', crumb: 'Home', icon: LayoutDashboard,
    to: '/knowledge/home',
    description: 'Status hub across Notes, Wiki, Sources, and Cards.',
  },
  {
    id: 'notes', label: 'Notes', crumb: 'Notes', icon: NotebookPen,
    to: '/knowledge/notes',
    description: 'Working knowledge — evolving project, design, research, and thinking notes.',
  },
  {
    id: 'wiki', label: 'Wiki', crumb: 'Wiki', icon: BookOpen,
    to: '/knowledge/wiki',
    description: 'Canonical structured knowledge powered by KnowledgeItems.',
  },
  {
    id: 'sources', label: 'Sources', crumb: 'Sources', icon: Library,
    to: '/knowledge/sources',
    description: 'External materials, evidence, and references that can support Notes and Wiki items.',
  },
  {
    id: 'cards', label: 'Cards', crumb: 'Cards', icon: Layers,
    to: '/knowledge/cards',
    description: 'Review cards derived from Notes, Wiki items, and Sources.',
  },
]

/**
 * Shared header for every Knowledge sub-area. Renders a lightweight
 * `Knowledge / <section> ▼` breadcrumb switcher (the only cross-section navigation —
 * there is no persistent Knowledge section sidebar or tab strip), the section
 * description, the active space, and optional section actions on the right.
 *
 * Mounting a section also records it as last-used so `/knowledge` reopens it
 * (the overview is excluded — see {@link rememberKnowledgeSection}).
 */
export default function KnowledgeSectionHeader({
  section,
  description,
  actions,
}: {
  section: KnowledgeSection
  /** Override the catalog description for this render. */
  description?: string
  actions?: React.ReactNode
}) {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const navigate = useSpaceNavigate()
  const location = useLocation()

  useEffect(() => { rememberKnowledgeSection(section) }, [section])

  const def = KNOWLEDGE_SECTIONS.find(s => s.id === section) ?? KNOWLEDGE_SECTIONS[0]
  const Icon = def.icon

  return (
    <div className="flex items-start gap-4 pb-4 border-b border-border">
      <div
        className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
        style={{
          background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
          border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
        }}
      >
        <Icon className="size-5 text-accent-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Switch Knowledge section"
              className="group inline-flex items-center gap-1.5 -ml-1 px-1 rounded-md hover:bg-accent/60 transition-colors"
            >
              <span className="text-sm text-muted-foreground">Knowledge</span>
              <span className="text-sm text-muted-foreground">/</span>
              <span className="text-xl font-semibold tracking-tight text-foreground">{def.crumb}</span>
              <ChevronDown className="size-4 text-muted-foreground group-data-[state=open]:rotate-180 transition-transform" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[13rem]">
            <DropdownMenuLabel>Knowledge</DropdownMenuLabel>
            {KNOWLEDGE_SECTIONS.map(s => {
              const active = s.id === section
              const ItemIcon = s.icon
              return (
                <DropdownMenuItem
                  key={s.id}
                  aria-current={active ? 'page' : undefined}
                  onSelect={() => {
                    // Avoid a redundant history push when already on this section
                    // (location is space-prefixed; compare logical paths).
                    if (s.to !== stripSpacePrefix(location.pathname)) navigate(s.to)
                  }}
                  className={cn(active && 'bg-accent/60')}
                >
                  <ItemIcon className="size-4 text-muted-foreground" />
                  <span className="flex-1">{s.label}</span>
                  {active && <Check className="size-3.5 text-accent-foreground" />}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <p className="text-sm text-muted-foreground">{description ?? def.description}</p>
        <p className="text-xs text-muted-foreground">
          Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}
        </p>
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  )
}
