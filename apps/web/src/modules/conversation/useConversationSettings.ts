import i18n from '../../i18n'
import { useCallback, useRef, useState } from 'react'
import { mergeSessionConfig, sessionConfigKey, type AgentSessionConfiguration, type SessionConfigSelection } from './ConversationSessionConfig'

type Draft = {
  allow?: boolean
  progress?: 'saving' | 'failed'
  error?: string
  refreshRequired?: boolean
  model?: SessionConfigSelection[]
  remainder?: SessionConfigSelection[]
}

/** In-memory drafts and synchronous write guards belong to one conversation lifetime. */
export function useConversationSettings(identity: unknown, keepOpenOnIdentityChange = false) {
  const [state, setState] = useState<{ identity: unknown; drafts: Record<string, Draft> }>({ identity, drafts: {} })
  const [open, setOpen] = useState(false)
  if (state.identity !== identity) {
    setState({ identity, drafts: {} })
    if (!keepOpenOnIdentityChange) setOpen(false)
  }
  const pending = useRef(false)
  const lifetime = useRef({ identity, busy: new Set<string>() })
  if (lifetime.current.identity !== identity) lifetime.current = { identity, busy: new Set() }
  const currentLifetime = lifetime.current
  const update = (id: string, patch: Draft) => setState(previous => lifetime.current === currentLifetime && previous.identity === identity
    ? { identity, drafts: { ...previous.drafts, [id]: { ...previous.drafts[id], ...patch } } } : previous)
  const configure = (agents: AgentSessionConfiguration[]) => {
    const result = agents.map(agent => {
      const draft = state.identity === identity ? state.drafts[agent.id] : undefined
      const baseline = mergeSessionConfig(agent.options, agent.persistedValue ?? [])
      const dirty = sessionConfigKey(agent.value) !== sessionConfigKey(baseline)
        || (draft?.allow ?? agent.allowQuotaModelSwitch ?? false) !== (agent.allowQuotaModelSwitch ?? false)
      const save = async (value: typeof agent.value, allow?: boolean, model?: SessionConfigSelection[]) => {
        if (currentLifetime.busy.has(agent.id)) return
        const modelSelection = model ?? draft?.model
        const remainder = model ? agent.value.filter(item => item.category !== 'model'
          && sessionConfigKey([item]) !== sessionConfigKey(baseline.filter(saved => saved.id === item.id))) : draft?.remainder
        const submitted = modelSelection ? [...baseline.filter(item => item.category !== 'model'), ...modelSelection] : value
        const operation = draft?.refreshRequired ? agent.onReload : agent.onSave
        if (!operation) return
        currentLifetime.busy.add(agent.id)
        pending.current = true
        update(agent.id, { progress: 'saving', error: undefined, model: modelSelection, remainder })
        try {
          const readback = draft?.refreshRequired ? await agent.onReload!()
            : await agent.onSave!(submitted, modelSelection ? undefined : allow)
          if (lifetime.current !== currentLifetime) return
          // The consumer applies the confirmed catalog. Restore only unsaved
          // non-model choices; model autosave never authorizes those drafts.
          if (modelSelection && remainder) {
            const confirmed = mergeSessionConfig(agent.options, readback ?? submitted)
            agent.onChange(confirmed.map(item => remainder.find(local => local.id === item.id) ?? item))
          }
          update(agent.id, { ...(modelSelection ? {} : { allow: undefined }), progress: undefined, refreshRequired: false, model: undefined, remainder: undefined })
        } catch (error) {
          if (lifetime.current === currentLifetime) {
            const committed = draft?.refreshRequired || Boolean((error as { settingsSaved?: boolean })?.settingsSaved)
            update(agent.id, { progress: 'failed', refreshRequired: committed,
              error: committed ? i18n.t('conversation_ui.session_config.saved_refresh_failed') : error instanceof Error ? error.message : String(error) })
          }
          throw error
        } finally { currentLifetime.busy.delete(agent.id) }
      }
      return { ...agent,
        draftAllowQuotaModelSwitch: draft?.allow ?? agent.allowQuotaModelSwitch ?? false,
        status: draft?.progress ?? (dirty ? 'unsaved' : 'saved'),
        error: draft?.error,
        refreshRequired: draft?.refreshRequired,
        modelPending: Boolean(draft?.model),
        onModelChange: (value: typeof agent.value) => {
          if (currentLifetime.busy.has(agent.id) || draft?.refreshRequired) return
          agent.onChange(value)
          if (!agent.beforeFirstSend) void save(value, undefined, value.filter(item => item.category === 'model')).catch(() => {})
        },
        onQuotaChange: (allow: boolean) => update(agent.id, { allow, progress: undefined, error: undefined }),
        onChange: (value: typeof agent.value) => { update(agent.id, { progress: undefined, error: undefined }); agent.onChange(value) },
        onDiscard: () => {
          if (currentLifetime.busy.has(agent.id) || draft?.refreshRequired) return
          if (draft?.model) {
            agent.onChange(baseline.map(item => draft.remainder?.find(local => local.id === item.id) ?? item))
            update(agent.id, { progress: undefined, error: undefined, model: undefined, remainder: undefined })
          } else {
            update(agent.id, { allow: undefined, progress: undefined, error: undefined })
            agent.onChange(baseline)
          }
        },
        onSave: (draft?.refreshRequired ? agent.onReload : agent.onSave) ? save : undefined,
      } satisfies AgentSessionConfiguration
    })
    pending.current = result.some(agent => !agent.beforeFirstSend && agent.status !== 'saved')
    return result
  }
  const beforeSend = useCallback(() => {
    if (!pending.current) return true
    setOpen(true)
    return false
  }, [])
  return { configure, beforeSend, open, onOpenChange: setOpen }
}
