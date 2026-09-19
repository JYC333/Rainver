import type { ProjectFileDraft } from '../../types/api'

export const DRAFT_IDLE_MS = 1_500
export const DRAFT_MAX_MS = 10_000

export interface DraftMutationInput {
  expected_version?: number | null
  target_kind: 'existing' | 'new'
  relative_path: string
  base_exists: boolean
  base_sha256: string | null
  content: string
  content_sha256: string
  byte_size: number
  source_encoding: 'utf8' | 'utf16le' | 'utf16be'
  preserve_bom: boolean
  line_ending_mode: 'lf' | 'crlf' | 'mixed' | 'none'
}

export type DraftControllerStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict'

export interface DraftControllerSnapshot {
  status: DraftControllerStatus
  content: string
  draft: ProjectFileDraft | null
  generation: number
  acknowledgedGeneration: number
  error: unknown
}

export interface DraftControllerOptions {
  buildMutation: (content: string, draft: ProjectFileDraft | null) => Promise<Omit<DraftMutationInput, 'content' | 'content_sha256' | 'byte_size'> | null>
  save: (input: DraftMutationInput) => Promise<ProjectFileDraft>
  initialContent: string
  initialDraft?: ProjectFileDraft | null
  idleMs?: number
  maxMs?: number
  onChange?: (snapshot: DraftControllerSnapshot) => void
}

interface Waiter {
  generation: number
  resolve: () => void
  reject: (error: unknown) => void
}

/**
 * Serial, coalescing draft persistence. The editor owns document state; this
 * class owns only the acknowledgement boundary and timers so it is easy to
 * exercise with fake timers without mounting CodeMirror or React.
 */
export class ProjectFileDraftController {
  private readonly buildMutation: DraftControllerOptions['buildMutation']
  private readonly save: DraftControllerOptions['save']
  private readonly idleMs: number
  private readonly maxMs: number
  private readonly onChange?: DraftControllerOptions['onChange']
  private content: string
  private canonicalContent: string
  private draft: ProjectFileDraft | null
  private status: DraftControllerStatus
  private error: unknown = null
  private generation = 0
  private acknowledgedGeneration = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private draining = false
  private waiters: Waiter[] = []

  constructor(options: DraftControllerOptions) {
    this.buildMutation = options.buildMutation
    this.save = options.save
    this.idleMs = options.idleMs ?? DRAFT_IDLE_MS
    this.maxMs = options.maxMs ?? DRAFT_MAX_MS
    this.onChange = options.onChange
    this.content = options.initialDraft?.content ?? options.initialContent
    this.canonicalContent = options.initialContent
    this.draft = options.initialDraft ?? null
    this.status = options.initialDraft ? 'saved' : 'clean'
  }

  snapshot(): DraftControllerSnapshot {
    return {
      status: this.status,
      content: this.content,
      draft: this.draft,
      generation: this.generation,
      acknowledgedGeneration: this.acknowledgedGeneration,
      error: this.error,
    }
  }

  setContent(content: string): void {
    this.content = content
    this.generation += 1
    this.error = null
    if (content === this.canonicalContent && !this.draft) {
      this.clearTimers()
      this.acknowledgedGeneration = this.generation
      this.setStatus('clean')
      this.resolveWaiters()
      return
    }
    this.setStatus('dirty')
    this.schedule()
  }

  /** Adopt a server draft that arrived after the editor mounted. */
  hydrate(draft: ProjectFileDraft | null): boolean {
    if (this.generation !== this.acknowledgedGeneration && this.content !== this.canonicalContent) {
      this.draft = draft
      this.error = new Error('A recovery draft arrived while this tab had unsaved changes')
      this.setStatus('conflict')
      return false
    }
    this.draft = draft
    if (draft) {
      this.content = draft.content
      this.acknowledgedGeneration = this.generation
      this.setStatus('saved')
    } else {
      this.content = this.canonicalContent
      this.acknowledgedGeneration = this.generation
      this.setStatus('clean')
    }
    this.error = null
    this.clearTimers()
    this.emit()
    return true
  }

