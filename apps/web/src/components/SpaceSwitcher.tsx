import { useState, useRef, useEffect } from 'react'
import { Plus, Check, ChevronDown, Users, Home, Heart } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useSpace } from '../contexts/SpaceContext'
import { useAuth } from '../contexts/AuthContext'
import { cn } from '../lib/utils'
import { spacePath } from '../core/navigation'
import type { SpaceType } from '../types/api'

const TYPE_ICON: Record<SpaceType, typeof Home> = {
  personal: Home,
  household: Heart,
  team: Users,
}

function SpaceIcon({ type, size = 12 }: { type: SpaceType; size?: number }) {
  const Icon = TYPE_ICON[type] ?? Users
  return <Icon size={size} />
}

function spaceSubtitle(type: SpaceType): string {
  if (type === 'personal') return 'Personal Space'
  if (type === 'household') return 'Family Space'
  return 'Team Space'
}

/**
 * Switches between the user's real Spaces only. It never lists Home, "My View", or any
 * cross-space aggregate — those are not Spaces. Selecting a Space activates it and lands on
 * that Space's Today page; it never mutates the user-scoped Home.
 */
export function SpaceSwitcher() {
  const { activeSpaceId, preferredSpaceId, spaces } = useSpace()
  const { currentUser } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // On a space route this is the URL's Space; on a user-scoped surface it previews the Space a
  // switch would enter (the preferred Space). Selecting any Space navigates into it.
  const shownSpaceId = activeSpaceId ?? preferredSpaceId
  const active = spaces.find(s => s.id === shownSpaceId) ?? null

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  function selectSpace(id: string) {
    setOpen(false)
    navigate(spacePath(id, '/today'))
  }

  if (!currentUser) {
    return (
      <div className="flex items-center gap-1.5 h-8 px-2.5 border border-border rounded-md shrink-0">
        <span className="text-[9px] font-bold tracking-[.1em] uppercase text-muted-foreground">space</span>
        <span className="text-[13px] text-foreground font-medium">{shownSpaceId}</span>
      </div>
    )
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={spaces.length === 0}
        className="flex items-center gap-1.5 h-8 max-w-[42vw] px-2.5 border border-border rounded-md hover:bg-accent transition-colors shrink-0 disabled:opacity-50 sm:max-w-none"
        aria-label="Switch space"
      >
        {active && <SpaceIcon type={active.type} size={11} />}
        <span className="text-[13px] text-foreground font-medium min-w-0 max-w-[5.5rem] truncate sm:max-w-[140px]">
          {active?.name ?? (spaces.length === 0 ? '…' : 'Select space')}
        </span>
        <ChevronDown size={11} className="text-muted-foreground shrink-0" />
      </button>

      {open && (
        <div className="absolute top-[calc(100%+6px)] left-0 min-w-[220px] bg-card border border-border rounded-lg shadow-lg z-50 py-1 overflow-hidden">
          {spaces.length > 0 && (
            <>
              <div className="px-3 py-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Spaces
                </span>
              </div>
              {spaces.map(s => (
                <button
                  key={s.id}
                  onClick={() => selectSpace(s.id)}
                  className={cn(
                    'w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-accent transition-colors',
                    s.id === activeSpaceId ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span className="mt-0.5"><SpaceIcon type={s.type} size={12} /></span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] font-medium truncate">{s.name}</span>
                    <span className="block text-[10px] text-muted-foreground">{spaceSubtitle(s.type)}</span>
                  </span>
                  <span className="text-[10px] text-muted-foreground">{s.role}</span>
                  {s.id === activeSpaceId && <Check size={12} className="text-accent-foreground shrink-0 mt-0.5" />}
                </button>
              ))}
              <div className="border-t border-border my-1" />
            </>
          )}

          <button
            onClick={() => { setOpen(false); window.location.href = '/settings#spaces' }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Plus size={12} />
            <span className="text-[13px]">Create space…</span>
          </button>
        </div>
      )}
    </div>
  )
}
