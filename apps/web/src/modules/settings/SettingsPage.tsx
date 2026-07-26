import { useState, useId } from 'react'
import { useSpaceNavigate as useNavigate, SpaceLink as Link } from '../../core/spaceNav'
import { Settings, Sun, Moon, Plus, KeyRound, Terminal, BarChart3 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '../../contexts/AuthContext'
import { useSpace } from '../../contexts/SpaceContext'
import { useTheme, type Theme } from '../../contexts/ThemeContext'
import { spacesApi } from '../../api/client'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { cn, errMsg } from '../../lib/utils'
import type { SpaceOversightMode, SpaceType } from '../../types/api'

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun; description: string }[] = [
  { value: 'dark',  label: 'Dark',  icon: Moon, description: 'Deep navy — default' },
  { value: 'light', label: 'Light', icon: Sun,  description: 'Light purple skin'    },
]

const SPACE_TYPES: { value: Exclude<SpaceType, 'personal'>; label: string; description: string }[] = [
  { value: 'team',   label: 'Team',   description: 'Collaborative Space for a team' },
  { value: 'household', label: 'Family', description: 'Shared space for household members' },
]

const OVERSIGHT_MODE_OPTIONS: { value: SpaceOversightMode; label: string; description: string }[] = [
  { value: 'none',    label: 'None',    description: "Owners/admins see only what any member would — no extra visibility." },
  { value: 'summary', label: 'Summary', description: "Owners/admins can see a summary of other members' private content." },
  { value: 'content', label: 'Content', description: "Owners/admins can see the full content of other members' private content." },
  { value: 'full',    label: 'Full',    description: "Owners/admins can see everything, including highly restricted memory." },
]

export default function SettingsPage() {
  const { currentUser } = useAuth()
  const { reloadSpaces } = useSpace()
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()

  // Create space
  const [newSpaceName, setNewSpaceName] = useState('')
  const [newSpaceType, setNewSpaceType] = useState<Exclude<SpaceType, 'personal'>>('team')
  const [newSpaceOversightMode, setNewSpaceOversightMode] = useState<SpaceOversightMode>('none')
  const [creating, setCreating]         = useState(false)

  const headingId = useId()

  async function handleCreateSpace(e: React.FormEvent) {
    e.preventDefault()
    if (!newSpaceName.trim()) return
    setCreating(true)
    try {
      const space = await spacesApi.create({
        name: newSpaceName.trim(),
        type: newSpaceType,
        oversight_mode: newSpaceOversightMode,
      })
      toast.success(`Space "${space.name}" created`)
      setNewSpaceName('')
      setNewSpaceOversightMode('none')
      await reloadSpaces()
      // Enter the new Space by navigating to its URL (the active Space is now URL-derived).
      navigate(`/spaces/${space.id}/today`)
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl" id={headingId}>
      {/* Page header */}
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Settings className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">Configure your account credentials, personal spaces, and preferences.</p>
        </div>
      </div>

      {/* Model providers */}
      <Card>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-3.5" /> Model Providers
        </CardTitle>
        <p className="text-sm text-muted-foreground mb-3">
          Configure LLM backends (OpenAI, Anthropic, OpenRouter, Ollama) separately from runtime tools.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/providers">Open Model Providers</Link>
        </Button>
      </Card>

      {/* CLI runtime profiles */}
      <Card>
        <CardTitle className="flex items-center gap-2">
          <Terminal className="size-3.5" /> CLI Runtime Profiles
        </CardTitle>
        <p className="text-sm text-muted-foreground mb-3">
          Manage CLI login profiles, grants, and runtime login state separately from instance runtime tools.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/cli-profiles">Open CLI Profiles</Link>
        </Button>
      </Card>

      {/* Token usage */}
      <Card>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="size-3.5" /> Usage
        </CardTitle>
        <p className="text-sm text-muted-foreground mb-3">
          Review your token usage, estimated cost, sessions, and usage shared within the active Space.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/usage">Open Usage</Link>
        </Button>
      </Card>

      {/* Appearance */}
      <Card>
        <CardTitle className="flex items-center gap-2">
          <Sun className="size-3.5" /> Appearance
        </CardTitle>
        <div className="grid grid-cols-2 gap-2">
          {THEME_OPTIONS.map(({ value, label, icon: Icon, description }) => (
            <button
              key={value}
              onClick={() => setTheme(value)}
              className={cn(
                'flex items-center gap-3 p-3 rounded-lg border text-left transition-colors',
                theme === value
                  ? 'border-primary/50 bg-primary/8 text-foreground'
                  : 'border-border hover:bg-accent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" />
              <div>
                <div className="text-[13px] font-medium leading-none">{label}</div>
                <div className="text-[11px] mt-1 text-muted-foreground">{description}</div>
              </div>
              {theme === value && (
                <span className="ml-auto w-2 h-2 rounded-full shrink-0" style={{ background: 'var(--primary)' }} />
              )}
            </button>
          ))}
        </div>
      </Card>

      {/* ── Space management (authenticated users only) ── */}
      {currentUser ? (
        <>
          {/* Create space — anchor target */}
          <Card id="spaces">
            <CardTitle className="flex items-center gap-2">
              <Plus className="size-3.5" /> Create space
            </CardTitle>
            <form onSubmit={handleCreateSpace} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="space-name">Space name</Label>
                <Input
                  id="space-name"
                  value={newSpaceName}
                  onChange={e => setNewSpaceName(e.target.value)}
                  placeholder="My Team"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                {SPACE_TYPES.map(t => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setNewSpaceType(t.value)}
                    className={cn(
                      'flex flex-col gap-1 p-3 rounded-lg border text-left transition-colors',
                      newSpaceType === t.value
                        ? 'border-primary/50 bg-primary/8 text-foreground'
                        : 'border-border hover:bg-accent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <span className="text-[13px] font-medium">{t.label}</span>
                    <span className="text-[11px]">{t.description}</span>
                  </button>
                ))}
              </div>
              <div className="space-y-1.5">
                <Label>Oversight mode</Label>
                <p className="text-[11px] text-muted-foreground">
                  How much this Space's owner/admins can see of other members' otherwise-private content. Read-only, Space-internal, and cannot be changed after creation.
                </p>
                <div className="grid grid-cols-2 gap-2" role="group" aria-label="Oversight mode">
                  {OVERSIGHT_MODE_OPTIONS.map(o => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => setNewSpaceOversightMode(o.value)}
                      className={cn(
                        'flex flex-col gap-1 p-3 rounded-lg border text-left transition-colors',
                        newSpaceOversightMode === o.value
                          ? 'border-primary/50 bg-primary/8 text-foreground'
                          : 'border-border hover:bg-accent text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <span className="text-[13px] font-medium">{o.label}</span>
                      <span className="text-[11px]">{o.description}</span>
                    </button>
                  ))}
                </div>
              </div>
              <Button type="submit" size="sm" disabled={!newSpaceName.trim() || creating}>
                {creating ? 'Creating…' : 'Create space'}
              </Button>
            </form>
          </Card>

        </>
      ) : null}
    </div>
  )
}
