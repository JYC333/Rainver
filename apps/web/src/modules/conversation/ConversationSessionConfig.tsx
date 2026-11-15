import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, SlidersHorizontal, Zap } from 'lucide-react'
import type { RuntimeSessionConfigOption, RuntimeSessionConfigSelection } from '../../types/api'
import { Select } from '../../components/ui/select'
import { Button } from '../../components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '../../components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs'
import { cn } from '../../lib/utils'
import { useAppTranslation } from '../../i18n'

export type SessionConfigSelection = RuntimeSessionConfigSelection

/** Selection order and catalog metadata do not change the submitted choices. */
export function sessionConfigKey(value: SessionConfigSelection[]): string {
  return JSON.stringify(value.map(({ id, type, value }) => [id, type, value])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))))
}

export function ConversationSessionConfig({
  options,
  value,
  onChange,
  disabled,
  compact = false,
}: {
  options: RuntimeSessionConfigOption[]
  value: SessionConfigSelection[]
  onChange: (value: SessionConfigSelection[]) => void
  disabled?: boolean
  compact?: boolean
}) {
  const ordered = configurableOptions(options)
    .sort((left, right) => categoryOrder(left.category) - categoryOrder(right.category))
  const setValue = (option: RuntimeSessionConfigOption, next: string | boolean) => {
    onChange([
      ...value.filter(selection => selection.id !== option.id),
      { id: option.id, type: option.type, value: next, category: option.category },
    ])
  }
  return ordered.map(option => {
    const selected = value.find(selection => selection.id === option.id)?.value ?? option.current_value
    if (option.type === 'boolean') {
      const active = typeof selected === 'boolean' ? selected : option.current_value
      const Icon = option.category === 'model_config' ? Zap : SlidersHorizontal
      return (
        <button
          key={option.id}
          type="button"
          role="switch"
          aria-checked={active}
          aria-label={option.name}
          title={option.description ?? option.name}
          disabled={disabled}
          onClick={() => setValue(option, !active)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors disabled:opacity-50',
            active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
          )}
        >
          <Icon className="size-3.5" /> {option.name}
        </button>
      )
    }
    return (
      <div key={option.id} className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      <span className={compact ? 'sr-only' : undefined}>{option.name}</span>
      <Select
        size="sm"
        variant={compact ? 'ghost' : 'default'}
        overlay={compact}
        showChevron={!compact}
        disabled={disabled}
        ariaLabel={option.name}
        className={compact ? 'w-max' : 'max-w-48'}
        value={typeof selected === 'string' ? selected : option.current_value}
        onChange={next => setValue(option, next)}
        options={option.options.map(choice => ({
          value: choice.value,
          label: `${choice.group ? `${choice.group} · ` : ''}${choice.name ?? choice.value}`,
        }))}
      />
      </div>
    )
  })
}

export type AgentSessionConfiguration = {
  id: string
  name: string
  unavailableReason?: string
  options: RuntimeSessionConfigOption[]
  value: SessionConfigSelection[]
  onChange: (value: SessionConfigSelection[]) => void
  onSave?: (value: SessionConfigSelection[], allowQuotaModelSwitch?: boolean) => Promise<void | SessionConfigSelection[]>
  persistedValue?: SessionConfigSelection[]
  allowQuotaModelSwitch?: boolean
  quotaModelSwitchAvailable?: boolean
  draftAllowQuotaModelSwitch?: boolean
  status?: 'saved' | 'unsaved' | 'saving' | 'failed'
  error?: string
  onQuotaChange?: (allow: boolean) => void
  onDiscard?: () => void
  onReload?: () => Promise<void | SessionConfigSelection[]>
  refreshRequired?: boolean
  beforeFirstSend?: boolean
  onModelChange?: (value: SessionConfigSelection[]) => void
  modelPending?: boolean
}

