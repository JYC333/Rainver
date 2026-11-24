import { useEffect, useRef, useState } from 'react'
import type { GmailApplicationExecutionConfiguration, GmailApplicationExecutionOptions } from '@rainver/protocol'
import { gmailApi } from '../../../api/gmail'
import { Button } from '../../../components/ui/button'
import { Select } from '../../../components/ui/select'
import { useAppTranslation } from '../../../i18n'
import { errMsg } from '../../../lib/utils'

/**
 * What the card around this choice needs: whether the choice applies, whether the saved choice is the one shown on both
 * levels (accepting needs it), the card's current text, the revision this choice shows (accepting names it, so what is
 * accepted is what is shown), and whether a choice is still being saved (nothing is accepted meanwhile).
 */
export interface GmailApplicationExecutionState { applies: boolean; selected: boolean; summary: string | null; revision: string | null; saving: boolean }

/**
 * Whether the card around the choice can be accepted now: it has loaded, shows its revision, saves nothing, and — when it
 * sets up application updates — shows its saved configuration and model on both levels. Every decision entry (the
 * conversation card and the Proposal detail) asks this one question.
 */
export const gmailApplicationExecutionAcceptable = (state: GmailApplicationExecutionState | null): boolean =>
  Boolean(state && state.revision && !state.saving && (!state.applies || state.selected))

const configKey = (c: Pick<GmailApplicationExecutionConfiguration, 'agent_id' | 'runtime_profile_id'>) => `${c.agent_id}|${c.runtime_profile_id ?? ''}`
const savedConfig = (out: GmailApplicationExecutionOptions) => (out.selected ? configKey(out.selected) : null)
/**
 * The card's state for its decision entry: its saved choice counts as shown only while its configuration is the one on
 * the first level and its model is listed there — never a choice the owner cannot see.
 */
const stateOf = (out: GmailApplicationExecutionOptions, shownConfig: string | null, saving = false): GmailApplicationExecutionState => {
  const saved = out.selected
  const config = saved && shownConfig === configKey(saved)
    ? out.configurations.find(c => c.available && configKey(c) === shownConfig) : undefined
  return {
    applies: out.applies,
    selected: Boolean(saved && config?.models.some(m => m.model === saved.model)),
    summary: out.summary, revision: out.card_revision, saving,
  }
}
/**
 * `extra` added to `base` without repeating anything: a configuration not yet listed is appended; one already listed gains
 * the models it did not list yet, and — when `extra` is that configuration's next models (`models_of`) — where its models
 * continue. When the server restarted those models (`models_restarted`: the model the page continued after is gone, so no
 * place is known to follow what was shown), they replace that configuration's models instead, so nothing is skipped or
 * left counted twice. The configurations themselves are live facts, the same for every revision of the card.
 */
function mergeConfigurations(base: GmailApplicationExecutionConfiguration[], extra: GmailApplicationExecutionConfiguration[], modelsPage: 'more' | 'restarted' | null) {
  const out = base.map(c => ({ ...c }))
  for (const entry of extra) {
    const known = out.find(c => configKey(c) === configKey(entry))
    if (!known) { out.push(entry); continue }
    const seen = new Set(known.models.map(m => m.model))
    known.models = modelsPage === 'restarted' ? entry.models : [...known.models, ...entry.models.filter(m => !seen.has(m.model))]
    if (modelsPage) { known.models_cursor = entry.models_cursor; known.omitted_models = entry.omitted_models }
  }
  return out
}

