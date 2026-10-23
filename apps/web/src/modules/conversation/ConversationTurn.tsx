import { RunModelLabel } from './RunModelLabel'
import { useState } from 'react'
import { AlertTriangle, ChevronRight, CircleHelp, Info, ListChecks } from 'lucide-react'
import type { RunTurn, TurnPart } from '../../types/api'
import { Message, MessageContent, MessageResponse } from '../../components/ai-elements/message'
import {
  Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolState,
} from '../../components/ai-elements/tool'
import {
  Plan, PlanContent, PlanHeader, PlanTitle, PlanTrigger,
} from '../../components/ai-elements/plan'
import { Shimmer } from '../../components/ai-elements/shimmer'
import { ConversationLink as SpaceLink } from './ConversationScope'
import { cn } from '../../lib/utils'
import { useAppTranslation } from '../../i18n'
import { presentConversationParts, presentToolOutput, progressTextIndexes } from './turnPresentation'

/**
 * One Agent turn, in whichever of its four states it is in.
 *
 * Every surface that shows a conversation with an Agent renders through this:
 * the Room page, the Project and Agent chat panels, the notebook panel. The
 * turn arrives as parts (see `@rainver/protocol`), so this does not know or
 * care whether the Agent ran on the server or on a paired machine.
 *
 * The four states are the same bubble, not four components:
 *
 * - **Working** — active/failed steps as they happen, text streaming under them.
 * - **Blocked** — stopped, waiting on the person: an authorization to grant,
 *   a review somebody owes it. Said plainly, because a turn that looks busy
 *   while it is actually waiting on you is the worst of the four.
 * - **Done** — the reply is the bubble; the steps fold into one line above it.
 * - **Failed** — the same bubble carries the failure; failed and diagnostic
 *   steps stay open.
 *
 * Nothing about a Run is shown as a trailing action in the conversation. A
 * blocked turn can still link directly to the decision it needs from the
 * person, because that link is part of resolving the turn rather than debug
 * navigation.
 *
 * `action_preview` parts are deliberately not rendered. Both surfaces show a
 * Proposal from the assistant message's own record instead, which is what
 * survives a reload and what carries the live reconciliation against the
 * Proposal's real status. Rendering the part as well would put the same
 * decision on screen twice, with the copy that has no live status on top.
 */
export function ConversationTurn({
  turn,
  runHref,
  className,
}: {
  turn: RunTurn
  /**
   * Where the blocked-state action goes, when this surface has somewhere to
   * send it. Space-relative: every in-space destination lives under
   * `/spaces/:id/`.
   */
  runHref?: string
  className?: string
}) {
  const presentedParts = presentConversationParts(turn.parts)
  const { t } = useAppTranslation()
  const steps = presentedParts.filter(isStep)
  // Use the full chronology: completed tools are hidden in the conversation,
  // but still delimit progress updates from the closing response.
  const progress = progressTextIndexes(turn.parts)
  const workCount = steps.length + progress.size
  const working = turn.state === 'working'
  const blocked = turn.state === 'blocked'
  // Finished work folds away; failed and blocked work does not, because it is
  // the explanation. A turn still running shows its steps because they are
  // what is happening.
  const [showWork, setShowWork] = useState(false)
  const stepsOpen = working || blocked || turn.state === 'failed' || showWork
  return (
    <Message from="assistant" className={cn('gap-1.5', className)}>
      <MessageContent className="w-full gap-2">
        <RunModelLabel model={turn.model_selection} />
        {/*
          Offered whenever the work *can* be folded — which is once the turn
          is over and went well. While it runs, and when it failed, the steps
          are the point and there is nothing to fold.
        */}
        {workCount > 0 && !working && !blocked && turn.state !== 'failed' && (
          <button
            type="button"
            aria-expanded={showWork}
            onClick={() => setShowWork(current => !current)}
            className="flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('size-3 transition-transform', showWork && 'rotate-90')} />
            <span>{showWork ? t('conversation_ui.turn.hide_work') : t('conversation_ui.turn.show_work', { count: workCount })}</span>
          </button>
        )}

        <div className="flex flex-col gap-0.5">
          {presentedParts.map(part => {
            if (part.type === 'text') {
              if (progress.has(part.index)) {
                if (!stepsOpen) return null
                return <div key={part.index} className="my-1 border-l-2 border-border pl-3 text-sm text-muted-foreground">
                  <MessageResponse>{part.text}</MessageResponse>
                </div>
              }
              return <MessageResponse key={part.index}>{part.text}</MessageResponse>
            }
            if (part.type === 'action_preview' || part.type === 'reasoning' || !stepsOpen) return null
            return <TurnStep key={part.index} part={part} />
          })}
        </div>

        {turn.state === 'failed' && (
          <span className="flex w-fit items-center gap-1.5 text-xs text-destructive">
            <AlertTriangle className="size-3" /> {t('conversation_ui.turn.failed')}
          </span>
        )}

        {blocked && (
          <div className="flex items-center gap-2 rounded-md bg-warning/10 px-2 py-1.5 text-xs text-foreground">
            <AlertTriangle className="size-3 shrink-0" />
            <span>
              {turn.blocked_on === 'authorization'
                ? t('conversation_ui.turn.blocked_authorization')
                : turn.blocked_on === 'quota' ? t('conversation_ui.turn.blocked_quota')
                : turn.blocked_on === 'workspace'
                  ? t('conversation_ui.turn.blocked_workspace')
                  : t('conversation_ui.turn.blocked_decision')}
            </span>
            {/*
              Somewhere to act. A turn that says it is waiting on you and does
              not say where to go is worse than one that says nothing. A turn
              waiting for its directory needs nobody: it starts on its own.
            */}
            {runHref && turn.blocked_on !== 'workspace' && (
              <SpaceLink to={runHref} className="underline underline-offset-2">
                {turn.blocked_on === 'authorization' ? t('conversation_ui.turn.review_request') : t('conversation_ui.turn.resolve_run')}
              </SpaceLink>
            )}
          </div>
        )}

        {/*
          Shown for as long as the turn is running, not only before it has
          said anything: a reply that has stopped growing and a reply that is
          still arriving look identical without it.
        */}
        {working && <Shimmer className="text-sm">{t('conversation_ui.turn.working')}</Shimmer>}
      </MessageContent>
    </Message>
  )
}

