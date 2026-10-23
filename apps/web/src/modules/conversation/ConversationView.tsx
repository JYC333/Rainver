import { hasSkillReference, skillReferenceRanges, skillReferenceText, SkillMenuEmptyHint, useAvailableSkills, type SkillReferenceRange } from './conversationSkills'
import { useAppTranslation } from '../../i18n'
import { forwardRef, useEffect, useLayoutEffect, useState, useRef, type ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import type { RunTurn } from '../../types/api'
import {
  Conversation, ConversationContent, ConversationScrollButton,
} from '../../components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '../../components/ai-elements/message'
import { Textarea } from '../../components/ui/textarea'
import { EmptyState } from '../../components/ui/empty-state'
import { ConversationTurn } from './ConversationTurn'
import { ConversationComposer } from './ConversationComposer'
import { KnowledgeRetrievalToggle } from './KnowledgeRetrievalToggle'
import type { ConversationInputPart, ConversationInputSkillPart, RuntimePromptCapabilities } from '@rainver/protocol'
import { ConversationInputPartsView, useConversationInputSendGuard, type ConversationInputFileSource } from './ConversationInputComposer'

/**
 * What a surface hands this view for one entry in the transcript.
 *
 * A person's message is text. An Agent's is a turn — the parts it produced —
 * or, once it is history, the text it settled on. A surface that has the turn
 * passes it; one reading persisted messages back does not, and the reply
 * renders as prose.
 */
interface ConversationEntry {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** The live or replayed turn, when this surface has it. */
  turn?: RunTurn | null
  error?: boolean
  inputParts?: ConversationInputPart[]
  /** Rendered after the body — a reference card, an edit summary. */
  extra?: ReactNode
  /** Run actions belong below the bubble, so a status card cannot resize it. */
  runControls?: ReactNode
}

/**
 * The message list and composer every conversation surface shares.
 *
 * It renders a person's message as a bubble and an Agent's through
 * `ConversationTurn`, so the same turn looks the same in the Room, in a chat
 * panel, and beside a notebook. Callers own session, history and send state;
 * this is presentational.
 */
export function ConversationView({
  entries,
  sending,
  loadingHistory,
  input,
  onInputChange,
  onSend,
  placeholder,
  emptyTitle,
  emptyDescription,
  composerDisabled = false,
  inputDisabled,
  composerNote,
  composerControls,
  runHref,
  inputParts = [],
  onInputPartsChange,
  projectId,
  projectFolderId,
  inputFileSources,
  sessionId,
  inputResetToken,
  inputCapabilities,
  skillAgentId,
}: {
  entries: ConversationEntry[]
  sending: boolean
  loadingHistory: boolean
  input: string
  onInputChange: (value: string) => void
  onSend: () => void
  placeholder: string
  emptyTitle: string
  emptyDescription: string
  composerDisabled?: boolean
  inputDisabled?: boolean
  /** Why the composer is disabled, when there is something worth saying. */
  composerNote?: string
  composerControls?: ReactNode
  runHref?: (entry: ConversationEntry) => string | undefined
  inputParts?: ConversationInputPart[]
  onInputPartsChange?: (parts: ConversationInputPart[]) => void
  projectId?: string | null
  projectFolderId?: string | null
  inputFileSources?: ConversationInputFileSource[]
  skillAgentId?: string | null
  sessionId?: string | null
  inputResetToken?: number
  inputCapabilities?: RuntimePromptCapabilities | null
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        `Conversation` sticks to the bottom while new messages arrive and lets
        go the moment the reader scrolls up — which a plain scroll-on-update
        does not, and which matters most in the turn that is still growing.
      */}
      <Conversation className="flex-1 rounded-lg border border-border bg-card">
        <ConversationContent className="p-4">
        {loadingHistory ? (
          <div className="flex h-full min-h-[220px] items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading conversation…
          </div>
        ) : entries.length === 0 && !sending ? (
          <EmptyState title={emptyTitle} description={emptyDescription} />
        ) : (
          <div className="flex flex-col gap-4">
            {entries.map(entry => (
              <ConversationEntryView key={entry.id} entry={entry} runHref={runHref?.(entry)} />
            ))}
            {/*
              Only until *this* turn appears. A turn renders what it is doing
              — including that it has stopped and is waiting on the person —
              and a spinner beside it would say the opposite.

              The last entry, not any entry: once history reads its turns
              back, an older reply carrying one would otherwise suppress the
              indicator for every new message, leaving nothing at all between
              the send and the first frame.
            */}
            {sending && !entries[entries.length - 1]?.turn && (
              <Message from="assistant">
                <MessageContent>
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Thinking…
                  </span>
                </MessageContent>
              </Message>
            )}
          </div>
        )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <form className="mt-3" onSubmit={event => { event.preventDefault(); onSend() }}>
        <ConversationComposer
          editor={<ConversationTextEditor
            input={input}
            inputParts={inputParts} onInputPartsChange={onInputPartsChange}
            sessionId={sessionId} projectId={projectId} agentId={skillAgentId}
            onInputChange={onInputChange}
            onSend={onSend}
            placeholder={placeholder}
            disabled={composerDisabled}
          />}
          controls={sessionId !== undefined ? (
            <>
              <KnowledgeRetrievalToggle scopeId={sessionId} disabled={sending} />
              {composerControls}
            </>
          ) : composerControls}
          note={composerNote}
          sending={sending}
          inputDisabled={inputDisabled}
          sendDisabled={composerDisabled || sending || loadingHistory || (!input.trim() && inputParts.length === 0)}
          onSend={onSend}
          inputParts={inputParts}
          onInputPartsChange={onInputPartsChange}
          projectId={projectId}
          projectFolderId={projectFolderId}
          fileSources={inputFileSources}
          sessionId={sessionId}
          inputResetToken={inputResetToken}
          inputCapabilities={inputCapabilities}
        />
      </form>
    </div>
  )
}

function ConversationTextEditor({ input, onInputChange, onSend, placeholder, disabled, inputParts, onInputPartsChange, sessionId, projectId, agentId }: {
  input: string; onInputChange: (value: string) => void; onSend: () => void; placeholder: string; disabled: boolean
  inputParts: ConversationInputPart[]; onInputPartsChange?: (parts: ConversationInputPart[]) => void
  sessionId?: string | null; projectId?: string | null; agentId?: string | null
}) {
  const { t } = useAppTranslation()
  const canSend = useConversationInputSendGuard()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState<{ from: number; to: number; query: string } | null>(null)
  const [index, setIndex] = useState(0)
  const { skills, loading, loaded, error } = useAvailableSkills({ sessionId, projectId, agentId, enabled: !!range && !!onInputPartsChange })
  const suggestions = skills.filter(skill => skill.display_name.toLowerCase().includes(range?.query.toLowerCase() ?? '')
    && !inputParts.some(part => part.kind === 'skill' && part.skill_package_id === skill.skill_package_id)).slice(0, 12)
  // Older drafts stored selections separately from their text. Keep them visible
  // when restored, while newly selected references are inserted at the caret.
  useEffect(() => {
    const missing = inputParts.filter((part): part is ConversationInputSkillPart => part.kind === 'skill' && !hasSkillReference(input, part))
    if (missing.length) onInputChange([input, ...missing.map(skillReferenceText)].filter(Boolean).join(' '))
  }, [input, inputParts, onInputChange])
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return
    textarea.current?.focus()
    textarea.current?.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
  }, [input])
  function updateRange(value: string, caret: number) {
    const match = /(?:^|\s)[/@]([^\s/@]*)$/.exec(value.slice(0, caret))
    setRange(match && onInputPartsChange ? { from: caret - match[1]!.length - 1, to: caret, query: match[1]! } : null)
    setIndex(0)
  }
  const selectedSkills = inputParts.filter((part): part is ConversationInputSkillPart => part.kind === 'skill')
  const references = skillReferenceRanges(input, selectedSkills)
  function changeText(text: string, caret: number) {
    const nextParts = inputParts.filter(part => part.kind !== 'skill' || hasSkillReference(text, part))
    if (nextParts.length !== inputParts.length) onInputPartsChange?.(nextParts)
    onInputChange(text)
    updateRange(text, caret)
  }
  // A reference is one token, like an @mention: Backspace or Delete next to it
  // removes the whole reference and its selection instead of breaking it.
  function deleteReference(key: string, target: HTMLTextAreaElement): boolean {
    if (target.selectionStart !== target.selectionEnd) return false
    const caret = target.selectionStart
    const hit = references.find(reference => key === 'Backspace' ? caret > reference.from && caret <= reference.to : caret >= reference.from && caret < reference.to)
    if (!hit) return false
    pendingCaret.current = hit.from
    changeText(input.slice(0, hit.from) + input.slice(hit.to), hit.from)
    return true
  }
  function choose(selected: number) {
    const skill = suggestions[selected]
    if (!skill || !range || disabled || !onInputPartsChange || inputParts.filter(part => part.kind === 'skill').length >= 4) return
    onInputPartsChange([...inputParts, skill])
    const reference = skillReferenceText(skill) + (/^\s/u.test(input.slice(range.to)) ? '' : ' ')
    pendingCaret.current = range.from + reference.length
    onInputChange(input.slice(0, range.from) + reference + input.slice(range.to))
    setRange(null)
    textarea.current?.focus()
  }
  return <div className="relative">
    {range && onInputPartsChange && <div className="absolute bottom-full z-20 max-h-64 w-80 max-w-full overflow-auto rounded border bg-popover p-1 shadow-lg" role="listbox" aria-label={t('skill_packages.invoke')}>
      {suggestions.map((skill, itemIndex) => <button key={skill.skill_package_id} type="button" role="option" aria-selected={itemIndex === index}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(itemIndex)} className={`block w-full rounded p-2 text-left text-sm ${itemIndex === index ? 'bg-accent' : ''}`}>
        /{skill.display_name} <span className="text-xs text-muted-foreground">{skill.package_hash.slice(0, 8)}</span>
      </button>)}
      {(!suggestions.length || error || inputParts.filter(part => part.kind === 'skill').length >= 4) && <p className="p-2 text-xs">{error || (loading ? t('management_ui.capabilities.loading_detail') : inputParts.filter(part => part.kind === 'skill').length >= 4 ? t('skill_packages.limit') : loaded && !skills.length ? <SkillMenuEmptyHint /> : t('skill_packages.no_matches'))}</p>}
    </div>}
    {references.length > 0 && <SkillReferenceBackdrop ref={backdrop} text={input} references={references} />}
    <Textarea ref={textarea} value={input}
      onChange={event => changeText(event.target.value, event.target.selectionStart)}
      onScroll={event => { if (backdrop.current) backdrop.current.scrollTop = event.currentTarget.scrollTop }}
      onClick={event => updateRange(event.currentTarget.value, event.currentTarget.selectionStart)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if ((event.key === 'Backspace' || event.key === 'Delete') && !disabled && deleteReference(event.key, event.currentTarget)) { event.preventDefault(); return }
        if (range) {
          if (event.key === 'Escape') { event.preventDefault(); setRange(null); return }
          if (suggestions.length && !event.shiftKey && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) {
            event.preventDefault()
            if (event.key === 'Enter' || event.key === 'Tab') choose(Math.min(index, suggestions.length - 1))
            else setIndex(value => (value + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length)
            return
          }
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (canSend()) onSend() }
      }} placeholder={placeholder} disabled={disabled} rows={2}
      className="relative min-h-[84px] resize-none border-0 bg-transparent shadow-none [scrollbar-gutter:stable] focus-visible:ring-0" />
  </div>
}

