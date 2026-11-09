import { lazy, Suspense } from 'react'
import { Check, Circle, Info, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { ToolCallTurnPart } from '../../types/api'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolState } from '../../components/ai-elements/tool'
import { LocalMarkdownLink } from '../../components/ai-elements/markdownFileContext'
import { useTheme } from '../../contexts/ThemeContext'
import { useAppTranslation } from '../../i18n'
import { presentToolOutput } from './turnPresentation'

const CodeMirrorMerge = lazy(() => import('../project_files/CodeMirrorEditor').then(module => ({ default: module.CodeMirrorMerge })))

type Expansion = { expanded: Record<string, boolean>; onExpand: (id: string, open: boolean) => void; settled?: boolean }
const toolKey = (part: ToolCallTurnPart) => `tool:${part.call_id ?? part.index}`

export function ConversationToolGroup({ id, parts, expanded, onExpand, settled }: Expansion & { id: string; parts: ToolCallTurnPart[] }) {
  const latest = parts[parts.length - 1]
  const open = expanded[id] ?? parts.some(part => expanded[toolKey(part)])
  return <Tool open={open} onOpenChange={value => onExpand(id, value)}>
    <ConversationToolHeader part={latest} settled={settled} count={parts.length} />
    <ToolContent className="ml-2 w-auto space-y-0.5 rounded-none border-l border-border bg-transparent p-0 pl-2">
      {parts.map(part => <ConversationToolStep key={part.call_id ?? part.index} part={part} expanded={expanded} onExpand={onExpand} settled={settled} />)}
    </ToolContent>
  </Tool>
}

function ConversationToolHeader({ part, settled, count }: { part: ToolCallTurnPart; settled?: boolean; count?: number }) {
  const { t } = useAppTranslation()
  const result = presentToolOutput(part.output)
  const details = part.details
  const exitCode = details && Object.prototype.hasOwnProperty.call(details, 'exit_code') ? details.exit_code ?? null : result.exitCode
  const failed = part.status === 'failed'
  const cancelled = details?.cancelled === true
  const commandReturned = failed && exitCode !== null && exitCode !== 0
  const read = part.kind === 'read' || part.kind === 'search'
  const unfinished = settled && (part.status === 'pending' || part.status === 'running')
  const state: ToolState = part.status === 'pending' ? 'input-streaming' : part.status === 'running' ? 'input-available' : failed ? 'output-error' : 'output-available'
  const label = unfinished ? t('conversation_ui.turn.result_unreported') : cancelled ? t('conversation_ui.turn.tool_cancelled')
    : commandReturned ? t('conversation_ui.turn.command_returned')
    : failed ? t(read ? 'conversation_ui.turn.read_unsuccessful' : 'conversation_ui.turn.step_failed')
    : t(`conversation_ui.turn.tool_${part.status}`)
  const Icon = unfinished || cancelled || commandReturned ? Info : failed ? TriangleAlert : part.status === 'running' ? LoaderCircle : part.status === 'pending' ? Circle : Check
  const expandable = count !== undefined || isToolExpandable(part)
  return <ToolHeader type={part.name} state={state} title={details?.title ?? part.name} kind={part.kind} expandable={expandable}
      statusIndicator={<span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <Icon className={part.status === 'running' && !unfinished ? 'size-3 animate-spin' : 'size-3'} />{label}
        {count !== undefined && <span>· {t('conversation_ui.turn.activity_count', { count })}</span>}
      </span>} />
}

function isToolExpandable(part: ToolCallTurnPart): boolean {
  return part.input !== null || part.output !== null || part.status === 'failed' || Boolean(part.details?.locations?.length || part.details?.diffs?.length || part.details?.terminal_ids?.length)
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
  const key = toolKey(part)
  const expandable = isToolExpandable(part)
  return <Tool open={expanded[key] ?? false} onOpenChange={open => onExpand(key, open)}>
    <ConversationToolHeader part={part} settled={settled} />
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
