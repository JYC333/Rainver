import { lazy, Suspense } from 'react'
import { Check, Circle, FileSearch, Info, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { ToolCallTurnPart } from '../../types/api'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolState } from '../../components/ai-elements/tool'
import { LocalMarkdownLink } from '../../components/ai-elements/markdownFileContext'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import { useTheme } from '../../contexts/ThemeContext'
import { useAppTranslation } from '../../i18n'
import { presentToolOutput } from './turnPresentation'

const CodeMirrorMerge = lazy(() => import('../project_files/CodeMirrorEditor').then(module => ({ default: module.CodeMirrorMerge })))

type Expansion = { expanded: Record<string, boolean>; onExpand: (id: string, open: boolean) => void; settled?: boolean }
const toolKey = (part: ToolCallTurnPart) => `tool:${part.call_id ?? part.index}`

export function ConversationToolGroup({ id, parts, expanded, onExpand, settled }: Expansion & { id: string; parts: ToolCallTurnPart[] }) {
  const { t } = useAppTranslation()
  const active = !settled && parts.some(part => part.status === 'running' || part.status === 'pending')
  const failed = parts.filter(part => part.status === 'failed' && !part.details?.cancelled).length
  const completed = parts.filter(part => part.status === 'succeeded').length
  const open = expanded[id] ?? parts.some(part => expanded[toolKey(part)])
  return <Collapsible open={open} onOpenChange={value => onExpand(id, value)} className="min-w-0">
    <CollapsibleTrigger className="flex min-h-8 w-full flex-wrap items-center gap-x-2 gap-y-1 rounded px-1.5 text-left text-xs text-muted-foreground hover:bg-muted/40">
      {active ? <LoaderCircle className="size-3.5 animate-spin" /> : <FileSearch className="size-3.5" />}
      <span>{t('conversation_ui.turn.file_activity', { count: parts.length })}</span>
      <span>{t('conversation_ui.turn.activity_completed', { count: completed })}</span>
      {failed > 0 && <span>{t('conversation_ui.turn.activity_unsuccessful', { count: failed })}</span>}
      <span className="ml-auto">{t(open ? 'conversation_ui.turn.collapse' : 'conversation_ui.turn.details')}</span>
    </CollapsibleTrigger>
    <CollapsibleContent className="ml-2 space-y-0.5 border-l border-border pl-2">
      {parts.map(part => <ConversationToolStep key={part.call_id ?? part.index} part={part} expanded={expanded} onExpand={onExpand} settled={settled} />)}
    </CollapsibleContent>
  </Collapsible>
}

export function ConversationToolStep({ part, expanded, onExpand, settled }: Expansion & { part: ToolCallTurnPart }) {
  const { t } = useAppTranslation()
  const result = presentToolOutput(part.output)
  const details = part.details
  const exitCode = details && Object.prototype.hasOwnProperty.call(details, 'exit_code') ? details.exit_code ?? null : result.exitCode
  const failed = part.status === 'failed'
  const cancelled = details?.cancelled === true
  const outputText = result.text || details?.error
  const commandReturned = failed && exitCode !== null && exitCode !== 0
  const read = part.kind === 'read' || part.kind === 'search'
  const unfinished = settled && (part.status === 'pending' || part.status === 'running')
  const key = toolKey(part)
  const state: ToolState = part.status === 'pending' ? 'input-streaming' : part.status === 'running' ? 'input-available' : failed ? 'output-error' : 'output-available'
  const label = unfinished ? t('conversation_ui.turn.result_unreported') : cancelled ? t('conversation_ui.turn.tool_cancelled')
    : commandReturned ? t('conversation_ui.turn.command_returned')
    : failed ? t(read ? 'conversation_ui.turn.read_unsuccessful' : 'conversation_ui.turn.step_failed')
    : t(`conversation_ui.turn.tool_${part.status}`)
  const Icon = unfinished || cancelled || commandReturned ? Info : failed ? TriangleAlert : part.status === 'running' ? LoaderCircle : part.status === 'pending' ? Circle : Check
  const expandable = part.input !== null || part.output !== null || failed || Boolean(details?.locations?.length || details?.diffs?.length || details?.terminal_ids?.length)
  return <Tool open={expanded[key] ?? false} onOpenChange={open => onExpand(key, open)}>
    <ToolHeader type={part.name} state={state} title={details?.title ?? part.name} kind={part.kind} expandable={expandable}
      statusIndicator={<span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <Icon className={part.status === 'running' && !unfinished ? 'size-3 animate-spin' : 'size-3'} />{label}
      </span>} />
    {expandable && <ToolContent>
      {details?.name && details.name !== (details.title ?? part.name) && <p className="break-all text-xs text-muted-foreground">{details.name}</p>}
      {part.input !== null && <ToolInput input={part.input} />}
      {details?.input_truncated && <p className="text-xs text-muted-foreground">{t('conversation_ui.turn.input_truncated')}</p>}
      {failed && !cancelled && <p className="text-xs text-muted-foreground">{t(commandReturned ? 'conversation_ui.turn.nonzero_exit' : 'conversation_ui.turn.tool_failed')}</p>}
      {exitCode !== null && <p className="text-xs text-muted-foreground">{t('conversation_ui.turn.exit_code', { code: exitCode })}</p>}
      {details?.signal && <p className="text-xs text-muted-foreground">{t('conversation_ui.turn.signal', { signal: details.signal })}</p>}
      {details?.error && result.text && details.error !== result.text && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{details.error}</p>}
      {(result.truncated || details?.output_truncated) && <p className="text-xs text-muted-foreground">{t('conversation_ui.turn.output_truncated')}</p>}
      {(part.output !== null || failed || details?.error) && <ToolOutput output={outputText || t(failed && !commandReturned && !cancelled ? 'conversation_ui.turn.no_error_details' : 'conversation_ui.turn.no_output')} errorText={undefined} label={t('conversation_ui.turn.tool_output')} />}
      {details?.locations?.filter(location => !details.diffs?.some(diff => diff.path === location.path)).map(location => <div key={`${location.path}:${location.line}`} className="break-all text-xs">
        <LocalMarkdownLink href={location.path}>{location.path}{location.line != null ? `:${location.line}` : ''}</LocalMarkdownLink>
      </div>)}
      {details?.diffs?.map((diff, index) => <div key={`${diff.path}:${index}`} className="min-w-0 space-y-1">
        <div className="break-all text-xs"><LocalMarkdownLink href={diff.path}>{diff.path}</LocalMarkdownLink></div>
        <p className="text-xs text-muted-foreground">{t('conversation_ui.turn.reported_diff')}</p>
        {diff.truncated && <p className="text-xs text-muted-foreground">{t('conversation_ui.turn.diff_truncated')}</p>}
        <div className="max-h-64 min-h-20 min-w-0 overflow-auto rounded border border-border">
          <ReportedDiff original={diff.old_text ?? ''} current={diff.new_text} path={diff.path} />
        </div>
      </div>)}
      {details?.terminal_ids?.length && part.output === null ? <p className="text-xs text-muted-foreground">{t('conversation_ui.turn.terminal_output_unavailable')}</p> : null}
    </ToolContent>}
  </Tool>
}

function ReportedDiff({ original, current, path }: { original: string; current: string; path: string }) {
  const { theme } = useTheme()
  const { t } = useAppTranslation()
  return <Suspense fallback={<p className="p-2 text-xs text-muted-foreground">{t('conversation_ui.turn.loading_diff')}</p>}>
    <CodeMirrorMerge unified original={original} current={current} colorMode={theme} ariaLabel={t('conversation_ui.turn.file_changes', { path })} />
  </Suspense>
}
