import { useEffect, useRef, useState } from 'react'
import { NotebookPen, X } from 'lucide-react'
import { toast } from 'sonner'
import { notesApi } from '../../../api/client'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { Button } from '../../../components/ui/button'
import { Textarea } from '../../../components/ui/textarea'
import { errMsg } from '../../../lib/utils'
import { useProjectCaptureTarget } from './projectCaptureTarget'

/**
 * Capture, reachable from every Project Area (U2/U11).
 *
 * Capture and workspace are deliberately separate. The Project's notes surface
 * is where writing happens; this is for the thought that arrives while doing
 * something else, where opening a page is enough friction to lose it. So it is
 * a floating affordance over whatever Area is open, not a navigation.
 *
 * Where it lands follows U11: with a context object one note per object,
 * without one the Project's `inbox` note. The user is told which before typing,
 * because "where did that go" is the failure mode a capture box has.
 */
export function ProjectQuickCapture({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [captured, setCaptured] = useState<{ id: string; title: string } | null>(null)
  const target = useProjectCaptureTarget()
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  async function capture() {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      const note = await notesApi.jot({
        text: body,
        project_id: projectId,
        ...(target ? { target_id: target.objectId } : {}),
      })
      setText('')
      setCaptured({ id: note.id, title: note.title })
      setOpen(false)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* Sits above the Area's own content but below dialogs. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-30 flex flex-col items-end gap-2">
        {captured && !open && (
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
            <span className="text-muted-foreground">Captured to</span>
            <Link to={`/projects/${projectId}/notes/${captured.id}`} className="font-medium hover:underline">
              {captured.title}
            </Link>
            <button
              type="button"
              onClick={() => setCaptured(null)}
              aria-label="Dismiss capture confirmation"
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        )}

        {open ? (
          <div className="pointer-events-auto w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-3 shadow-xl">
            <div className="mb-2 flex items-start justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {target
                  ? <>Goes to the note about <span className="font-medium text-foreground">{target.title}</span>.</>
                  : <>Goes to this project's inbox note.</>}
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close capture"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <Textarea
              ref={inputRef}
              value={text}
              onChange={event => setText(event.target.value)}
              onKeyDown={event => {
                // Enter sends; Shift+Enter is a newline. A capture box that
                // needs a mouse to submit is a capture box people stop using.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void capture()
                }
              }}
              placeholder="What just occurred to you?"
              aria-label="Capture a note"
              className="min-h-[5rem]"
            />
            <div className="mt-2 flex justify-end">
              <Button size="sm" disabled={!text.trim() || busy} onClick={() => void capture()}>
                {busy ? 'Capturing…' : 'Capture'}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            className="pointer-events-auto shadow-lg"
            size="sm"
            onClick={() => setOpen(true)}
            aria-label="Capture a note"
            title="Capture a note"
          >
            <NotebookPen className="size-4" /> Capture
          </Button>
        )}
      </div>
    </>
  )
}
