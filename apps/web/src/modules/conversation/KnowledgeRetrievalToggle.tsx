import { useEffect, useState } from 'react'
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
import { runtimeContextApi } from '../../api/client'
import { useAppTranslation } from '../../i18n'

/**
 * The conversation's knowledge-retrieval switch. Off for a new conversation;
 * the person's choice is kept for this conversation on the server. It decides
 * whether turns search the knowledge base on their own. What the person
 * attaches reaches the turn either way.
 */
export function KnowledgeRetrievalToggle({ scopeId, disabled = false }: {
  /** The conversation; null before it exists, when the switch cannot be kept yet. */
  scopeId: string | null
  disabled?: boolean
}) {
  const { t } = useAppTranslation()
  const [state, setState] = useState<WorkRetrievalSwitch | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setState(null)
    setFailed(false)
    if (!scopeId) return
    let active = true
    runtimeContextApi.retrievalSwitch(scopeId)
      .then(next => { if (active) setState(next) })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [scopeId])

  const save = async (enabled: boolean, domains?: WorkRetrievalDomain[]) => {
    if (!scopeId) return
    setSaving(true)
    setFailed(false)
    try {
      setState(await runtimeContextApi.setRetrievalSwitch(scopeId, {
        enabled,
        ...(domains ? { preferred_domains: domains } : {}),
      }))
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const enabled = state?.enabled === true
  const domains = state?.preferred_domains ?? []
  const unavailable = !scopeId || !state || disabled || saving
  // No choice yet means every domain the conversation may search.
  const chosen: WorkRetrievalDomain[] = domains.length === 0 ? [...WORK_RETRIEVAL_DOMAINS] : domains
  const toggleDomain = (domain: WorkRetrievalDomain) => {
    const next = chosen.includes(domain) ? chosen.filter(entry => entry !== domain) : [...chosen, domain]
    // At least one domain stays chosen.
    if (next.length > 0) void save(true, next)
  }

  return (
    <div className="flex items-center" role="group" aria-label={t('conversation_retrieval.group')}>
      <Button
        type="button"
        size="sm"
        variant={enabled ? 'secondary' : 'ghost'}
        className="h-7 gap-1 px-2 text-xs"
        aria-pressed={enabled}
        disabled={unavailable}
        title={!scopeId ? t('conversation_retrieval.unavailable_until_started') : failed ? t('conversation_retrieval.failed') : t('conversation_retrieval.hint')}
        onClick={() => void save(!enabled)}
      >
        <BookOpen className="size-3.5" />
        {enabled ? t('conversation_retrieval.on') : t('conversation_retrieval.off')}
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