/**
 * Under a reply that is a question for the person (`awaiting_answer`): the
 * runtime asked mid-turn, the turn ended on it, and the answer is the next
 * message. Done, not blocked — nothing is held open waiting for it.
 */
export function AwaitingAnswerMarker() {
  const { t } = useAppTranslation()
  return (
    <span className="mt-1 flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
      <CircleHelp className="size-3" /> {t('conversation_ui.turn.awaiting_answer')}
    </span>
  )
}

/** A part that is work rather than what the Agent said. */
type StepPart = Extract<TurnPart, { type: 'tool_call' | 'plan' | 'diagnostic' }>

function isStep(part: TurnPart): part is StepPart {
  return part.type === 'tool_call' || part.type === 'plan' || part.type === 'diagnostic'
}

function TurnStep({ part }: { part: StepPart }) {
  const { t } = useAppTranslation()
  if (part.type === 'plan') {
    return (
      <Plan defaultOpen className="mb-0 rounded border-0 p-0">
        <PlanHeader className="mb-0 min-h-7 flex-row items-center gap-1.5 px-1.5">
          <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
          <PlanTitle className="text-xs font-normal normal-case tracking-normal">{t('conversation_ui.turn.plan')}</PlanTitle>
          <PlanTrigger className="ml-auto size-7 [&_svg]:size-3.5" />
        </PlanHeader>
        <PlanContent className="ml-5 space-y-1 px-1.5 pb-1 text-xs text-muted-foreground">
          {part.entries.map((entry, index) => (
            <div key={index} className={entry.status === 'completed' ? 'line-through opacity-60' : undefined}>
              {entry.content}
            </div>
          ))}
        </PlanContent>
      </Plan>
    )
  }

  if (part.type === 'diagnostic') {
    return (
      <div className={cn(
        'flex min-h-7 items-center gap-1.5 rounded px-1.5 py-1 text-xs',
        part.level === 'error'
          ? 'bg-destructive/10 text-destructive'
          : 'text-muted-foreground',
      )}>
        {part.level === 'error'
          ? <AlertTriangle className="size-3.5 shrink-0" />
          : <Info className="size-3.5 shrink-0" />}
        <span className="whitespace-pre-wrap break-words">{diagnosticText(part, t)}</span>
      </div>
    )
  }

  const result = presentToolOutput(part.output)
  // A nonzero process exit is evidence for the Agent to interpret. It does
  // not, by itself, establish a failed turn or an inability to run the tool.
  const nonzeroExit = part.status === 'failed' && result.exitCode !== null && result.exitCode !== 0
  const expandable = part.input !== null || part.output !== null || part.status === 'failed'
  return (
    <Tool>
      <ToolHeader
        type={part.name}
        state={toolState(part.status)}
        title={part.name}
        kind={part.kind}
        expandable={expandable}
        statusIndicator={nonzeroExit ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <Info className="size-3" /> {t('conversation_ui.turn.exit_code', { code: result.exitCode })}
          </span>
        ) : undefined}
      />
      {expandable && (
        <ToolContent>
          {part.input !== null && <ToolInput input={part.input} />}
          {nonzeroExit && <p className="text-xs text-muted-foreground">{t('conversation_ui.turn.nonzero_exit')}</p>}
          {part.status === 'failed' && !nonzeroExit && <p className="text-xs text-destructive">{t('conversation_ui.turn.tool_failed')}</p>}
          {result.exitCode !== null && !nonzeroExit && <p className="text-xs text-muted-foreground">{t('conversation_ui.turn.exit_code', { code: result.exitCode })}</p>}
          {result.truncated && <p className="text-xs text-muted-foreground">{t('conversation_ui.turn.output_truncated')}</p>}
          {(part.output !== null || part.status === 'failed') && (
            <ToolOutput
              output={result.text || t('conversation_ui.turn.no_output')}
              errorText={undefined}
              label={t('conversation_ui.turn.tool_output')}
            />
          )}
        </ToolContent>
      )}
    </Tool>
  )
}

/**
 * Diagnostics the server reports as a code rather than prose, worded in the
 * reader's language. Any other diagnostic is the runtime's own text.
 */
const LOCALIZED_DIAGNOSTIC_KEYS: Record<string, string> = {
  run_quiet: 'conversation_ui.turn.run_quiet',
}

function diagnosticText(part: Extract<TurnPart, { type: 'diagnostic' }>, t: (key: string) => string): string {
  const key = part.error_code ? LOCALIZED_DIAGNOSTIC_KEYS[part.error_code] : undefined
  return key ? t(key) : part.text
}

function toolState(status: 'pending' | 'running' | 'succeeded' | 'failed'): ToolState {
  if (status === 'pending') return 'input-streaming'
  if (status === 'running') return 'input-available'
  return status === 'failed' ? 'output-error' : 'output-available'
}