export function SavedConversationSessionConfig({ options, value, onChange, onSave, persistedValue, disabled, allowQuotaModelSwitch = false, quotaModelSwitchAvailable = false, draftAllowQuotaModelSwitch, status: controlledStatus, error: controlledError, onQuotaChange, onDiscard, refreshRequired }: {
  options: RuntimeSessionConfigOption[]
  value: SessionConfigSelection[]
  onChange: (value: SessionConfigSelection[]) => void
  onSave?: (value: SessionConfigSelection[], allowQuotaModelSwitch?: boolean) => Promise<void | SessionConfigSelection[]>
  persistedValue?: SessionConfigSelection[]
  allowQuotaModelSwitch?: boolean
  quotaModelSwitchAvailable?: boolean
  draftAllowQuotaModelSwitch?: boolean
  refreshRequired?: boolean
  status?: AgentSessionConfiguration['status']
  error?: string
  onQuotaChange?: (allow: boolean) => void
  onDiscard?: () => void
  disabled?: boolean
}) {
  const { t } = useAppTranslation()
  const persisted = JSON.stringify({ value: persistedValue ? sessionConfigKey(mergeSessionConfig(options, persistedValue)) : null, allow: allowQuotaModelSwitch })
  const [allowSwitch, setAllowSwitch] = useState(allowQuotaModelSwitch)
  const current = JSON.stringify({ value: sessionConfigKey(value), allow: allowSwitch })
  const [saved, setSaved] = useState(persisted)
  const [progress, setStatus] = useState<'idle' | 'saving' | 'failed'>('idle')
  useEffect(() => { setSaved(persisted); setAllowSwitch(allowQuotaModelSwitch); setStatus('idle') }, [persisted])
  const status = controlledStatus ?? (progress !== 'idle' ? progress : current === saved ? 'saved' : 'unsaved')
  const effectiveAllow = draftAllowQuotaModelSwitch ?? allowSwitch
  const [error, setError] = useState('')
  const stale = withdrawnSelections(options, persistedValue ?? [])
  return <div className="flex flex-wrap items-center gap-2">
    <ConversationSessionConfig options={options} value={value} disabled={disabled || refreshRequired || status === 'saving'}
      onChange={next => { setStatus('idle'); setError(''); onChange(next) }} />
    {quotaModelSwitchAvailable && <label className="flex basis-full items-start gap-2 text-xs text-muted-foreground">
      <input type="checkbox" className="mt-0.5 accent-primary" checked={effectiveAllow} disabled={disabled || refreshRequired || status === 'saving' || !onSave}
        onChange={event => { setAllowSwitch(event.target.checked); onQuotaChange?.(event.target.checked); setStatus('idle'); setError('') }} />
      <span title={t('conversation_ui.session_config.quota_model_switch_hint')}>{t('conversation_ui.session_config.quota_model_switch')}<span className="block">{t('conversation_ui.session_config.quota_consent')}</span></span>
    </label>}
    {status !== 'saved' && <Button type="button" size="sm" variant="outline" disabled={(!refreshRequired && disabled) || !onSave || status === 'saving'}
      onClick={async () => {
        if (!onSave) return
        setStatus('saving'); setError('')
        try {
          if (quotaModelSwitchAvailable) await onSave(value, effectiveAllow)
          else await onSave(value)
          setSaved(current); setStatus('idle')
        }
        catch (failure) { setStatus('failed'); setError(failure instanceof Error ? failure.message : String(failure)) }
      }}>
      {t(status === 'saving' ? 'conversation_ui.session_config.saving' : refreshRequired ? 'conversation_ui.session_config.refresh_saved' : 'conversation_ui.session_config.save')}
    </Button>}
    {onDiscard && !refreshRequired && status !== 'saved' && <Button type="button" size="sm" variant="ghost" disabled={status === 'saving'} onClick={() => { setError(''); setStatus('idle'); onDiscard?.() }}>{t('conversation_ui.session_config.discard')}</Button>}
    {status !== 'saved' && <span role="status" className="text-xs text-muted-foreground">
      {t(`conversation_ui.session_config.${status}`)}
    </span>}
    {(controlledError || error) && <span role="alert" className="text-xs text-destructive">{controlledError || error}</span>}
    {stale.map(selection => (
      <span key={selection.id} role="note" className="basis-full text-xs text-warning">
        {t('conversation_ui.session_config.stale', { option: selection.category ?? selection.id, value: String(selection.value) })}
      </span>
    ))}
  </div>
}

/**
 * Saved choices the runtime no longer offers. The server leaves them at the
 * runtime default on every turn instead of failing it, so the settings say so
 * until a new choice is saved.
 */
function withdrawnSelections(
  options: RuntimeSessionConfigOption[],
  persisted: SessionConfigSelection[],
): SessionConfigSelection[] {
  return persisted.filter(saved => {
    const option = options.find(candidate => candidate.id === saved.id
      && candidate.type === saved.type && candidate.category === saved.category)
    if (!option) return true
    if (option.type === 'boolean') return typeof saved.value !== 'boolean'
    return typeof saved.value !== 'string' || !option.options.some(choice => choice.value === saved.value)
  })
}

