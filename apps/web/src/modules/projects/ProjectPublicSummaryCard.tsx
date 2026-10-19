import { useCallback, useEffect, useState } from 'react'
import { Globe, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError, projectsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { ProjectPublicSummaryDraft, ProjectPublicSummaryEditorState } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { ConfirmDialog } from '../../components/ui/dialog'
import { useAppTranslation } from '../../i18n'
import { formatDateTime } from '../../i18n/format'

/**
 * The Project's space-public summary: a draft every Project writer may edit,
 * and the snapshot other Projects' members actually read, which only an
 * owner-level publish replaces and only a revoke takes down.
 *
 * The two are shown apart on purpose. Saving the draft changes nothing anyone
 * else can see, and publishing names the draft version that was reviewed —
 * the server refuses to publish a version nobody looked at.
 */
export default function ProjectPublicSummaryCard({ projectId }: { projectId: string }) {
  const { t } = useAppTranslation()
  const [state, setState] = useState<ProjectPublicSummaryEditorState | null>(null)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [summaryText, setSummaryText] = useState('')
  const [topics, setTopics] = useState('')
  const [highlights, setHighlights] = useState('')
  const [busy, setBusy] = useState<'save' | 'generate' | 'publish' | 'revoke' | null>(null)
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false)

  const applyDraft = useCallback((draft: ProjectPublicSummaryDraft | null) => {
    setSummaryText(draft?.summary_text ?? '')
    setTopics((draft?.topics ?? []).join('\n'))
    setHighlights((draft?.highlights ?? []).join('\n'))
  }, [])

  const load = useCallback(async () => {
    try {
      const next = await projectsApi.publicSummaryEditor(projectId)
      setState(next)
      applyDraft(next.draft)
      setForbidden(false)
    } catch (e) {
      // Readers who cannot write the Project have no editor: nothing to show.
      if (e instanceof ApiRequestError && e.status === 403) setForbidden(true)
      else toast.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [applyDraft, projectId])

  useEffect(() => { void load() }, [load])

  const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean)

  async function saveDraft() {
    setBusy('save')
    try {
      const draft = await projectsApi.savePublicSummaryDraft(projectId, {
        summary_text: summaryText.trim(),
        topics: lines(topics),
        highlights: lines(highlights),
      })
      setState(current => current ? { ...current, draft } : current)
      applyDraft(draft)
      toast.success(t('management_ui.public_summary.saved'))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  async function generateDraft() {
    setBusy('generate')
    try {
      const draft = await projectsApi.generatePublicSummaryDraft(projectId)
      setState(current => current ? { ...current, draft } : current)
      applyDraft(draft)
      toast.success(t('management_ui.public_summary.generated'))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  async function publish() {
    const draft = state?.draft
    if (!draft) return
    setBusy('publish')
    try {
      const published = await projectsApi.publishPublicSummary(projectId, draft.draft_version)
      setState(current => current ? { ...current, published } : current)
      toast.success(t('management_ui.public_summary.published_toast'))
    } catch (e) {
      // The draft moved on while it was being reviewed: show the current one
      // rather than publishing what was approved against a stale read.
      if (e instanceof ApiRequestError && e.code === 'project_public_summary_draft_changed') {
        toast.error(t('management_ui.public_summary.draft_changed'))
        await load()
      } else {
        toast.error(errMsg(e))
      }
    } finally {
      setBusy(null)
    }
  }

  async function revoke() {
    setBusy('revoke')
    try {
      await projectsApi.revokePublicSummary(projectId)
      setState(current => current ? { ...current, published: null } : current)
      toast.success(t('management_ui.public_summary.unpublished_toast'))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  if (loading || forbidden || !state) return null

  const draft = state.draft
  const published = state.published
  const draftDirty = draft === null
    || summaryText.trim() !== draft.summary_text
    || lines(topics).join('\n') !== draft.topics.join('\n')
    || lines(highlights).join('\n') !== draft.highlights.join('\n')
  const publishedIsCurrent = published !== null && draft !== null && published.source_draft_version === draft.draft_version

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('management_ui.public_summary.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('management_ui.public_summary.intro')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { void generateDraft() }} disabled={busy !== null}>
            <Sparkles className="size-3.5" />
            {busy === 'generate' ? t('management_ui.public_summary.generating') : t('management_ui.public_summary.generate')}
          </Button>
          <Button size="sm" onClick={() => { void saveDraft() }} disabled={busy !== null || summaryText.trim().length === 0 || !draftDirty}>
            {busy === 'save' ? t('management_ui.public_summary.saving') : t('management_ui.public_summary.save')}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-3">
          <div>
            <Label htmlFor="public-summary-text">{draft ? t('management_ui.public_summary.draft_version', { version: draft.draft_version }) : t('management_ui.public_summary.draft')}</Label>
            <Textarea
              id="public-summary-text"
              value={summaryText}
              onChange={e => setSummaryText(e.target.value)}
              rows={5}
              placeholder={t('management_ui.public_summary.placeholder')}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="public-summary-topics">{t('management_ui.public_summary.topics')}</Label>
              <Textarea id="public-summary-topics" value={topics} onChange={e => setTopics(e.target.value)} rows={3} />
            </div>
            <div>
              <Label htmlFor="public-summary-highlights">{t('management_ui.public_summary.highlights')}</Label>
              <Textarea id="public-summary-highlights" value={highlights} onChange={e => setHighlights(e.target.value)} rows={3} />
            </div>
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Globe className="size-3.5" />
              {t('management_ui.public_summary.published')}
            </p>
            {state.can_publish && (
              <div className="flex items-center gap-2">
                {published && (
                  <Button variant="outline" size="sm" onClick={() => setRevokeConfirmOpen(true)} disabled={busy !== null}>
                    {busy === 'revoke' ? t('management_ui.public_summary.unpublishing') : t('management_ui.public_summary.unpublish')}
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => { void publish() }}
                  disabled={busy !== null || draft === null || draftDirty || publishedIsCurrent}
                  title={draftDirty ? t('management_ui.public_summary.save_first') : undefined}
                >
                  {busy === 'publish' ? t('management_ui.public_summary.publishing') : published ? t('management_ui.public_summary.publish_current') : t('management_ui.public_summary.publish')}
                </Button>
              </div>
            )}
          </div>
          {published ? (
            <div className="space-y-2">
              <p className="text-sm whitespace-pre-wrap">{published.summary_text}</p>
              {published.topics.length > 0 && (
                <p className="text-xs text-muted-foreground">{t('management_ui.public_summary.topics_list', { topics: published.topics.join(', ') })}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('management_ui.public_summary.published_from', { version: published.source_draft_version, when: formatDateTime(published.published_at) })}
                {publishedIsCurrent ? '' : t('management_ui.public_summary.changed_since')}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('management_ui.public_summary.nothing_published')}
            </p>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={revokeConfirmOpen}
        onOpenChange={setRevokeConfirmOpen}
        title={t('management_ui.public_summary.confirm_title')}
        description={t('management_ui.public_summary.confirm_description')}
        confirmLabel={t('management_ui.public_summary.unpublish')}
        onConfirm={() => { void revoke() }}
      />
    </Card>
  )
}
