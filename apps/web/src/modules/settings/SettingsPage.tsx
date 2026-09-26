import { useState, useId } from 'react'
import { useSpaceNavigate as useNavigate, SpaceLink as Link } from '../../core/spaceNav'
import { Settings, Sun, Moon, Plus, KeyRound, BarChart3, Globe } from 'lucide-react'
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
import { useAppTranslation, type Locale } from '../../i18n'

const THEME_OPTIONS: { value: Theme; icon: typeof Sun }[] = [
  { value: 'dark', icon: Moon },
  { value: 'light', icon: Sun },
]

const SPACE_TYPES: Exclude<SpaceType, 'personal'>[] = ['team', 'household']
const OVERSIGHT_MODE_OPTIONS: SpaceOversightMode[] = ['none', 'summary', 'content', 'full']

export default function SettingsPage() {
  const { t, locale, setLocale } = useAppTranslation()
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
      toast.success(t('settings.created', { name: space.name }))
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
          <h1 className="text-xl font-semibold tracking-tight">{t('settings.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('settings.subtitle')}</p>
        </div>
      </div>

      {/* Model providers */}
      <Card>
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-3.5" /> {t('settings.account_security')}</CardTitle>
        <p className="text-sm text-muted-foreground mb-3">{t('settings.account_security_description')}</p>
        <Button asChild variant="outline" size="sm"><Link to="/settings/security">{t('settings.open_security')}</Link></Button>
      </Card>

      {/* Model providers */}
      <Card>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-3.5" /> {t('settings.model_providers')}
        </CardTitle>
        <p className="text-sm text-muted-foreground mb-3">
          {t('settings.model_providers_description')}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/providers">{t('settings.open_model_providers')}</Link>
        </Button>
      </Card>

      {/* Token usage */}
      <Card>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="size-3.5" /> {t('settings.usage')}
        </CardTitle>
        <p className="text-sm text-muted-foreground mb-3">
          {t('settings.usage_description')}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/usage">{t('settings.open_usage')}</Link>
        </Button>
      </Card>

      {/* Appearance */}
      <Card>
        <CardTitle className="flex items-center gap-2">
          <Sun className="size-3.5" /> {t('settings.appearance')}
        </CardTitle>
        <div className="grid grid-cols-2 gap-2">
          {THEME_OPTIONS.map(({ value, icon: Icon }) => (
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
                <div className="text-[13px] font-medium leading-none">{t(`settings.${value}`)}</div>
                <div className="text-[11px] mt-1 text-muted-foreground">{t(`settings.${value}_description`)}</div>
              </div>
              {theme === value && (
                <span className="ml-auto w-2 h-2 rounded-full shrink-0" style={{ background: 'var(--primary)' }} />
              )}
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <CardTitle className="flex items-center gap-2"><Globe className="size-3.5" /> {t('settings.language')}</CardTitle>
        <p className="text-sm text-muted-foreground mb-3">{t('settings.language_description')}</p>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('settings.language')}>
          {([{ value: 'en', key: 'english' }, { value: 'zh-CN', key: 'chinese' }] as const satisfies readonly { value: Locale; key: string }[]).map(option => (
            <button
              key={option.value}
              type="button"
              aria-pressed={locale === option.value}
              onClick={() => setLocale(option.value)}
              className={cn(
                'rounded-lg border p-3 text-left text-[13px] transition-colors',
                locale === option.value ? 'border-primary/50 bg-primary/8 text-foreground' : 'border-border hover:bg-accent text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`settings.${option.key}`)}
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
              <Plus className="size-3.5" /> {t('settings.create_space')}
            </CardTitle>
            <form onSubmit={handleCreateSpace} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="space-name">{t('settings.space_name')}</Label>
                <Input
                  id="space-name"
                  value={newSpaceName}
                  onChange={e => setNewSpaceName(e.target.value)}
                  placeholder={t('settings.space_name_placeholder')}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                {SPACE_TYPES.map(typeOption => (
                  <button
                    key={typeOption}
                    type="button"
                    onClick={() => setNewSpaceType(typeOption)}
                    className={cn(
                      'flex flex-col gap-1 p-3 rounded-lg border text-left transition-colors',
                      newSpaceType === typeOption
                        ? 'border-primary/50 bg-primary/8 text-foreground'
                        : 'border-border hover:bg-accent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <span className="text-[13px] font-medium">{t(`settings.${typeOption === 'household' ? 'family' : typeOption}`)}</span>
                    <span className="text-[11px]">{t(`settings.${typeOption === 'household' ? 'family' : typeOption}_description`)}</span>
                  </button>
                ))}
              </div>
              <div className="space-y-1.5">
                <Label>{t('settings.oversight_mode')}</Label>
                <p className="text-[11px] text-muted-foreground">
                  {t('settings.oversight_description')}
                </p>
                <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('settings.oversight_mode')}>
                  {OVERSIGHT_MODE_OPTIONS.map(mode => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setNewSpaceOversightMode(mode)}
                      className={cn(
                        'flex flex-col gap-1 p-3 rounded-lg border text-left transition-colors',
                        newSpaceOversightMode === mode
                          ? 'border-primary/50 bg-primary/8 text-foreground'
                          : 'border-border hover:bg-accent text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <span className="text-[13px] font-medium">{t(`settings.oversight_${mode}`)}</span>
                      <span className="text-[11px]">{t(`settings.oversight_${mode}_description`)}</span>
                    </button>
                  ))}
                </div>
              </div>
              <Button type="submit" size="sm" disabled={!newSpaceName.trim() || creating}>
                {creating ? t('settings.creating') : t('settings.create_space')}
              </Button>
            </form>
          </Card>

        </>
      ) : null}
    </div>
  )
}