/** Shared bounded settings surface; preflight remains mounted while this dialog is closed. */
export function ConversationAgentSessionConfigs({
  agents, disabled, participants, participantCount = agents.length, environment, environmentIssue, open, onOpenChange,
}: {
  agents: AgentSessionConfiguration[]
  disabled?: boolean
  participants?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  participantCount?: number | null
  environment?: ReactNode
  environmentIssue?: string | null
}) {
  const { t } = useAppTranslation()
  const [tab, setTab] = useState('agents')
  useEffect(() => { if (open) setTab('agents') }, [open])
  const pending = agents.some(agent => !agent.beforeFirstSend && agent.status && agent.status !== 'saved')
  const label = participantCount === null ? t('conversation_ui.settings.title') : t('conversation_ui.settings.trigger', { count: participantCount })
  return <Dialog open={open} onOpenChange={next => { if (next) setTab('agents'); onOpenChange?.(next) }}>
    <DialogTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className="h-7 min-w-0 max-w-full gap-1.5 px-2 text-xs" title={label}>
        <SlidersHorizontal className="size-3.5 shrink-0" /><span className="truncate">{label}</span>{pending && <span className="shrink-0 text-warning">{t(agents.some(agent => agent.status === 'failed') ? 'conversation_ui.session_config.failed' : 'conversation_ui.session_config.pending')}</span>}
      </Button>
    </DialogTrigger>
    <DialogContent aria-describedby={undefined} className={cn("flex max-w-xl flex-col overflow-hidden p-4 sm:p-6", (tab === 'environment' || participantCount === 1) ? "max-h-[85dvh]" : "h-[min(36rem,85dvh)]")}>
      <DialogHeader className="shrink-0">
        <DialogTitle>{t('conversation_ui.settings.title')}</DialogTitle>
      </DialogHeader>
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0 self-start">
          <TabsTrigger value="agents">{t('conversation_ui.settings.agents')}</TabsTrigger>
          {environment && <TabsTrigger value="environment">{t('conversation_ui.settings.environment')}</TabsTrigger>}
        </TabsList>
        <TabsContent value="agents" className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden data-[state=inactive]:hidden">
          {environmentIssue && <Button variant="outline" size="sm" className="h-auto shrink-0 whitespace-normal text-left" onClick={() => setTab('environment')}>{environmentIssue}</Button>}
          {pending && <p role="note" className="text-xs text-warning">{t('conversation_ui.session_config.send_guard')}</p>}
          <div className="min-h-0 flex-1">
          {participants ?? <div className="h-full space-y-2 overflow-y-auto overscroll-contain">
            {agents.map(agent => <ConversationAgentConfiguration key={agent.id} agent={agent} disabled={disabled} defaultExpanded={agents.length === 1} />)}
          </div>}
          </div>
        </TabsContent>
        {environment && <TabsContent value="environment" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{environment}</TabsContent>}
      </Tabs>
    </DialogContent>
  </Dialog>
}

