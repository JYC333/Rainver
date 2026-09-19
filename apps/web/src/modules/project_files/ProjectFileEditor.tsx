import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { FileCode, FilePlus, History, Save, Trash2, WandSparkles } from 'lucide-react'
import type { ConversationInputResourcePart, InputResourceSelection } from '@rainver/protocol'
import type { FileContent, ProjectFileDraft, ProjectFileDraftSave } from '../../types/api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { ConfirmDialog } from '../../components/ui/dialog'
import { CodeMirrorEditor, CodeMirrorMerge } from './CodeMirrorEditor'
import { languageForPath } from './codeMirrorLanguages'
import { ProjectFileDraftController, sha256Utf8, type DraftControllerSnapshot, type DraftMutationInput } from './draftController'
import type { CurrentFileAttachment } from '../projects/ProjectFolderConversationContext'

export interface ProjectFileEditorProps {
  file: FileContent | null
  draft: ProjectFileDraft | null
  draftLoading?: boolean
  saving?: boolean
  onDraftUpsert: (input: DraftMutationInput) => Promise<ProjectFileDraft>
  onDraftDiscard: (draft: ProjectFileDraft) => Promise<void>
  onDraftSave: (draft: ProjectFileDraft, options?: { confirmMixedLineEndingNormalization?: boolean }) => Promise<ProjectFileDraftSave>
  onDraftRebase: (input: DraftMutationInput) => Promise<ProjectFileDraft>
  onConvert?: () => Promise<void>
  onHistory?: () => void
  onCancel?: () => void
  projectFolderId?: string | null
  workspaceLocationId?: string | null
  workspaceLocationAvailable?: boolean
  onAttachmentStateChange?: (attachment: CurrentFileAttachment | null) => void
}

export interface ProjectFileEditorHandle {
  flush: () => Promise<void>
  hasPendingChanges: () => boolean
  flushForSend: () => Promise<ConversationInputResourcePart | null>
}

