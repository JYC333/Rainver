import type { ClipboardEvent, DragEvent, ReactNode } from 'react'
import { Loader2, Send } from 'lucide-react'
import { Button } from '../../components/ui/button'
import type { ConversationInputPart, RuntimePromptCapabilities } from '@rainver/protocol'
import { ConversationInputSendGuardContext, useConversationInputDraft, type ConversationInputFileSource } from './ConversationInputComposer'

/** One composer frame for direct chat, Rooms, and the Project sidecar. */
export function ConversationComposer({ editor, controls, note, sending, sendDisabled, onSend, attachments, renderInputReferences = true, inputParts, onInputPartsChange, projectId, projectFolderId, fileSources, sessionId, inputResetToken, inputCapabilities, inputCapabilityMessage, onPaste, onDragOver, onDrop }: {
  editor: ReactNode
  controls?: ReactNode
  note?: ReactNode
  sending: boolean
  sendDisabled: boolean
  onSend: () => void
  attachments?: ReactNode
  renderInputReferences?: boolean
  inputParts?: ConversationInputPart[]
  onInputPartsChange?: (parts: ConversationInputPart[]) => void
  projectId?: string | null
  projectFolderId?: string | null
  fileSources?: ConversationInputFileSource[]
  sessionId?: string | null
  inputResetToken?: number
  inputCapabilities?: RuntimePromptCapabilities | null
  inputCapabilityMessage?: string | null
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void
  onDrop?: (event: DragEvent<HTMLDivElement>) => void
}) {
  const inputDraft = useConversationInputDraft({
    parts: inputParts,
    onPartsChange: onInputPartsChange,
    projectId,
    projectFolderId,
    fileSources,
    sessionId,
    disabled: sending,
    resetToken: inputResetToken,
  })
  const imageUnsupported = Boolean(inputParts?.some(part => part.kind === 'image') && (inputCapabilities?.image === false || inputCapabilityMessage))
  const canSend = !sendDisabled && !inputDraft.unresolved && !imageUnsupported
  return (
    <ConversationInputSendGuardContext.Provider value={() => canSend}>
      <div
        className="rounded-lg border border-border bg-background focus-within:ring-1 focus-within:ring-ring"
        onPaste={event => { inputDraft.onPaste(event); onPaste?.(event) }}
        onDragOver={event => { inputDraft.onDragOver(event); onDragOver?.(event) }}
        onDrop={event => { inputDraft.onDrop(event); onDrop?.(event) }}
        onDragLeave={inputDraft.onDragLeave}
      >
        {attachments ?? inputDraft.attachments}
        <div className="min-w-0">
          {renderInputReferences && inputDraft.references}
          {imageUnsupported && <p className="border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive" role="alert">{inputCapabilityMessage ?? 'Images are not supported by the selected runtime/model. Remove the affected image or choose another target.'}</p>}
          {editor}
        </div>
        <div className="flex min-h-10 items-end justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {inputDraft.controls}
            {controls}
            {note && <span className="text-xs text-muted-foreground">{note}</span>}
          </div>
          <Button type="button" size="sm" disabled={!canSend} onClick={onSend} aria-label="Send">
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </Button>
        </div>
      </div>
    </ConversationInputSendGuardContext.Provider>
  )
}