/** The model stays mounted; the independent disclosure only reveals other parameters. */
export function ConversationAgentConfiguration({ agent, disabled, actions, defaultExpanded = false }: {
  agent: AgentSessionConfiguration
  disabled?: boolean
  actions?: ReactNode
  defaultExpanded?: boolean
}) {
  const { t } = useAppTranslation()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const modelOptions = agent.options.filter(option => option.category === 'model')
  const otherOptions = agent.options.filter(option => option.category !== 'model')
  const locked = disabled || agent.refreshRequired || agent.status === 'saving'
  return <div data-agent-settings={agent.id} className="space-y-2 rounded-lg border border-border p-2">
    <div className="relative flex items-center gap-2" onClick={event => {
      if (!(event.target as HTMLElement).closest('button, a, input, select, textarea')) setExpanded(!expanded)
    }}>
      <Button className="absolute -inset-2 h-auto w-auto rounded-lg" type="button" size="sm" variant="ghost"
        aria-label={t('conversation_ui.settings.parameters', { agent: agent.name })}
        aria-expanded={expanded} onClick={() => setExpanded(!expanded)} />
      <span title={agent.name} className="relative min-w-0 flex-1 cursor-pointer truncate text-sm font-medium">{agent.name}</span>
      <div className="relative z-10 flex shrink-0 items-center gap-2">
        <ConversationSessionConfig compact options={modelOptions} value={agent.value}
          disabled={locked || (!agent.onSave && !agent.beforeFirstSend)}
          onChange={next => agent.onModelChange ? agent.onModelChange(next) : agent.onChange(next)} />
      </div>
      <div className="relative z-10 shrink-0">{actions}</div>
      <span className="pointer-events-none relative flex h-7 w-6 shrink-0 items-center justify-center">
        <ChevronDown className={cn('size-4', expanded && 'rotate-180')} />
      </span>
    </div>
    {agent.status && agent.status !== 'saved' && !agent.modelPending && <span className="text-xs text-warning">{t(`conversation_ui.session_config.${agent.status}`)}</span>}
    {agent.unavailableReason && <p role="note" className="text-xs text-muted-foreground">{agent.unavailableReason}</p>}
    {withdrawnSelections(agent.options, agent.persistedValue ?? []).filter(item => item.category === 'model').map(item =>
      <p key={item.id} role="note" className="text-xs text-warning">{t('conversation_ui.session_config.stale', {option: item.category, value: String(item.value)})}</p>)}
    {agent.beforeFirstSend && <p className="text-xs text-muted-foreground">{t('conversation_ui.session_config.first_send')}</p>}
    {agent.modelPending && <div className="flex flex-wrap items-center gap-2">
      <span role="status" className="text-xs text-muted-foreground">{t(`conversation_ui.session_config.${agent.status}`)}</span>
      {agent.status === 'failed' && <Button size="sm" variant="outline" disabled={!agent.onSave || (!agent.refreshRequired && disabled)}
        onClick={() => void agent.onSave?.(agent.value).catch(() => {})}>{t(agent.refreshRequired ? 'conversation_ui.session_config.refresh_saved' : 'conversation_ui.preflight.retry')}</Button>}
      {!agent.refreshRequired && <Button size="sm" variant="ghost" disabled={agent.status === 'saving'} onClick={agent.onDiscard}>{t('conversation_ui.session_config.discard')}</Button>}
      {agent.error && <p role="alert" className="basis-full text-xs text-destructive">{agent.error}</p>}
    </div>}
    {expanded && <div className="space-y-3 border-t border-border pt-3">
      {disabled && <p role="note" className="text-xs text-muted-foreground">{t('conversation_ui.settings.frozen')}</p>}
      {(otherOptions.length > 0 || agent.quotaModelSwitchAvailable || (!agent.modelPending && agent.status !== 'saved')) &&
        <SavedConversationSessionConfig {...agent} persistedValue={agent.persistedValue?.filter(item => item.category !== 'model')} error={agent.modelPending ? undefined : agent.error} status={agent.beforeFirstSend ? 'saved' : agent.modelPending ? 'saved' : agent.status} quotaModelSwitchAvailable={!agent.beforeFirstSend && agent.quotaModelSwitchAvailable} options={otherOptions} disabled={locked || agent.modelPending || (!agent.onSave && !agent.beforeFirstSend)} />}
    </div>}
  </div>
}

function defaultSessionConfig(options: RuntimeSessionConfigOption[]): SessionConfigSelection[] {
  return configurableOptions(options).map(option => ({
    id: option.id,
    type: option.type,
    value: option.current_value,
    category: option.category,
  }))
}

export function mergeSessionConfig(
  options: RuntimeSessionConfigOption[],
  persisted: SessionConfigSelection[],
): SessionConfigSelection[] {
  return defaultSessionConfig(options).map(fallback => {
    const option = options.find(candidate => candidate.id === fallback.id)!
    const saved = persisted.find(candidate => candidate.id === fallback.id
      && candidate.type === fallback.type && candidate.category === fallback.category)
    if (!saved) return fallback
    if (option.type === 'boolean') return typeof saved.value === 'boolean' ? saved : fallback
    return typeof saved.value === 'string' && option.options.some(choice => choice.value === saved.value)
      ? saved : fallback
  })
}

function configurableOptions(options: RuntimeSessionConfigOption[]): RuntimeSessionConfigOption[] {
  return options.filter(option => option.type === 'boolean'
    || option.options.some(choice => choice.value === option.current_value))
}

function categoryOrder(category: string | null): number {
  return category === 'model' ? 0
    : category === 'mode' ? 1
      : category === 'thought_level' ? 2
        : category === 'model_config' ? 3 : 4
}