/**
 * Highlights Skill references behind a plain textarea. It repeats the
 * textarea's text box (padding, font, wrapping, scrollbar gutter) with
 * transparent text, so each mark sits exactly under its reference.
 */
const SkillReferenceBackdrop = forwardRef<HTMLDivElement, { text: string; references: SkillReferenceRange[] }>(function SkillReferenceBackdrop({ text, references }, ref) {
  const pieces: ReactNode[] = []
  let at = 0
  for (const reference of references) {
    if (reference.from < at) continue
    pieces.push(text.slice(at, reference.from))
    pieces.push(<mark key={reference.from} data-skill-reference="true" className="rounded bg-primary/15 text-transparent">{text.slice(reference.from, reference.to)}</mark>)
    at = reference.to
  }
  pieces.push(text.slice(at))
  return <div ref={ref} aria-hidden="true"
    className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-sm text-transparent [scrollbar-gutter:stable]">
    {pieces}
  </div>
})

function ConversationEntryView({ entry, runHref }: { entry: ConversationEntry; runHref?: string }) {
  if (entry.role === 'assistant' && entry.turn) {
    return (
      <div className="min-w-0">
        <ConversationTurn turn={entry.turn} runHref={runHref} />
        {entry.extra}
        {entry.runControls && <div className="w-fit min-w-0 max-w-[95%]">{entry.runControls}</div>}
      </div>
    )
  }

  return (
    <div className="min-w-0">
      <Message from={entry.role}>
        <MessageContent>
          {entry.error && (
            <span className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="size-3" /> Could not complete
            </span>
          )}
          <ConversationInputPartsView parts={entry.inputParts} text={entry.content} />
          {entry.content && <MessageResponse>{entry.content}</MessageResponse>}
          {entry.extra}
        </MessageContent>
      </Message>
      {entry.runControls && (
        <div className={`w-fit min-w-0 max-w-[95%] ${entry.role === 'user' ? 'ml-auto' : ''}`}>
          {entry.runControls}
        </div>
      )}
    </div>
  )
}