function lineEndingMode(file: FileContent | null): 'lf' | 'crlf' | 'mixed' | 'none' {
  if (file?.line_ending_mode) return file.line_ending_mode
  const content = file?.content ?? ''
  const crlf = /\r\n/u.test(content)
  const loneLf = /(^|[^\r])\n/u.test(content)
  const loneCr = /\r(?!\n)/u.test(content)
  if (!crlf && !loneLf && !loneCr) return 'none'
  if ((crlf ? 1 : 0) + (loneLf || loneCr ? 1 : 0) > 1 || loneCr) return 'mixed'
  return crlf ? 'crlf' : 'lf'
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

function statusLabel(snapshot: DraftControllerSnapshot, draftLoading: boolean, savePending: boolean): string {
  if (draftLoading) return 'Checking recovery draft…'
  if (savePending) return 'Saving to Folder…'
  switch (snapshot.status) {
    case 'dirty': return 'Unsaved changes'
    case 'saving': return 'Saving draft…'
    case 'saved': return 'Draft saved'
    case 'error': return 'Draft save failed'
    case 'conflict': return 'Draft conflict'
    default: return 'Clean'
  }
}

/** True when the server would read this file back as an admissible UTF-8 body. */
function isUtf8Body(file: FileContent | null): boolean {
  if (!file) return false
  return !file.encoding || file.encoding === 'utf8'
}

function isEditable(file: FileContent | null, converted: boolean): boolean {
  if (!file) return true
  if (converted) return true
  return file.writable !== false && (!file.encoding || file.encoding === 'utf8')
}

export const ProjectFileEditor = forwardRef<ProjectFileEditorHandle, ProjectFileEditorProps>(function ProjectFileEditor({
  file,
  draft,
  draftLoading = false,
  saving = false,
  onDraftUpsert,
  onDraftDiscard,
  onDraftSave,
  onDraftRebase,
  onConvert,
  onHistory,
  onCancel,
  projectFolderId = null,
  workspaceLocationId = null,
  workspaceLocationAvailable = true,
  onAttachmentStateChange,
}: ProjectFileEditorProps, ref) {
  const [path, setPath] = useState(file?.path ?? draft?.relative_path ?? '')
  const [activeDraft, setActiveDraft] = useState<ProjectFileDraft | null>(draft)
  const activeDraftRef = useRef<ProjectFileDraft | null>(draft)
  const [saveInFlight, setSaveInFlight] = useState(false)
  const [converted, setConverted] = useState(false)
  const [confirmMixedSave, setConfirmMixedSave] = useState(false)
  const [selection, setSelection] = useState<InputResourceSelection | undefined>(undefined)
  const selectionRef = useRef<InputResourceSelection | undefined>(undefined)
  const [snapshot, setSnapshot] = useState<DraftControllerSnapshot>(() => ({
    status: draft ? 'saved' : 'clean',
    content: draft?.content ?? file?.content ?? '',
    draft,
    generation: 0,
    acknowledgedGeneration: 0,
    error: null,
  }))
  const controllerRef = useRef<ProjectFileDraftController | null>(null)
  const latestFileRef = useRef(file)
  latestFileRef.current = file
  const pathRef = useRef(path)
  pathRef.current = path

  const baseFile = file
  const editable = isEditable(baseFile, converted)
  const savePending = saving || saveInFlight
  const language = languageForPath(path)
  const lineMode = activeDraft?.line_ending_mode ?? lineEndingMode(baseFile)
  const hostConflict = Boolean(
    !savePending
    && activeDraft
    && baseFile?.sha256
    && activeDraft.base_exists
    && activeDraft.base_sha256
    && baseFile.sha256 !== activeDraft.base_sha256,
  )
  const draftConflict = snapshot.status === 'conflict' && Boolean(activeDraft)

  const mediaType = 'text/plain'
  const currentSourceKey = `${projectFolderId ?? activeDraft?.project_folder_id ?? ''}:${workspaceLocationId ?? activeDraft?.workspace_location_id ?? ''}:${path.trim()}`

  const resourcePart = async (currentSnapshot: DraftControllerSnapshot): Promise<ConversationInputResourcePart | null> => {
    const currentDraft = activeDraftRef.current
    const relativePath = pathRef.current.trim()
    const folderId = projectFolderId ?? currentDraft?.project_folder_id ?? null
    const locationId = workspaceLocationId ?? currentDraft?.workspace_location_id ?? null
    if (!relativePath || !folderId || !locationId) return null
    const currentSelection = selectionRef.current
    if (currentDraft) {
      return {
        kind: 'input_resource',
        source_state: 'draft',
        draft_id: currentDraft.id,
        draft_version: currentDraft.version,
        content_sha256: currentDraft.content_sha256,
        display_name: relativePath.split(/[\\/]+/u).pop() ?? relativePath,
        media_type: mediaType,
        byte_size: currentDraft.byte_size,
        ...(currentSelection ? { selection: currentSelection } : {}),
      }
    }
    const currentFile = latestFileRef.current
    if (!currentFile?.sha256 || currentSnapshot.status === 'dirty' || currentSnapshot.status === 'saving' || currentSnapshot.status === 'error' || currentSnapshot.status === 'conflict') return null
    // A converted UTF-16 preview is only editable as a draft; the server reads
    // the Folder file without conversion, so there is no saved body to freeze.
    if (!isUtf8Body(currentFile)) return null
    // The message freezes the decoded UTF-8 body, so admission compares the
    // body's size and digest. `file.size`/`file.sha256` describe the bytes on
    // disk, which differ from the body whenever the file carries a BOM.
    const body = currentFile.content
    return {
      kind: 'input_resource',
      source_state: 'saved',
      project_folder_id: folderId,
      workspace_location_id: locationId,
      relative_path: relativePath,
      display_name: relativePath.split(/[\\/]+/u).pop() ?? relativePath,
      media_type: mediaType,
      byte_size: new TextEncoder().encode(body).byteLength,
      sha256: await sha256Utf8(body),
      ...(currentSelection ? { selection: currentSelection } : {}),
    }
  }

  const flushForSend = async (): Promise<ConversationInputResourcePart | null> => {
    await controller.flush()
    const current = controller.snapshot()
    if (current.status === 'conflict' || current.status === 'error') {
      throw current.error instanceof Error ? current.error : new Error('The current file draft could not be saved')
    }
    return resourcePart(current)
  }

  const attachmentState = useMemo<CurrentFileAttachment | null>(() => {
    const currentDraft = activeDraftRef.current
    const relativePath = path.trim()
    const folderId = projectFolderId ?? currentDraft?.project_folder_id ?? null
    const locationId = workspaceLocationId ?? currentDraft?.workspace_location_id ?? null
    if (!relativePath || !folderId || !locationId || (!baseFile && !currentDraft) || !editable) return null
    const sourceState = currentDraft || snapshot.status === 'dirty' || snapshot.status === 'saving' || snapshot.status === 'error' ? 'draft' : 'saved'
    const status = hostConflict || draftConflict
      ? 'conflict'
      : baseFile && !currentDraft && !isUtf8Body(baseFile)
        ? 'unsupported'
      : !workspaceLocationAvailable && !currentDraft
        ? 'offline'
      : savePending || snapshot.status === 'saving'
        ? 'saving'
        : sourceState === 'draft' || snapshot.status === 'dirty' || snapshot.status === 'error'
          ? 'draft'
          : 'clean'
    return {
      sourceKey: currentSourceKey,
      projectFolderId: folderId,
      workspaceLocationId: locationId,
      relativePath,
      displayName: relativePath.split(/[\\/]+/u).pop() ?? relativePath,
      mediaType,
      sourceState,
      byteSize: currentDraft?.byte_size ?? new TextEncoder().encode(snapshot.content).byteLength,
      sha256: currentDraft?.content_sha256 ?? baseFile?.sha256 ?? null,
      draftId: currentDraft?.id ?? null,
      draftVersion: currentDraft?.version ?? null,
      contentSha256: currentDraft?.content_sha256 ?? null,
      ...(selection ? { selection } : {}),
      status,
      flushForSend,
    }
  }, [baseFile, currentSourceKey, draftConflict, editable, hostConflict, path, projectFolderId, savePending, selection, snapshot, workspaceLocationAvailable, workspaceLocationId])

  const buildMutation = useMemo(() => async (content: string, currentDraft: ProjectFileDraft | null): Promise<Omit<DraftMutationInput, 'content' | 'content_sha256' | 'byte_size'> | null> => {
    const currentFile = latestFileRef.current
    const relativePath = pathRef.current.trim()
    if (!relativePath || relativePath.includes('\0')) return null
    const sourceEncoding = currentDraft?.source_encoding
      ?? (converted ? 'utf8' : currentFile?.encoding === 'utf16le' || currentFile?.encoding === 'utf16be' ? currentFile.encoding : 'utf8')
    return {
      expected_version: currentDraft?.version ?? null,
      target_kind: currentFile ? 'existing' : 'new',
      relative_path: relativePath,
      base_exists: currentDraft?.base_exists ?? Boolean(currentFile),
      base_sha256: currentDraft?.base_sha256 ?? currentFile?.sha256 ?? null,
      source_encoding: sourceEncoding,
      preserve_bom: currentDraft?.preserve_bom ?? (converted ? false : Boolean(currentFile?.has_bom)),
      line_ending_mode: currentDraft?.line_ending_mode ?? lineMode,
    }
  }, [converted, lineMode])

  const buildMutationRef = useRef(buildMutation)
  buildMutationRef.current = buildMutation

  if (!controllerRef.current) {
    controllerRef.current = new ProjectFileDraftController({
      initialContent: file?.content ?? '',
      initialDraft: draft,
      // Through the ref: the controller outlives every rebuild of this
      // callback, and a captured one kept sending the pre-conversion
      // `source_encoding` after "Convert to UTF-8", which the draft API
      // rejects.
      buildMutation: (content, currentDraft) => buildMutationRef.current(content, currentDraft),
      save: async input => {
        const next = await onDraftUpsert(input)
        activeDraftRef.current = next
        setActiveDraft(next)
        return next
      },
      onChange: next => setSnapshot(next),
    })
  }
  const controller = controllerRef.current

  useImperativeHandle(ref, () => ({
    flush: () => controller.flush(),
    flushForSend,
    hasPendingChanges: () => {
      const current = controller.snapshot()
      return current.status === 'dirty' || current.status === 'saving' || current.status === 'error' || current.status === 'conflict'
    },
  }), [controller])

  useEffect(() => {
    onAttachmentStateChange?.(attachmentState)
  }, [attachmentState, onAttachmentStateChange])

  useEffect(() => () => onAttachmentStateChange?.(null), [onAttachmentStateChange])

  useEffect(() => () => controller.destroy(), [controller])

  useEffect(() => {
    if (draft === activeDraftRef.current) return
    activeDraftRef.current = draft
    setActiveDraft(draft)
    controller.hydrate(draft)
  }, [controller, draft])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (snapshot.status !== 'dirty' && snapshot.status !== 'saving') return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [snapshot.status])

  async function saveToFolder(confirmMixedLineEndingNormalization = false): Promise<void> {
    try {
      await controller.flush()
      const current = activeDraftRef.current
      if (!current) return
      if (current.line_ending_mode === 'mixed' && !confirmMixedLineEndingNormalization) {
        setConfirmMixedSave(true)
        return
      }
      setSaveInFlight(true)
      try {
        const result = await onDraftSave(current, { confirmMixedLineEndingNormalization })
        activeDraftRef.current = result.newer_draft_retained ? current : null
        setActiveDraft(activeDraftRef.current)
        controller.commitCanonical(result.file.content, activeDraftRef.current)
      } finally {
        setSaveInFlight(false)
      }
    } catch {
      // The controller exposes conflict/error status; the page-level toast is
      // responsible for transport details.
    }
  }

  async function discardDraft(): Promise<void> {
    const current = activeDraftRef.current
    if (!current) return
    await onDraftDiscard(current)
    activeDraftRef.current = null
    setActiveDraft(null)
    controller.hydrate(null)
  }

  async function rebaseDraft(): Promise<void> {
    const current = activeDraftRef.current
    if (!current) return
    const mutation = await buildMutation(snapshot.content, current)
    if (!mutation) return
    const next = await onDraftRebase({
      ...mutation,
      expected_version: current.version,
      target_kind: current.target_kind,
      base_exists: Boolean(baseFile),
      base_sha256: baseFile?.sha256 ?? null,
      source_encoding: 'utf8',
      preserve_bom: Boolean(baseFile?.has_bom),
      content: snapshot.content,
      content_sha256: await sha256Utf8(snapshot.content),
      byte_size: new TextEncoder().encode(snapshot.content).byteLength,
    })
    activeDraftRef.current = next
    setActiveDraft(next)
    controller.hydrate(next)
  }

  async function convertFile(): Promise<void> {
    if (!onConvert) return
    await onConvert()
    setConverted(true)
  }

  useEffect(() => {
    if (draft || snapshot.status === 'dirty' || snapshot.status === 'saving') return
    controller.setCanonicalContent(file?.content ?? '')
  }, [controller, draft, file?.content, snapshot.status])

  const hasDraft = Boolean(activeDraft)
  const canEdit = editable && !savePending
  const draftContent = snapshot.content
  const canSave = hasDraft && snapshot.status !== 'saving' && snapshot.status !== 'conflict' && !hostConflict
  const pathLocked = Boolean(file)

  return (
    <>
    <ConfirmDialog
      open={confirmMixedSave}
      onOpenChange={setConfirmMixedSave}
      title="Normalize mixed line endings?"
      description="Saving will normalize this file's mixed line endings to LF. This changes line separators throughout the file."
      confirmLabel="Normalize and save"
      variant="default"
      onConfirm={() => { void saveToFolder(true) }}
    />
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2">
        {file ? <FileCode className="size-3.5 text-muted-foreground" /> : <FilePlus className="size-3.5 text-muted-foreground" />}
        <Input
          aria-label="File path"
          value={path}
          onChange={event => setPath(event.target.value)}
          placeholder="path/to/file.txt"
          className="h-7 max-w-md font-mono text-xs"
          disabled={pathLocked || savePending}
          readOnly={pathLocked}
          autoFocus={!file}
        />
        <span role="status" className="text-[10px] text-muted-foreground">{statusLabel(snapshot, draftLoading, savePending)}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {onHistory && <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[10px]" onClick={onHistory}><History className="size-3" /> History</Button>}
          {onCancel && !file && <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={onCancel}>Cancel</Button>}
          {hasDraft && <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[10px]" onClick={() => void discardDraft()} disabled={savePending}><Trash2 className="size-3" /> Discard</Button>}
          <Button type="button" size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={() => void saveToFolder()} disabled={!canSave || savePending}><Save className="size-3" /> Save to Folder</Button>
        </span>
      </div>
      <div className="shrink-0 flex flex-wrap items-center gap-2 border-b px-4 py-1.5 text-[10px] text-muted-foreground">
        <span>{formatBytes(new TextEncoder().encode(draftContent).byteLength)} · {language}</span>
        <span>· {lineMode === 'mixed' ? 'mixed line endings' : `${lineMode.toUpperCase()} line endings`}</span>
        {baseFile?.encoding && <Badge variant="muted" className="px-1.5 text-[9px]">{converted ? 'UTF-8 converted' : baseFile.encoding}</Badge>}
        {hostConflict && <span className="text-amber-600 dark:text-amber-400">Host changed since this draft</span>}
        {!editable && onConvert && <Button type="button" size="sm" variant="outline" className="h-5 gap-1 px-2 text-[10px]" onClick={() => void convertFile()}><WandSparkles className="size-3" /> Convert to UTF-8</Button>}
      </div>
      {(hostConflict || draftConflict) && activeDraft && baseFile && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/5 px-4 py-2 text-[11px] text-muted-foreground">
          <p className="mb-1">{hostConflict ? 'The Folder file changed after this draft was saved.' : 'Another tab has a newer recovery draft.'} Review both versions before rebasing.</p>
          <div className="mb-2 h-40 min-h-0 overflow-hidden rounded border">
            <CodeMirrorMerge original={baseFile.content} current={draftContent} language={language} />
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => void rebaseDraft()}>Keep this draft, rebase</Button>
            <Button type="button" size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => void discardDraft()}>Use current/server file</Button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CodeMirrorEditor
          value={draftContent}
          language={language}
          readOnly={!canEdit || hostConflict || draftConflict || !path.trim()}
          lineSeparator={lineMode === 'crlf' ? '\r\n' : '\n'}
          indent={detectIndentUnit(draftContent)}
          ariaLabel="File content"
          onChange={content => controller.setContent(content)}
          onSelectionChange={next => {
            const nextSelection: InputResourceSelection = {
              start_line: next.startLine,
              start_column: next.startColumn,
              end_line: next.endLine,
              end_column: next.endColumn,
            }
            selectionRef.current = nextSelection
            setSelection(nextSelection)
          }}
          onBlur={() => { void controller.flush().catch(() => {}) }}
          onSave={() => { void saveToFolder() }}
        />
      </div>
    </div>
    </>
  )
})

function detectIndentUnit(content: string): string {
  const match = content.match(/^( +|\t+)/mu)
  if (!match) return '  '
  if (match[1]!.includes('\t')) return '\t'
  return match[1]!.length >= 4 ? '    ' : '  '
}