/**
 * ADR 0036, 0037: on the owner's own pending application-update card (or combined card), what it covers — the mailbox,
 * what is read, what may change, who reads the results — and what it runs on, chosen in two levels from what the owner's
 * own conversation offers: first a configuration (an Agent with one of its runtime profiles), then one of the models its
 * picker offers. A configuration that cannot run it is listed once with its reason. Choosing another configuration clears the model shown and keeps the card unacceptable until a
 * model of it is saved and the card answers with its revision. A model choice is rechecked by the server and redraws the
 * card; nothing runs until the owner accepts, and acceptance rechecks it again against the revision shown here.
 * Only the latest request's answer is shown: an earlier load or choice answering late never replaces a newer one.
 * `reloadKey` reloads the card as it stands now (after a refused acceptance, e.g. a choice made in another tab).
 * The configurations come in pages (the Project's Assistant always on the first), and a configuration's models too: "Show
 * more" appends the next page or the next models, so everything is listed and chosen here. While anything loads or saves
 * the card cannot be accepted. A page answered for another revision of the card (a choice saved in another tab) brings the
 * card's revision, saved choice and text as they stand, and never undoes the owner's unsaved switch of configuration; the
 * saved choice is shown — and so acceptable — only while it is listed.
 */
export function GmailApplicationExecutionChoice({ proposalId, scope, onState, reloadKey = 0 }: {
  proposalId: string
  scope: { spaceId?: string; signal?: AbortSignal }
  onState: (state: GmailApplicationExecutionState) => void
  reloadKey?: number
}) {
  const { t } = useAppTranslation()
  const [options, setOptionsState] = useState<GmailApplicationExecutionOptions | null>(null)
  // The configuration shown on the first level: the saved one, or another the owner picked whose model is not saved yet.
  const [shownConfig, setShownState] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadingModels, setLoadingModels] = useState<string | null>(null)
  const latest = useRef(0)
  // What is shown now, read by answers that arrive later (their closures would hold what was shown when they were sent).
  const optionsRef = useRef<GmailApplicationExecutionOptions | null>(null)
  const shownRef = useRef<string | null>(null)
  const loads = useRef(0)
  const setOptions = (out: GmailApplicationExecutionOptions) => { optionsRef.current = out; setOptionsState(out) }
  const setShown = (value: string | null) => { shownRef.current = value; setShownState(value) }
  /** Tells the card what it can decide now; `busy` while anything loads or saves, so nothing is accepted meanwhile. */
  const report = (busy: boolean) => { if (optionsRef.current) onState(stateOf(optionsRef.current, shownRef.current, busy)) }

  /** The card as the server answered it now: its saved choice is shown on both levels. */
  const showCard = (out: GmailApplicationExecutionOptions) => {
    setOptions(out)
    setShown(savedConfig(out))
    onState(stateOf(out, savedConfig(out)))
  }
  const unknown = () => onState({ applies: true, selected: false, summary: null, revision: null, saving: false })

  useEffect(() => {
    const request = ++latest.current
    setLoadFailed(false)
    // A reload: what was shown cannot be accepted until the card answers again.
    report(true)
    gmailApi.applicationExecutionOptions(proposalId, scope).then(out => {
      if (request === latest.current) showCard(out)
    }).catch(() => {
      if (request !== latest.current) return
      setLoadFailed(true)
      unknown()
    })
    return () => { if (request === latest.current) latest.current += 1 }
    // onState is the parent's setter; reloading on its identity would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposalId, scope, reloadKey])

  if (loadFailed) return <p className="mt-2 text-xs text-destructive">{t('gmail_ui.execution.load_failed')}</p>
  if (!options) return <p className="mt-2 text-xs text-muted-foreground">{t('gmail_ui.execution.loading')}</p>
  if (!options.applies || !options.scope) return null

  const available = options.configurations.filter(c => c.available)
  const unavailable = options.configurations.filter(c => !c.available)
  const configLabel = (c: GmailApplicationExecutionConfiguration) => {
    const agent = c.agent_kind === 'system_assistant' ? t('gmail_ui.execution.assistant', { name: c.agent_name }) : c.agent_name
    return c.profile_name ? t('gmail_ui.execution.configuration_item', { agent, profile: c.profile_name }) : agent
  }
  const current = available.find(c => configKey(c) === shownConfig) ?? null
  const busy = saving || loadingMore || loadingModels !== null
  const savedHere = current !== null && savedConfig(options) === shownConfig
  const chooseConfig = (value: string) => {
    if (saving || value === shownConfig) return
    setShown(value)
    setError(null)
    // Another configuration shows no model until one of it is saved: the card cannot be accepted meanwhile.
    report(loads.current > 0)
  }
  const chooseModel = async (model: string) => {
    if (saving || !current?.runtime_profile_id || !current.models.some(m => m.model === model)) return
    const request = ++latest.current
    setSaving(true); setError(null)
    // Accepting waits until the server has redrawn the card for this choice.
    report(true)
    try {
      const out = await gmailApi.selectApplicationExecution(proposalId,
        { agent_id: current.agent_id, runtime_profile_id: current.runtime_profile_id, model }, crypto.randomUUID(), scope)
      if (scope.signal?.aborted || request !== latest.current) return
      showCard(out)
    } catch (failure) {
      if (request !== latest.current) return
      setError(t('gmail_ui.execution.save_failed', { error: errMsg(failure) }))
      // What the card holds now is unknown: show it as it stands before anything is accepted.
      unknown()
      const reload = ++latest.current
      await gmailApi.applicationExecutionOptions(proposalId, scope).then(out => {
        if (reload === latest.current) showCard(out)
      }).catch(() => { if (reload === latest.current) unknown() })
    } finally {
      setSaving(false)
    }
  }
  /**
   * More of the card: its next page of configurations, or one configuration's next models. The answer is added to what is
   * shown now (read when it arrives), never replacing the owner's unsaved switch; it carries the card as it stands, and
   * when that card's saved choice is not listed yet the first page — which always lists it — is added too.
   */
  const loadMore = async (page: string | { agent_id: string; runtime_profile_id: string; models_cursor: string }, done: () => void) => {
    const request = latest.current
    const modelsPage = typeof page !== 'string'
    loads.current += 1
    report(true)
    try {
      const more = await gmailApi.applicationExecutionOptions(proposalId, scope, page)
      if (scope.signal?.aborted || request !== latest.current) return
      const { models_restarted: restarted, ...card } = more
      let merged: GmailApplicationExecutionOptions = {
        ...card,
        configurations: mergeConfigurations(optionsRef.current!.configurations, more.configurations, modelsPage ? (restarted ? 'restarted' : 'more') : null),
        next_cursor: modelsPage ? optionsRef.current!.next_cursor : more.next_cursor,
      }
      if (merged.selected && !stateOf(merged, savedConfig(merged)).selected) {
        const first = await gmailApi.applicationExecutionOptions(proposalId, scope)
        if (scope.signal?.aborted || request !== latest.current) return
        merged = { ...first, configurations: mergeConfigurations(merged.configurations, first.configurations, null), next_cursor: merged.next_cursor }
      }
      // Judged when the answer is applied, against what is shown now: a switch the owner made while any of it was loading
      // (the first page above, too) is theirs and is kept; only a card showing its saved choice follows the answer's.
      const shown = optionsRef.current!
      const switched = shownRef.current !== savedConfig(shown)
      setOptions(merged)
      setShown(switched ? shownRef.current : savedConfig(merged))
    } catch (failure) {
      if (request === latest.current) setError(t(modelsPage ? 'gmail_ui.execution.more_models_failed' : 'gmail_ui.execution.more_failed', { error: errMsg(failure) }))
    } finally {
      loads.current -= 1
      done()
      if (request === latest.current) report(loads.current > 0)
    }
  }
  const showMore = () => {
    if (saving || loadingMore || !options.next_cursor) return
    setLoadingMore(true)
    void loadMore(options.next_cursor, () => setLoadingMore(false))
  }
  const showMoreModels = () => {
    if (saving || loadingModels !== null || !current?.runtime_profile_id || !current.models_cursor) return
    const key = configKey(current)
    setLoadingModels(key)
    void loadMore({ agent_id: current.agent_id, runtime_profile_id: current.runtime_profile_id, models_cursor: current.models_cursor }, () => setLoadingModels(null))
  }
  const s = options.scope
  const facts = s.effects.map(effect => t(`gmail_ui.execution.effects.${effect}`)).join(t('gmail_ui.execution.list_separator'))
  const where = s.results_to === 'mainline' ? t('gmail_ui.execution.where_mainline')
    : s.room_title ? t('gmail_ui.execution.where_room', { title: s.room_title }) : t('gmail_ui.execution.where_room_untitled')
  const readers = s.reader_names.join(t('gmail_ui.execution.list_separator'))
    + (s.reader_count > s.reader_names.length ? t('gmail_ui.execution.more_readers', { count: s.reader_count - s.reader_names.length }) : '')
  const models = current?.models ?? []
  // The saved model is shown only while it is listed: an unlisted choice is never echoed (nor accepted).
  const shownModel = savedHere && models.some(m => m.model === options.selected?.model) ? options.selected?.model ?? '' : ''
  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-card p-3" data-testid="gmail-application-execution">
      <div className="space-y-1">
        <p className="text-xs font-medium">{t('gmail_ui.execution.scope_title')}</p>
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li>{t('gmail_ui.execution.mailbox', { email: s.mailbox_email })}</li>
          <li>{t(s.include_sent ? 'gmail_ui.execution.reads_inbox_and_sent' : 'gmail_ui.execution.reads')}</li>
          <li>{t('gmail_ui.execution.updates', { facts })}</li>
          <li>{s.results_to === 'private' ? t('gmail_ui.execution.results_private') : t('gmail_ui.execution.results_shared', { where, readers })}</li>
        </ul>
      </div>
      <div className="space-y-2">
        {available.length > 0 ? (
          <>
            <div className="space-y-1">
              <p className="text-xs font-medium">{t('gmail_ui.execution.configuration_label')}</p>
              <Select
                size="sm"
                ariaLabel={t('gmail_ui.execution.configuration_label')}
                disabled={saving}
                value={current ? configKey(current) : ''}
                onChange={chooseConfig}
                options={[
                  ...(current ? [] : [{ value: '', label: t('gmail_ui.execution.choose_configuration'), disabled: true }]),
                  ...available.map(c => ({ value: configKey(c), label: configLabel(c) })),
                ]}
              />
            </div>
            {current && (
              <div className="space-y-1">
                <p className="text-xs font-medium">{t('gmail_ui.execution.model_label')}</p>
                <Select
                  size="sm"
                  ariaLabel={t('gmail_ui.execution.model_label')}
                  disabled={saving}
                  value={shownModel}
                  onChange={chooseModel}
                  options={[
                    ...(shownModel ? [] : [{ value: '', label: t('gmail_ui.execution.choose_model'), disabled: true }]),
                    ...models.map(m => ({ value: m.model, label: m.name && m.name !== m.model ? `${m.name} (${m.model})` : m.model })),
                  ]}
                />
                {!savedHere && !saving && <p className="text-xs text-muted-foreground">{t('gmail_ui.execution.model_required')}</p>}
                {current.omitted_models > 0 && <p className="text-xs text-muted-foreground">{t('gmail_ui.execution.omitted_models', { count: current.omitted_models })}</p>}
                {current.models_cursor && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={showMoreModels}>
                    {loadingModels === configKey(current) ? t('gmail_ui.execution.loading_more_models') : t('gmail_ui.execution.show_more_models')}
                  </Button>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t('gmail_ui.execution.none')}</p>
        )}
        <p className="text-xs text-muted-foreground">{saving ? t('gmail_ui.execution.saving') : t('gmail_ui.execution.independent')}</p>
        {options.next_cursor && (
          <Button size="sm" variant="outline" disabled={busy} onClick={showMore}>
            {loadingMore ? t('gmail_ui.execution.loading_more') : t('gmail_ui.execution.show_more')}
          </Button>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      {unavailable.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium">{t('gmail_ui.execution.unavailable_title')}</p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {unavailable.map(c => (
              <li key={configKey(c)}>{t('gmail_ui.execution.unavailable_item', { candidate: configLabel(c), reason: t(`gmail_ui.execution.reasons.${c.reason ?? 'runtime_unavailable'}`) })}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
