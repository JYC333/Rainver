import { mergeAbortSignals } from "../../lib/mergeAbortSignals"
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { RunFilePreviewSchema, rasterImageMime, PREVIEW_MAX_BYTES, type RunFilePreview } from '@rainver/protocol'
import { runsApi } from '../../api/client'
import { MarkdownFileContext } from '../../components/ai-elements/markdownFileContext'
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog'
import { Button } from '../../components/ui/button'
import { spacePath } from '../../core/navigation'
import { useConversationScope } from './ConversationScope'
import { useAppTranslation } from '../../i18n'

type Preview = Exclude<RunFilePreview, { kind: 'workspace' }>

/** A click reads through the source Run and Space, never the URL's active Space. */
export function ConversationFilePreview({ runId, children }: { runId: string; children: ReactNode }) {
  const scope = useConversationScope()
  const navigate = useNavigate()
  const { t } = useAppTranslation()
  const [path, setPath] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [runId, scope.spaceId])
  useEffect(() => {
    if (preview?.kind !== 'image') { setImageUrl(null); return }
    try {
      if (preview.content_base64.length > Math.ceil(PREVIEW_MAX_BYTES / 3) * 4) throw new Error('oversize')
      const bytes = Uint8Array.from(atob(preview.content_base64), c => c.charCodeAt(0))
      if (rasterImageMime(bytes) !== preview.mime_type) throw new Error('unsupported')
      const url = URL.createObjectURL(new Blob([bytes], { type: preview.mime_type }))
      setImageUrl(url)
      return () => URL.revokeObjectURL(url)
    } catch { setError(true); setImageUrl(null) }
  }, [preview])
  const open = useCallback((source: string) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setPath(source); setPreview(null); setError(false)
    const signal = mergeAbortSignals(scope.signal, controller.signal)!
    void runsApi.filePreview(runId, source, { ...scope, signal }).then(data => {
      if (signal.aborted) return
      const value = RunFilePreviewSchema.parse(data)
      if (value.kind === 'workspace') {
        const query = new URLSearchParams({ folder: value.folder_id, path: value.path, ...(value.line ? { line: String(value.line) } : {}) })
        const target = `/projects/${encodeURIComponent(value.project_id)}/files?${query}`
        setPath(null)
        navigate(scope.spaceId ? spacePath(scope.spaceId, target) : target)
      } else setPreview(value)
    }).catch(() => { if (!signal.aborted) setError(true) })
  }, [runId, scope, navigate])
  return <MarkdownFileContext.Provider value={open}>
    {children}
    <Dialog open={path !== null && (preview !== null || error)} onOpenChange={value => { if (!value) { request.current?.abort(); setPath(null); setPreview(null); setError(false) } }}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[90dvh] w-[95vw] max-w-5xl flex-col overflow-hidden">
        <DialogTitle className="truncate pr-6">{preview?.name ?? t('file_preview.title')}</DialogTitle>
        {error ? <div role="alert" className="space-y-3"><p>{t('file_preview.unavailable')}</p><Button variant="outline" onClick={() => path && open(path)}>{t('file_preview.retry')}</Button></div>
          : preview?.kind === 'image' && imageUrl ? <img src={imageUrl} alt={preview.name} className="min-h-0 max-h-[75dvh] max-w-full object-contain" onError={() => setError(true)} />
          : preview?.kind === 'text' ? <pre className="overflow-auto whitespace-pre-wrap break-words text-sm">{preview.content}</pre>
          : <p role="status">{t('file_preview.loading')}</p>}
      </DialogContent>
    </Dialog>
  </MarkdownFileContext.Provider>
}
