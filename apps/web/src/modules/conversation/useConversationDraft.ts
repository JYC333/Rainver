import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationInputPart } from '@rainver/protocol'
import { conversationInputApi } from '../../api/client'
import type { ConversationInputFileSource } from './ConversationInputComposer'
import { useConversationScope } from './ConversationScope'
import {
  draftFileSearchQuery,
  readConversationDraft,
  writeConversationDraft,
  type ConversationDraftRouteChoice,
} from './conversationDraft'

/**
 * The composer's current input, with a version per field. A version moves on
 * every edit, so a slow restore can tell an untouched field from one the
 * person changed meanwhile, even when the edit put back the same value.
 */
export interface VersionedConversationDraft<T> {
  value: T
  parts: ConversationInputPart[]
  textVersion: number
  partsVersion: number
}

interface ConversationDraftOptions<T> {
  /** Store key of the destination the draft belongs to (`conversationDraft.ts`). */
  destination: string
  initialValue: () => T
  textOf: (value: T) => string
  withText: (value: T, text: string) => T
  /** The Session whose input-file search re-validates a restored file reference. */
  sessionId?: string | null
  /**
   * Before a Session exists, the Folder roots a restored file reference must
   * fall under; omitted keeps the reference for send-time validation.
   */
  fileSources?: readonly ConversationInputFileSource[]
  /** The route the person chose for this draft, kept with it (Room drafts only). */
  routeChoiceOf?: (value: T) => ConversationDraftRouteChoice | null
  /** Restored text was written into the value (the Room editor redraws from it, with the saved route choice). */
  onTextRestored?: (text: string, routeChoice: ConversationDraftRouteChoice | null) => void
}

/** A restore under way: the stored draft and the input it started from, read once per destination. */
interface PendingRestore {
  destination: string
  text: string
  parts: ConversationInputPart[]
  routeChoice: ConversationDraftRouteChoice | null
  textVersion: number
  partsVersion: number
}

/**
 * The composer draft both conversation surfaces share: versioned input state,
 * restoring a stored draft for the destination after its attachments are
 * re-validated, and persisting edits once that restore has settled.
 *
 * The stored draft and the input it is compared against are captured once
 * per destination. A re-run of the restore (a new request lifetime) only
 * re-validates; it never re-reads the store or re-snapshots the input, which
 * would count edits made while validation was pending as untouched and let
 * the old draft overwrite them. Parent renders do not restart it at all:
 * the options are read through a ref.
 */
export function useConversationDraft<T>(options: ConversationDraftOptions<T>) {
  const { destination } = options
  const scope = useConversationScope()
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [value, setValueState] = useState(options.initialValue)
  const [parts, setPartsState] = useState<ConversationInputPart[]>([])
  const draftRef = useRef<VersionedConversationDraft<T>>({ value, parts, textVersion: 0, partsVersion: 0 })
  /** The destination whose stored draft has been restored; edits persist only once it matches. */
  const readyRef = useRef<string | null>(null)
  const pendingRef = useRef<PendingRestore | null>(null)

  const setValue = useCallback((next: T) => {
    const current = draftRef.current
    draftRef.current = { ...current, value: next, textVersion: current.textVersion + 1 }
    setValueState(next)
  }, [])
  const setParts = useCallback((next: ConversationInputPart[]) => {
    const current = draftRef.current
    draftRef.current = { ...current, parts: next, partsVersion: current.partsVersion + 1 }
    setPartsState(next)
  }, [])

  useEffect(() => {
    if (readyRef.current === destination) {
      pendingRef.current = null
      return
    }
    if (pendingRef.current?.destination !== destination) {
      readyRef.current = null
      const stored = readConversationDraft(destination)
      if (!stored) {
        pendingRef.current = null
        readyRef.current = destination
        return
      }
      const current = draftRef.current
      pendingRef.current = {
        destination,
        text: stored.text,
        parts: stored.input_parts,
        routeChoice: stored.route_choice ?? null,
        textVersion: current.textVersion,
        partsVersion: current.partsVersion,
      }
    }
    const restore = pendingRef.current!
    let cancelled = false
    void (async () => {
      const validated = await Promise.all(restore.parts.map(part => validateDraftPart(part, optionsRef.current, scope)))
      if (cancelled || pendingRef.current !== restore) return
      // Attachment validation can finish after the person starts composing.
      // Restore each untouched field without replacing edits made meanwhile.
      // Put back into the editor, not reset: a reset is the after-send clear,
      // and it would empty the restored input, which the next write then
      // deletes from storage.
      if (draftRef.current.textVersion === restore.textVersion) {
        const { withText, onTextRestored } = optionsRef.current
        setValue(withText(draftRef.current.value, restore.text))
        onTextRestored?.(restore.text, restore.routeChoice)
      }
      if (draftRef.current.partsVersion === restore.partsVersion) {
        setParts(validated.filter((part): part is ConversationInputPart => part !== null))
      }
      pendingRef.current = null
      readyRef.current = destination
      writeConversationDraft({
        destination,
        text: optionsRef.current.textOf(draftRef.current.value),
        input_parts: draftRef.current.parts,
        route_choice: optionsRef.current.routeChoiceOf?.(draftRef.current.value) ?? undefined,
      })
    })()
    return () => { cancelled = true }
  }, [destination, scope, setParts, setValue])

  const text = options.textOf(value)
  const routeChoice = options.routeChoiceOf?.(value) ?? null
  useEffect(() => {
    if (readyRef.current !== destination) return
    const timer = window.setTimeout(() => writeConversationDraft({
      destination, text, input_parts: parts, route_choice: routeChoice ?? undefined,
    }), 250)
    return () => window.clearTimeout(timer)
  }, [destination, parts, routeChoice, text])

  return { value, parts, setValue, setParts, draftRef, readyRef }
}

async function validateDraftPart<T>(
  part: ConversationInputPart,
  { sessionId, fileSources }: ConversationDraftOptions<T>,
  scope: ReturnType<typeof useConversationScope>,
): Promise<ConversationInputPart | null> {
  try {
    if (part.kind === 'image') {
      await conversationInputApi.imageBlob(part.media_id, scope)
      return part
    }
    if (part.kind !== 'file_reference') {
      // Resource parts are frozen by the server when the message is sent; a
      // browser draft keeps the opaque request and lets the current-file
      // producer revalidate it at send time. Skills are revalidated by send.
      return part
    }
    if (sessionId) {
      // The search accepts at most 200 characters while a path may run to
      // 4096; the file name finds the candidates and the full path picks the
      // reference back out of them.
      const result = await conversationInputApi.searchFiles(sessionId, draftFileSearchQuery(part.relative_path), undefined, scope)
      return result.items.some(item => item.project_folder_id === part.project_folder_id
        && item.workspace_location_id === part.workspace_location_id
        && item.relative_path === part.relative_path)
        ? part
        : null
    }
    if (!fileSources) return part
    return fileSources.some(source => source.projectFolderId === part.project_folder_id
      && (!source.workspaceLocationId || source.workspaceLocationId === part.workspace_location_id))
      ? part
      : null
  } catch {
    return null
  }
}
