import { useConversationScope } from './ConversationScope'
import { useEffect, useMemo, useState } from 'react'
import { BookOpen, ChevronDown } from 'lucide-react'
import { WORK_RETRIEVAL_DOMAINS, type WorkRetrievalDomain, type WorkRetrievalSwitch } from '@rainver/protocol'
import { Button } from '../../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { runtimeContextApi, type RetrievalSwitchTarget } from '../../api/client'
import { useAppTranslation } from '../../i18n'

/**
 * The conversation's knowledge-retrieval switch. Off for a new conversation;
 * the person's choice is kept for this conversation on the server. It decides
 * whether turns search the knowledge base on their own. What the person
 * attaches reaches the turn either way.
 */
export function KnowledgeRetrievalToggle({ disabled = false, agentName = null, ...owner }: ({
  /** A direct conversation's Work Context. Null before the conversation exists. */
  scopeId: string | null
} | {
  /** One Room recipient in this Conversation. Null before the Conversation exists. */
  sessionId: string | null
  roomAgentMemberId: string
}) & {
  disabled?: boolean
  /** Names the Agent when the switch belongs to one Room recipient. */
  agentName?: string | null
}) {
  const scopeId = 'scopeId' in owner ? owner.scopeId : null
  const sessionId = 'sessionId' in owner ? owner.sessionId : null
  const roomAgentMemberId = 'roomAgentMemberId' in owner ? owner.roomAgentMemberId : null
  const target = useMemo<RetrievalSwitchTarget | null>(() => (
    scopeId ? { scopeId }
      : sessionId && roomAgentMemberId ? { sessionId, roomAgentMemberId }
        : null
  ), [scopeId, sessionId, roomAgentMemberId])
  const scope = useConversationScope()
  const { t } = useAppTranslation()
  const [state, setState] = useState<WorkRetrievalSwitch | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)

  useEffect(() => {
    setState(null)
    setFailed(false)
    setLoadFailed(false)
    if (!target) return
    let active = true
    runtimeContextApi.retrievalSwitch(target, scope)
      .then(next => { if (active) setState(next) })
      .catch(() => { if (active) setLoadFailed(true) })
    return () => { active = false }
  }, [target, loadAttempt, scope])

  const save = async (enabled: boolean, domains?: WorkRetrievalDomain[]) => {
    if (!target) return
    setSaving(true)
    setFailed(false)
    try {
      setState(await runtimeContextApi.setRetrievalSwitch(target, {
        enabled,
        ...(domains ? { preferred_domains: domains } : {}),
      }, scope))
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const enabled = state?.enabled === true
  const domains = state?.preferred_domains ?? []
  const unavailable = !target || !state || disabled || saving
  // No choice yet means every domain the conversation may search.
  const chosen: WorkRetrievalDomain[] = domains.length === 0 ? [...WORK_RETRIEVAL_DOMAINS] : domains
  const toggleDomain = (domain: WorkRetrievalDomain) => {
    const next = chosen.includes(domain) ? chosen.filter(entry => entry !== domain) : [...chosen, domain]
    // At least one domain stays chosen.
    if (next.length > 0) void save(true, next)
  }

  if (loadFailed && !state) {
    return (
      <div className="flex items-center gap-1 text-xs" role="group" aria-label={t('conversation_retrieval.group')}>
        <span className="text-destructive" role="alert">{t('conversation_retrieval.load_failed')}</span>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setLoadAttempt(attempt => attempt + 1)}>
          {t('conversation_retrieval.retry')}
        </Button>
      </div>
    )
  }

  const label = agentName
    ? t(enabled ? 'conversation_retrieval.agent_on' : 'conversation_retrieval.agent_off', { agent: agentName })
    : t(enabled ? 'conversation_retrieval.on' : 'conversation_retrieval.off')
  const hint = agentName ? t('conversation_retrieval.room_hint', { agent: agentName }) : t('conversation_retrieval.hint')

  return (
    <div className="flex items-center" role="group" aria-label={t('conversation_retrieval.group')}>
      <Button
        type="button"
        size="sm"
        variant={enabled ? 'secondary' : 'ghost'}
        className="h-7 gap-1 px-2 text-xs"
        aria-pressed={enabled}
        disabled={unavailable}
        title={!target ? t('conversation_retrieval.unavailable_until_started') : failed ? t('conversation_retrieval.failed') : hint}
        onClick={() => void save(!enabled)}
      >
        <BookOpen className="size-3.5" />
        {label}
      </Button>
      {enabled && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-1" disabled={unavailable} aria-label={t('conversation_retrieval.domains')}>
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('conversation_retrieval.domains')}</DropdownMenuLabel>
            {WORK_RETRIEVAL_DOMAINS.map(domain => (
              <DropdownMenuCheckboxItem
                key={domain}
                checked={chosen.includes(domain)}
                onSelect={event => event.preventDefault()}
                onCheckedChange={() => toggleDomain(domain)}
              >
                {t(`conversation_retrieval.domain.${domain}`)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {failed && <span className="ml-1 text-xs text-destructive" role="alert">{t('conversation_retrieval.failed')}</span>}
    </div>
  )
}
