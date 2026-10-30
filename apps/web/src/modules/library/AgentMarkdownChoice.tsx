import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ApiRequestError, sourcesApi } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { useAppTranslation } from '../../i18n'
import { sessionEpoch } from '../../lib/sessionResidue'
import { errMsg } from '../../lib/utils'

/**
 * For Agent text shown literally — its syntax undeclared, or declared plain —
 * the person may have this one version read as Markdown. Plain stays the
 * default and nothing changes by itself; the choice is explicit and confirmed.
 * The request names the version shown (`shown`); the server refuses if the text
 * changed meanwhile, saves a new version and keeps the current one.
 *
 * Replies belong to the run that asked: one owner token per mounted version,
 * dropped on unmount or version change, plus the session epoch, so a reply
 * after leaving, after A→B→A, or after logout changes no state, shows no
 * message and starts no reload.
 */
export function AgentMarkdownChoice({ itemId, spaceId, syntax, shown, reload }: {
  itemId: string
  spaceId: string
  syntax: 'undeclared' | 'plain'
  shown: { artifact_id: string; source_snapshot_id: string | null }
  /** Reloads the document (the page's own request ownership, see LibraryItemReaderPage); throws on an ordinary failure. */
  reload: () => Promise<'shown' | 'superseded' | 'denied'>
}) {
  const { t } = useAppTranslation()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const owner = useRef<object | null>(null)
  const versionKey = `${spaceId}:${itemId}:${shown.artifact_id}:${shown.source_snapshot_id ?? ''}`
  useEffect(() => {
    const token = {}
    owner.current = token
    setBusy(false); setConfirming(false)
    return () => { if (owner.current === token) owner.current = null }
  }, [versionKey])

  async function show() {
    const run = owner.current
    const epoch = sessionEpoch()
    const live = () => run !== null && owner.current === run && sessionEpoch() === epoch
    setBusy(true)
    try {
      await sourcesApi.showAgentTextAsMarkdown(itemId, shown, { spaceId })
      if (!live()) return
      setConfirming(false)
      let outcome: 'shown' | 'superseded' | 'denied'
      try {
        outcome = await reload()
      } catch {
        // Saved, but the new version could not be loaded: say so, not "failed".
        if (live()) toast.error(t('reading.markdownShownReloadFailed'))
        return
      }
      // Success is said only when the page, still current, shows the new version.
      // That version replaces this choice (it unmounts), so the page's word is what counts.
      if (outcome === 'shown') toast.success(t('reading.markdownShown'))
    } catch (error) {
      if (!live()) return
      if (error instanceof ApiRequestError && error.status === 409 && error.code === 'reading_version_changed') {
        // The text changed since it was shown: show the current one; the person decides again.
        setConfirming(false)
        toast.error(t('reading.markdownVersionChanged'))
        await reload()
        return
      }
      toast.error(errMsg(error))
    } finally {
      if (live()) setBusy(false)
    }
  }

  return <div className="space-y-2">
    <p className="text-muted-foreground">{t(syntax === 'plain' ? 'reading.agentSyntaxPlain' : 'reading.agentSyntaxUndeclared')}</p>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>{t('reading.showAsMarkdown')}</Button>
    <Dialog open={confirming} onOpenChange={open => { if (!busy) setConfirming(open) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('reading.showAsMarkdownTitle')}</DialogTitle>
          <DialogDescription>{t('reading.showAsMarkdownImpact')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{t('reading.showAsMarkdownKeep')}</Button>
          <Button disabled={busy} onClick={() => void show()}>{t('reading.showAsMarkdownConfirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
