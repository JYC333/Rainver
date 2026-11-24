import { ChevronRight } from 'lucide-react'
import type { ToolCallTurnPart, TurnPart } from '../../types/api'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import { ConversationToolStep } from './ConversationToolStep'

export function ConversationSubagents({ parts, toolsByChild, expanded, onExpand, settled }: {
  parts: Extract<TurnPart, { type: 'subagent' }>[]
  toolsByChild: ReadonlyMap<string, ToolCallTurnPart[]>
  expanded: Record<string, boolean>
  onExpand: (id: string, open: boolean) => void
  settled: boolean
}) {
  const { t } = useAppTranslation()

  return (
    <section aria-label={t('conversation_ui.turn.subagents')} className="my-1 min-w-0 rounded border border-border">
      <h4 className="px-2 py-1 text-xs font-medium text-muted-foreground">{t('conversation_ui.turn.subagents')}</h4>
      <ul className="divide-y divide-border border-t border-border">
        {parts.map(part => {
          const disclosureKey = `subagent:${part.key}`
          const open = expanded[disclosureKey] ?? false
          const title = part.title || part.task || t('conversation_ui.turn.subagent')
          const tools = toolsByChild.get(part.key) ?? []
          const inspectable = Boolean(part.task || part.output || tools.length)
          const state = settled && (part.state === 'running' || part.state === 'waiting') ? 'unknown' : part.state
          const label = <>
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <span className="shrink-0 text-muted-foreground">{t(`conversation_ui.turn.subagent_state.${state}`)}</span>
          </>

          return <li key={part.key}>
            {inspectable
              ? <Button variant="ghost" size="sm" data-conversation-disclosure
                  className="flex h-auto min-h-7 w-full justify-start gap-1.5 rounded-none px-2 text-left text-xs"
                  aria-expanded={open} onClick={() => onExpand(disclosureKey, !open)}>
                  <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
                  {label}
                </Button>
              : <div className="flex min-h-7 items-center gap-1.5 px-2 text-xs">{label}</div>}
            {open && inspectable && <div className="min-w-0 space-y-1 break-words px-2 pb-2 pl-7">
              {part.task && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{part.task}</p>}
              {part.output && <p className="whitespace-pre-wrap text-sm">{part.output}</p>}
              {tools.map(tool => <ConversationToolStep key={tool.call_id ?? tool.index}
                part={tool} expanded={expanded} onExpand={onExpand} settled={settled} />)}
            </div>}
          </li>
        })}
      </ul>
    </section>
  )
}