  setCanonicalContent(content: string): void {
    this.canonicalContent = content
    if (this.generation === this.acknowledgedGeneration && !this.draft) {
      this.content = content
      this.emit()
    }
  }

  /** Mark a successful Folder save as the new clean baseline. */
  commitCanonical(content: string, draft: ProjectFileDraft | null = null): void {
    this.canonicalContent = content
    this.content = draft?.content ?? content
    this.draft = draft
    this.generation += 1
    this.acknowledgedGeneration = this.generation
    this.error = null
    this.clearTimers()
    this.setStatus(draft ? 'saved' : 'clean')
  }

  async flush(): Promise<void> {
    const targetGeneration = this.generation
    if (targetGeneration <= this.acknowledgedGeneration && !this.inFlight) return
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ generation: targetGeneration, resolve, reject })
      void this.drain()
    })
  }

  destroy(): void {
    this.clearTimers()
    const error = new Error('Draft editor was closed before its changes were saved')
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  private schedule(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      void this.flush().catch(() => {})
    }, this.idleMs)
    if (!this.maxTimer) {
      this.maxTimer = setTimeout(() => {
        this.maxTimer = null
        void this.flush().catch(() => {})
      }, this.maxMs)
    }
    this.emit()
  }

  private async drain(): Promise<void> {
    if (this.inFlight || this.draining || this.generation <= this.acknowledgedGeneration) {
      this.resolveWaiters()
      return
    }
    this.draining = true
    const requestGeneration = this.generation
    try {
      const requestContent = this.content
      const draftAtRequest = this.draft
      const mutation = await this.buildMutation(requestContent, draftAtRequest)
      if (!mutation) {
        this.acknowledgedGeneration = requestGeneration
        this.setStatus('clean')
        this.resolveWaiters()
        return
      }
      this.clearTimers()
      this.setStatus('saving')
      this.inFlight = this.persist({
        ...mutation,
        content: requestContent,
        content_sha256: await sha256Utf8(requestContent),
        byte_size: new TextEncoder().encode(requestContent).byteLength,
      }, requestGeneration)
      await this.inFlight
    } finally {
      this.draining = false
      if (!this.inFlight && this.generation > this.acknowledgedGeneration && this.status !== 'error' && this.status !== 'conflict') {
        void this.drain()
      }
    }
  }

  private async persist(input: DraftMutationInput, requestGeneration: number): Promise<void> {
    try {
      const draft = await this.save(input)
      this.draft = draft
      this.acknowledgedGeneration = requestGeneration
      this.error = null
      this.setStatus(this.generation > requestGeneration ? 'dirty' : 'saved')
      this.inFlight = null
      this.resolveWaiters()
      if (this.generation > requestGeneration) this.schedule()
    } catch (error) {
      this.inFlight = null
      this.error = error
      this.setStatus(isConflictError(error) ? 'conflict' : 'error')
      for (const waiter of this.waiters.splice(0)) {
        if (waiter.generation <= requestGeneration) waiter.reject(error)
        else this.waiters.push(waiter)
      }
    }
  }

  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.idleTimer = null
    this.maxTimer = null
  }

  private resolveWaiters(): void {
    const ready = this.waiters.filter(waiter => waiter.generation <= this.acknowledgedGeneration)
    this.waiters = this.waiters.filter(waiter => waiter.generation > this.acknowledgedGeneration)
    for (const waiter of ready) waiter.resolve()
  }

  private setStatus(status: DraftControllerStatus): void {
    this.status = status
    this.emit()
  }

  private emit(): void {
    this.onChange?.(this.snapshot())
  }
}

export function isConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; payload?: { code?: unknown } }
  return value.code === 'draft_version_conflict'
    || value.code === 'host_file_conflict'
    || value.payload?.code === 'draft_version_conflict'
    || value.payload?.code === 'host_file_conflict'
}

export async function sha256Utf8(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
