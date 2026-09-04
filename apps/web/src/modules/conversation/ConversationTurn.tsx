import { useState } from 'react'
import { AlertTriangle, ChevronRight, Info, ListChecks } from 'lucide-react'
import type { RunTurn, TurnPart } from '../../types/api'
import { Message, MessageContent, MessageResponse } from '../../components/ai-elements/message'
import {
  Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolState,
} from '../../components/ai-elements/tool'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '../../components/ai-elements/reasoning'
import {
  Plan, PlanContent, PlanHeader, PlanTitle, PlanTrigger,
} from '../../components/ai-elements/plan'
import { Shimmer } from '../../components/ai-elements/shimmer'
import { SpaceLink } from '../../core/spaceNav'
import { cn } from '../../lib/utils'

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
 * - **Working** — the steps as they happen, text streaming under them.
 * - **Blocked** — stopped, waiting on the person: an authorization to grant,
 *   a review somebody owes it. Said plainly, because a turn that looks busy
 *   while it is actually waiting on you is the worst of the four.
 * - **Done** — the reply is the bubble; the steps fold into one line above it.
 * - **Failed** — the same bubble carries the failure; the steps stay open,
 *   because when something went wrong the steps are what explains it.
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
  const steps = turn.parts.filter(isStep)
  const working = turn.state === 'working'
  const blocked = turn.state === 'blocked'
  // Finished work folds away; failed and blocked work does not, because it is
  // the explanation. A turn still running shows its steps because they are
  // what is happening.
  const [showWork, setShowWork] = useState(false)
  const stepsOpen = working || blocked || turn.state === 'failed' || showWork

  return (
    <Message from="assistant" className={cn('gap-1.5', className)}>
      <MessageContent className="gap-2">
        {/*
          Offered whenever the work *can* be folded — which is once the turn
          is over and went well. While it runs, and when it failed, the steps
          are the point and there is nothing to fold.
        */}
        {steps.length > 0 && !working && !blocked && turn.state !== 'failed' && (
          <button
            type="button"
            onClick={() => setShowWork(current => !current)}
            className="flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('size-3 transition-transform', showWork && 'rotate-90')} />
            <span>{showWork ? 'hide work' : `show work (${steps.length} step${steps.length === 1 ? '' : 's'})`}</span>
          </button>
        )}

        <div className="flex flex-col gap-0.5">
          {turn.parts.map(part => {
            if (part.type === 'text') {
              return <MessageResponse key={part.index}>{part.text}</MessageResponse>
            }
            if (part.type === 'action_preview' || !stepsOpen) return null
            return <TurnStep key={part.index} part={part} />
          })}
        </div>

        {turn.state === 'failed' && (
          <span className="flex w-fit items-center gap-1.5 text-xs text-destructive">
            <AlertTriangle className="size-3" /> Could not complete
          </span>
        )}

        {blocked && (
          <div className="flex items-center gap-2 rounded-md bg-warning/10 px-2 py-1.5 text-xs text-foreground">
            <AlertTriangle className="size-3 shrink-0" />
            <span>{turn.blocked_on === 'authorization' ? 'approval needed' : 'waiting for a decision'}</span>
            {/*
              Somewhere to act. A turn that says it is waiting on you and does
              not say where to go is worse than one that says nothing.
            */}
            {runHref && (
              <SpaceLink to={runHref} className="underline underline-offset-2">
                {turn.blocked_on === 'authorization' ? 'Review request' : 'Resolve Run'}
              </SpaceLink>
            )}
          </div>
        )}

        {/*
          Shown for as long as the turn is running, not only before it has
          said anything: a reply that has stopped growing and a reply that is
          still arriving look identical without it.
        */}
        {working && <Shimmer className="text-sm">Working…</Shimmer>}
      </MessageContent>
    </Message>
  )
}

/** A part that is work rather than what the Agent said. */
type StepPart = Extract<TurnPart, { type: 'tool_call' | 'reasoning' | 'plan' | 'diagnostic' }>

function isStep(part: TurnPart): part is StepPart {
  return part.type === 'tool_call' || part.type === 'reasoning'
    || part.type === 'plan' || part.type === 'diagnostic'
}

function TurnStep({ part }: { part: StepPart }) {
  if (part.type === 'reasoning') {
    return (
      <Reasoning className="mb-0">
        <ReasoningTrigger className="min-h-7 gap-1.5 rounded px-1.5 text-xs [&_svg]:size-3.5" />
        <ReasoningContent className="ml-5 mt-1.5 px-1.5">{part.text}</ReasoningContent>
      </Reasoning>
    )
  }

  if (part.type === 'plan') {
    return (
      <Plan defaultOpen className="mb-0 rounded border-0 p-0">
        <PlanHeader className="mb-0 min-h-7 flex-row items-center gap-1.5 px-1.5">
          <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
          <PlanTitle className="text-xs font-normal normal-case tracking-normal">Plan</PlanTitle>
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
        <span className="whitespace-pre-wrap break-words">{part.text}</span>
      </div>
    )
  }

  const expandable = part.input !== null || part.output !== null
  return (
    <Tool>
      <ToolHeader
        type={part.name}
        state={toolState(part.status)}
        title={part.name}
        kind={part.kind}
        expandable={expandable}
      />
      {expandable && (
        <ToolContent>
          {part.input !== null && <ToolInput input={part.input} />}
          {part.output !== null && (
            <ToolOutput
              output={part.status === 'failed' ? null : part.output}
              errorText={part.status === 'failed' ? part.output : undefined}
            />
          )}
        </ToolContent>
      )}
    </Tool>
  )
}

function toolState(status: 'pending' | 'running' | 'succeeded' | 'failed'): ToolState {
  if (status === 'pending') return 'input-streaming'
  if (status === 'running') return 'input-available'
  return status === 'failed' ? 'output-error' : 'output-available'
}
