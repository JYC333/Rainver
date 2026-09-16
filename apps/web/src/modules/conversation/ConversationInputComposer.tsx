import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type ClipboardEvent, type ReactNode } from 'react'
import { FileText, ImagePlus, Loader2, Paperclip, Search, X } from 'lucide-react'
import type {
  ConversationInputFileReferencePart,
  ConversationInputImagePart,
  ConversationInputPart,
  ConversationExecutionSummary,
} from '@rainver/protocol'
import {
  CONVERSATION_MAX_FILE_REFERENCES,
  CONVERSATION_MAX_FILE_SNAPSHOT_BYTES,
  CONVERSATION_MAX_IMAGES,
  ConversationImageMediaTypeSchema,
} from '@rainver/protocol'
import { conversationInputApi, projectFoldersApi } from '../../api/client'
import type { FileNode } from '../../types/api'
import { errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'

interface UploadState {
  localId: string
  file: File
  previewUrl: string
  progress: number
  media?: ConversationInputImagePart
  error?: string
}

interface FileCandidate {
  projectFolderId: string
  workspaceLocationId: string
  source: string
  path: string
  name: string
  size: number
}

export interface ConversationInputFileSource {
  projectFolderId: string
  workspaceLocationId?: string
  label: string
}

export function conversationInputSourcesFromExecutionSummary(summary: ConversationExecutionSummary | null): ConversationInputFileSource[] {
  if (!summary) return []
  const sources: ConversationInputFileSource[] = []
  if (summary.primary?.kind === 'location') {
    sources.push({
      projectFolderId: summary.primary.project_folder_id,
      workspaceLocationId: summary.primary.workspace_location_id,
      label: `Primary · ${summary.primary.display_path ?? 'Workspace'}`,
    })
  }
  for (const attachment of summary.attachments) {
    if (attachment.status !== 'active') continue
    sources.push({
      projectFolderId: attachment.project_folder_id,
      workspaceLocationId: attachment.workspace_location_id,
      label: `Attached · ${attachment.folder_name}`,
    })
  }
  const seen = new Set<string>()
  return sources.filter(source => {
    const key = `${source.projectFolderId}:${source.workspaceLocationId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export interface ConversationInputDraftController {
  parts: ConversationInputPart[]
  unresolved: boolean
  references: ReactNode
  attachments: ReactNode
  controls: ReactNode
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDragLeave: () => void
}

export const ConversationInputSendGuardContext = createContext<() => boolean>(() => true)

export function useConversationInputSendGuard(): () => boolean {
  return useContext(ConversationInputSendGuardContext)
}

/**
 * The shared conversation input layer. Image bytes upload as soon as they are
 * pasted, dropped, or picked; file references are resolved from the authorized
 * Project Folder tree and fetched only when selected. Parents own the actual
 * message send, while this hook owns transient upload/search state.
 */
export function useConversationInputDraft({
  parts = [],
  onPartsChange,
  projectId,
  projectFolderId,
  fileSources,
  sessionId,
  disabled = false,
  resetToken = 0,
}: {
  parts?: ConversationInputPart[]
  onPartsChange?: (parts: ConversationInputPart[]) => void
  projectId?: string | null
  projectFolderId?: string | null
  fileSources?: ConversationInputFileSource[]
  sessionId?: string | null
  disabled?: boolean
  resetToken?: number
}): ConversationInputDraftController {
  const [uploads, setUploads] = useState<UploadState[]>([])
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [fileQuery, setFileQuery] = useState('')
  const [fileTrees, setFileTrees] = useState<Array<{ source: ConversationInputFileSource & { workspaceLocationId: string }; tree: FileNode }>>([])
  const [searchCandidates, setSearchCandidates] = useState<FileCandidate[] | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [fileLoadingPath, setFileLoadingPath] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const partsRef = useRef(parts)
  const uploadsRef = useRef(uploads)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileSearchControllerRef = useRef<AbortController | null>(null)
  const cancelledUploadsRef = useRef(new Set<string>())

  partsRef.current = parts
  uploadsRef.current = uploads

  const fallbackFileSources = useMemo<ConversationInputFileSource[]>(() => projectFolderId
    ? [{ projectFolderId, label: 'Project Folder' }]
    : [], [projectFolderId])
  const inputFileSources = fileSources ?? fallbackFileSources
  const inputFileSourceKey = inputFileSources.map(source => `${source.projectFolderId}:${source.workspaceLocationId ?? ''}:${source.label}`).join('|')
  const inputFileSourcesRef = useRef(inputFileSources)
  inputFileSourcesRef.current = inputFileSources

  const changeParts = useCallback((next: ConversationInputPart[]) => {
    partsRef.current = next
    onPartsChange?.(next)
  }, [onPartsChange])

  const removePendingUpload = useCallback((upload: UploadState) => {
    cancelledUploadsRef.current.add(upload.localId)
    URL.revokeObjectURL(upload.previewUrl)
    if (upload.media) void conversationInputApi.deletePendingImage(upload.media.media_id).catch(() => undefined)
  }, [])

  const uploadImage = useCallback(async (file: File, retryLocalId?: string) => {
    if (!ConversationImageMediaTypeSchema.options.includes(file.type as never)) return
    if (partsRef.current.filter(part => part.kind === 'image').length >= CONVERSATION_MAX_IMAGES && !retryLocalId) {
      setFileError(`You can attach up to ${CONVERSATION_MAX_IMAGES} images.`)
      return
    }
    const localId = retryLocalId ?? crypto.randomUUID()
    cancelledUploadsRef.current.delete(localId)
    const current = uploadsRef.current.find(upload => upload.localId === localId)
    const previewUrl = current?.previewUrl ?? URL.createObjectURL(file)
    setUploads(items => {
      const next: UploadState = { localId, file, previewUrl, progress: 0 }
      return items.some(item => item.localId === localId)
        ? items.map(item => item.localId === localId ? next : item)
        : [...items, next]
    })
    try {
      const media = await conversationInputApi.uploadImage(file, progress => {
        if (cancelledUploadsRef.current.has(localId)) return
        setUploads(items => items.map(item => item.localId === localId ? { ...item, progress } : item))
      })
      if (cancelledUploadsRef.current.has(localId)) {
        void conversationInputApi.deletePendingImage(media.media_id).catch(() => undefined)
        return
      }
      const part: ConversationInputImagePart = {
        kind: 'image',
        media_id: media.media_id,
        filename: media.filename,
        media_type: media.media_type,
        byte_size: media.byte_size,
        sha256: media.sha256,
      }
      setUploads(items => items.map(item => item.localId === localId
        ? { ...item, media: part, progress: 100, error: undefined }
        : item))
      changeParts([...partsRef.current, part])
    } catch (error) {
      if (cancelledUploadsRef.current.has(localId)) return
      setUploads(items => items.map(item => item.localId === localId
        ? { ...item, error: errMsg(error), progress: 0 }
        : item))
    }
  }, [changeParts])

  const receiveImages = useCallback((files: File[]) => {
    const images = files.filter(file => ConversationImageMediaTypeSchema.options.includes(file.type as never))
    if (files.some(file => file.type.startsWith('image/') && !ConversationImageMediaTypeSchema.options.includes(file.type as never))) {
      setFileError('Only PNG, JPEG, and WebP images are supported.')
    }
    if (images.length === 0) return
    void Promise.all(images.map(file => uploadImage(file)))
  }, [uploadImage])

  const onPaste = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files)
    if (files.some(file => file.type.startsWith('image/'))) {
      event.preventDefault()
      receiveImages(files)
    }
  }, [receiveImages])

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (Array.from(event.dataTransfer.types).includes('Files')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setDragging(true)
    }
  }, [])

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    receiveImages(Array.from(event.dataTransfer.files))
  }, [receiveImages])

  const onDragLeave = useCallback(() => setDragging(false), [])

  useEffect(() => {
    setFileTrees([])
    setSearchCandidates(null)
    setFileMenuOpen(false)
    setFileQuery('')
    setFileError(null)
  }, [inputFileSourceKey, projectId])

  const loadFiles = useCallback(async () => {
    if (!projectId || inputFileSourcesRef.current.length === 0) return
    fileSearchControllerRef.current?.abort()
    const controller = new AbortController()
    fileSearchControllerRef.current = controller
    setFileLoading(true)
    setFileError(null)
    try {
      if (sessionId) {
        const response = await conversationInputApi.searchFiles(sessionId, fileQuery, controller.signal)
        if (controller.signal.aborted) return
        setSearchCandidates(response.items.map(item => ({
          projectFolderId: item.project_folder_id,
          workspaceLocationId: item.workspace_location_id,
          source: item.source,
          path: item.relative_path,
          name: item.display_name,
          size: item.size_bytes,
        })))
        return
      }
      const loaded = await Promise.all(inputFileSourcesRef.current.map(async source => {
        const tree = await projectFoldersApi.tree(projectId, source.projectFolderId)
        if (source.workspaceLocationId) return { source: source as ConversationInputFileSource & { workspaceLocationId: string }, tree }
        const locations = await projectFoldersApi.locations(projectId, source.projectFolderId)
        const location = locations.find(candidate => candidate.status === 'active' && candidate.execution_ready !== false)
          ?? locations.find(candidate => candidate.status === 'active')
        if (!location) return null
        return { source: { ...source, workspaceLocationId: location.id }, tree }
      }))
      const usable = loaded.filter((item): item is { source: ConversationInputFileSource & { workspaceLocationId: string }; tree: FileNode } => item !== null)
      if (controller.signal.aborted) return
      setFileTrees(usable)
      if (usable.length !== loaded.length) setFileError('One or more Folder Locations are unavailable.')
    } catch (error) {
      if (controller.signal.aborted) return
      setSearchCandidates(null)
      setFileTrees([])
      setFileError(`Files are unavailable: ${errMsg(error)}`)
    } finally {
      if (fileSearchControllerRef.current === controller) setFileLoading(false)
    }
  }, [fileQuery, projectId, sessionId])

  useEffect(() => {
    if (fileMenuOpen && sessionId) void loadFiles()
  }, [fileMenuOpen, fileQuery, loadFiles, sessionId])

  useEffect(() => () => fileSearchControllerRef.current?.abort(), [])

  const openFileMenu = useCallback(() => {
    if (disabled || !projectId || inputFileSources.length === 0) return
    setFileMenuOpen(open => !open)
    setFileError(null)
    if (!sessionId && fileTrees.length === 0) void loadFiles()
  }, [disabled, fileTrees.length, inputFileSources.length, loadFiles, projectId, sessionId])

  const candidates = useMemo(() => {
    const query = fileQuery.trim().toLowerCase()
    return (searchCandidates ?? fileTrees.flatMap(({ source, tree }) => flattenFileTree(tree, source)))
      .filter(file => !query || file.path.toLowerCase().includes(query) || file.name.toLowerCase().includes(query))
      .slice(0, 12)
  }, [fileQuery, fileTrees, searchCandidates])

  const addFile = useCallback(async (candidate: FileCandidate) => {
    if (!projectId) {
      setFileError('Files require a Project execution context.')
      return
    }
    if (partsRef.current.filter(part => part.kind === 'file_reference').length >= CONVERSATION_MAX_FILE_REFERENCES) {
      setFileError(`You can reference up to ${CONVERSATION_MAX_FILE_REFERENCES} files.`)
      return
    }
    if (candidate.size > CONVERSATION_MAX_FILE_SNAPSHOT_BYTES) {
      setFileError(`${candidate.path} is too large to reference (max ${formatBytes(CONVERSATION_MAX_FILE_SNAPSHOT_BYTES)}).`)
      return
    }
    setFileLoadingPath(candidate.path)
    setFileError(null)
    try {
      const content = await projectFoldersApi.file(projectId, candidate.projectFolderId, candidate.path)
      const bytes = new TextEncoder().encode(content.content)
      if (bytes.byteLength > CONVERSATION_MAX_FILE_SNAPSHOT_BYTES) {
        throw new Error(`file is too large to reference (max ${formatBytes(CONVERSATION_MAX_FILE_SNAPSHOT_BYTES)})`)
      }
      const sha256 = content.sha256 ?? await digestHex(bytes)
      const part: ConversationInputFileReferencePart = {
        kind: 'file_reference',
        project_folder_id: candidate.projectFolderId,
        workspace_location_id: candidate.workspaceLocationId,
        relative_path: content.path,
        display_name: candidate.name,
        media_type: 'text/plain',
        byte_size: bytes.byteLength,
        sha256,
      }
      changeParts([...partsRef.current, part])
      setFileMenuOpen(false)
      setFileQuery('')
    } catch (error) {
      setFileError(`Could not reference ${candidate.path}: ${errMsg(error)}`)
    } finally {
      setFileLoadingPath(null)
    }
  }, [changeParts, projectId])

  const discardUpload = useCallback((upload: UploadState) => {
    removePendingUpload(upload)
    setUploads(items => items.filter(item => item.localId !== upload.localId))
    if (upload.media) {
      changeParts(partsRef.current.filter(part => part.kind !== 'image' || part.media_id !== upload.media?.media_id))
    }
  }, [changeParts, removePendingUpload])

  const removePart = useCallback((part: ConversationInputPart) => {
    if (part.kind === 'image') {
      const upload = uploadsRef.current.find(item => item.media?.media_id === part.media_id)
      if (upload) {
        discardUpload(upload)
        return
      }
    }
    changeParts(partsRef.current.filter(candidate => candidate !== part && !samePart(candidate, part)))
  }, [changeParts, discardUpload])

  useEffect(() => {
    if (resetToken === 0) return
    const previous = uploadsRef.current
    setUploads([])
    changeParts([])
    previous.forEach(removePendingUpload)
  }, [changeParts, removePendingUpload, resetToken])

  useEffect(() => () => {
    uploadsRef.current.forEach(removePendingUpload)
  }, [removePendingUpload])

  const unresolved = uploads.some(upload => !upload.media || Boolean(upload.error))
  return {
    parts,
    unresolved,
    references: (
      <ConversationInputReferences
        parts={parts}
        onRemove={removePart}
      />
    ),
    attachments: (
      <ConversationInputAttachments
        parts={parts}
        uploads={uploads}
        dragging={dragging}
        onRemove={removePart}
        onRemoveUpload={discardUpload}
        onRetry={upload => void uploadImage(upload.file, upload.localId)}
      />
    ),
    controls: (
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="sr-only"
          aria-label="Choose images"
          disabled={disabled}
          onChange={event => {
            receiveImages(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Attach image" title="Attach image" disabled={disabled} onClick={() => inputRef.current?.click()}>
          <ImagePlus className="size-4" />
        </Button>
        <div className="relative">
          <Button
            type="button"
            size="icon-sm"
            variant={fileMenuOpen ? 'secondary' : 'ghost'}
            aria-label="Reference file"
            title={inputFileSources.length > 0 ? 'Reference a file from the execution context' : 'Files require a Project Folder'}
            disabled={disabled || !projectId || inputFileSources.length === 0}
            onClick={openFileMenu}
          >
            <Paperclip className="size-4" />
          </Button>
          {fileMenuOpen && (
            <div className="absolute bottom-full left-0 z-30 mb-2 w-80 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium">Reference a file from execution context</span>
                <button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close file picker" onClick={() => setFileMenuOpen(false)}><X className="size-3.5" /></button>
              </div>
              <label className="relative block">
                <Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" />
                <Input autoFocus value={fileQuery} onChange={event => setFileQuery(event.target.value)} placeholder="Search authorized files…" className="h-8 pl-7 text-xs" aria-label="Search files" />
              </label>
              {fileLoading && <p className="flex items-center gap-1.5 px-2 py-3 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading Project Files…</p>}
              {!fileLoading && candidates.length === 0 && !fileError && <p className="px-2 py-3 text-xs text-muted-foreground">No matching files.</p>}
              {!fileLoading && candidates.length > 0 && (
                <div role="listbox" aria-label="Files" className="mt-2 max-h-56 overflow-auto">
                  {candidates.map(candidate => (
                    <button
                      key={candidate.path}
                      type="button"
                      role="option"
                      disabled={fileLoadingPath !== null || candidate.size > CONVERSATION_MAX_FILE_SNAPSHOT_BYTES}
                      onClick={() => void addFile(candidate)}
                      className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-50"
                    >
                      {fileLoadingPath === candidate.path ? <Loader2 className="mt-0.5 size-3.5 animate-spin" /> : <FileText className="mt-0.5 size-3.5 shrink-0" />}
                      <span className="min-w-0 flex-1"><span className="block truncate">{candidate.name}</span><span className="block truncate text-muted-foreground">{candidate.source} · {candidate.path} · {formatBytes(candidate.size)}</span></span>
                    </button>
                  ))}
                </div>
              )}
              {fileError && <p className="mt-2 text-xs text-destructive" role="alert">{fileError}</p>}
            </div>
          )}
        </div>
      </div>
    ),
    onPaste,
    onDragOver,
    onDrop,
    onDragLeave,
  }
}

function ConversationInputAttachments({
  parts,
  uploads,
  dragging,
  onRemove,
  onRemoveUpload,
  onRetry,
}: {
  parts: ConversationInputPart[]
  uploads: UploadState[]
  dragging: boolean
  onRemove: (part: ConversationInputPart) => void
  onRemoveUpload: (upload: UploadState) => void
  onRetry: (upload: UploadState) => void
}) {
  const imageParts = parts.filter((part): part is ConversationInputImagePart => part.kind === 'image')
  if (imageParts.length === 0 && uploads.length === 0 && !dragging) return null
  return (
    <div className={`flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 ${dragging ? 'bg-accent/50' : 'bg-muted/20'}`} aria-label="Image inputs">
      {dragging && <span className="w-full text-xs text-muted-foreground">Drop images to upload</span>}
      {imageParts.map(part => {
        const upload = uploads.find(item => item.media?.media_id === part.media_id)
        return <ImageAttachment key={part.media_id} part={part} upload={upload} onRemove={() => onRemove(part)} />
      })}
      {uploads.filter(upload => !upload.media).map(upload => (
        <div key={upload.localId} className="relative flex w-36 flex-col gap-1 rounded-md border border-border bg-background p-1.5" data-testid="image-upload">
          <img src={upload.previewUrl} alt={upload.file.name} className="h-24 w-full rounded bg-muted/40 object-contain opacity-70" />
          <button type="button" aria-label={`Remove ${upload.file.name}`} className="absolute right-1 top-1 rounded-full bg-background/90 p-0.5 text-muted-foreground shadow hover:text-foreground" onClick={() => onRemoveUpload(upload)}><X className="size-3" /></button>
          {upload.error ? (
            <>
              <span className="truncate text-[10px] text-destructive" title={upload.error}>Upload failed</span>
              <button type="button" className="text-left text-[10px] text-accent-foreground underline" onClick={() => onRetry(upload)}>Retry upload</button>
            </>
          ) : <progress value={upload.progress} max="100" className="h-1 w-full" aria-label={`Uploading ${upload.file.name}`} />}
        </div>
      ))}
    </div>
  )
}

function ConversationInputReferences({ parts, onRemove }: {
  parts: ConversationInputPart[]
  onRemove: (part: ConversationInputPart) => void
}) {
  const references = parts.filter((part): part is ConversationInputFileReferencePart => part.kind === 'file_reference')
  if (references.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2" aria-label="Referenced files">
      {references.map(part => (
        <div key={`${part.project_folder_id}:${part.relative_path}`} className="flex max-w-64 items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 text-xs" title={`Referenced file: ${part.relative_path}`}>
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{part.relative_path}</span>
          <button type="button" aria-label={`Remove ${part.display_name}`} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => onRemove(part)}><X className="size-3.5" /></button>
        </div>
      ))}
    </div>
  )
}

function ImageAttachment({ part, upload, onRemove }: { part: ConversationInputImagePart; upload?: UploadState; onRemove?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative w-36 rounded-md border border-border bg-background p-1.5">
      <button type="button" className="block w-full rounded focus:outline-none focus:ring-1 focus:ring-ring" aria-label={`Preview ${part.filename}`} onClick={() => setOpen(true)}>
        {upload ? <img src={upload.previewUrl} alt={part.filename} className="h-24 w-full rounded bg-muted/40 object-contain" /> : <AuthenticatedImage mediaId={part.media_id} alt={part.filename} className="h-24 w-full rounded bg-muted/40 object-contain" />}
      </button>
      <span className="mt-1 block truncate text-[10px]" title={part.filename}>{part.filename}</span>
      {onRemove && <button type="button" aria-label={`Remove ${part.filename}`} className="absolute right-1 top-1 rounded-full bg-background/90 p-0.5 text-muted-foreground shadow hover:text-foreground" onClick={onRemove}><X className="size-3" /></button>}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" role="dialog" aria-modal="true" aria-label={`Preview ${part.filename}`} onClick={() => setOpen(false)}>
          <div className="relative max-h-full max-w-4xl rounded-lg bg-background p-2" onClick={event => event.stopPropagation()}>
            {upload ? <img src={upload.previewUrl} alt={part.filename} className="max-h-[80vh] max-w-full object-contain" /> : <AuthenticatedImage mediaId={part.media_id} alt={part.filename} className="max-h-[80vh] max-w-full object-contain" />}
            <button type="button" className="absolute right-3 top-3 rounded-full bg-background/90 p-1" aria-label="Close image preview" onClick={() => setOpen(false)}><X className="size-4" /></button>
          </div>
        </div>
      )}
    </div>
  )
}

export function ConversationInputPartsView({ parts }: { parts?: ConversationInputPart[] }) {
  if (!parts?.length) return null
  return (
    <div className="mt-1 flex min-w-0 max-w-full flex-wrap gap-2" aria-label="Message inputs">
      {parts.filter((part): part is ConversationInputImagePart => part.kind === 'image').map(part => <ImageAttachment key={part.media_id} part={part} />)}
      {parts.filter((part): part is ConversationInputFileReferencePart => part.kind === 'file_reference').map(part => (
        <div key={`${part.project_folder_id}:${part.relative_path}`} className="flex items-center gap-1.5 rounded-md border border-border bg-background/70 px-2 py-1.5 text-xs" title={`Referenced file: ${part.relative_path}`} aria-label={`Referenced file ${part.relative_path}`}>
          <FileText className="size-3.5 text-muted-foreground" /> <span className="max-w-56 truncate">{part.relative_path}</span>
        </div>
      ))}
    </div>
  )
}

function AuthenticatedImage({ mediaId, alt, className }: { mediaId: string; alt: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    setSrc(null)
    setError(false)
    void conversationInputApi.imageBlob(mediaId).then(blob => {
      if (!active) return
      objectUrl = URL.createObjectURL(blob)
      setSrc(objectUrl)
    }).catch(() => {
      if (active) setError(true)
    })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [mediaId])
  if (error) return <div role="img" aria-label={`${alt} unavailable`} className={`${className ?? ''} flex items-center justify-center bg-muted/40 px-2 text-center text-[10px] text-muted-foreground`}>Image unavailable</div>
  if (!src) return <div className={`${className ?? ''} flex items-center justify-center bg-muted/40`}><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
  return <img src={src} alt={alt} className={className} />
}

function flattenFileTree(root: FileNode | null, source: ConversationInputFileSource & { workspaceLocationId: string }): FileCandidate[] {
  if (!root) return []
  const files: FileCandidate[] = []
  const visit = (node: FileNode) => {
    if (files.length >= 200) return
    if (node.type === 'file' && node.path !== '.') files.push({
      projectFolderId: source.projectFolderId,
      workspaceLocationId: source.workspaceLocationId,
      source: source.label,
      path: node.path,
      name: node.name,
      size: node.size ?? 0,
    })
    node.children?.forEach(visit)
  }
  visit(root)
  return files
}

function samePart(a: ConversationInputPart, b: ConversationInputPart): boolean {
  return a.kind === b.kind && (a.kind === 'image' ? a.media_id === (b.kind === 'image' ? b.media_id : '') : a.project_folder_id === (b.kind === 'file_reference' ? b.project_folder_id : '') && a.relative_path === (b.kind === 'file_reference' ? b.relative_path : ''))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
